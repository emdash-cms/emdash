/**
 * Login/logout/whoami CLI commands
 *
 * Login uses the OAuth Device Flow (RFC 8628):
 * 1. POST /oauth/device/code → get device_code + user_code
 * 2. Display URL + code to user
 * 3. Poll POST /oauth/device/token until authorized
 * 4. Save tokens to ~/.config/emdash/auth.json
 *
 * Custom headers (--header / EMDASH_HEADERS) are sent with every request
 * and persisted to credentials so subsequent commands inherit them.
 * This supports sites behind reverse proxies like Cloudflare Access.
 */

import { defineCommand } from "citty";
import { consola } from "consola";
import pc from "picocolors";

import {
	createHeaderAwareFetch,
	getCachedAccessToken,
	isAccessRedirect,
	resolveCustomHeaders,
	runCloudflaredLogin,
} from "../../client/cf-access.js";
import {
	getCredentials,
	removeCredentials,
	resolveCredentialKey,
	saveCredentials,
} from "../credentials.js";
import { configureOutputMode } from "../output.js";

// ---------------------------------------------------------------------------
// Types for discovery + device flow responses
// ---------------------------------------------------------------------------

interface DiscoveryResponse {
	instance?: { name?: string };
	auth?: {
		mode?: string;
		methods?: {
			device_flow?: {
				device_authorization_endpoint: string;
				token_endpoint: string;
			};
			api_tokens?: boolean;
		};
	};
}

interface DeviceCodeResponse {
	device_code: string;
	user_code: string;
	verification_uri: string;
	expires_in: number;
	interval: number;
}

interface TokenResponse {
	access_token: string;
	refresh_token: string;
	token_type: string;
	expires_in: number;
	scope: string;
}

// ---------------------------------------------------------------------------
// Device Flow polling
// ---------------------------------------------------------------------------

async function pollForToken(
	tokenEndpoint: string,
	deviceCode: string,
	interval: number,
	expiresIn: number,
	fetchFn: typeof fetch,
): Promise<TokenResponse> {
	const deadline = Date.now() + expiresIn * 1000;
	let currentInterval = interval;

	while (Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, currentInterval * 1000));

		const res = await fetchFn(tokenEndpoint, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				device_code: deviceCode,
				grant_type: "urn:ietf:params:oauth:grant-type:device_code",
			}),
		});

		if (res.ok) {
			const body = (await res.json()) as { data: TokenResponse };
			return body.data;
		}

		const body = (await res.json()) as { error?: string; interval?: number };

		if (body.error === "authorization_pending") {
			// Keep polling
			continue;
		}

		if (body.error === "slow_down") {
			// Use server-provided interval, or fall back to incrementing by 5s
			currentInterval = body.interval ?? currentInterval + 5;
			continue;
		}

		if (body.error === "expired_token") {
			throw new Error("Device code expired. Please try again.");
		}

		if (body.error === "access_denied") {
			throw new Error("Authorization was denied.");
		}

		// Unknown error
		throw new Error(`Token exchange failed: ${body.error || res.statusText}`);
	}

	throw new Error("Device code expired (timeout). Please try again.");
}

// ---------------------------------------------------------------------------
// Cloudflare Access handling
// ---------------------------------------------------------------------------

/**
 * Handle a Cloudflare Access redirect during login.
 *
 * 1. Try `cloudflared access token` for a cached JWT
 * 2. Try `cloudflared access login` to do the browser flow
 * 3. If cloudflared isn't available, print instructions for service tokens
 *
 * Returns the Access JWT, or null if auth couldn't be resolved.
 */
async function handleAccessRedirect(baseUrl: string): Promise<string | null> {
	consola.info("This site is behind Cloudflare Access.");

	// Try cached token first
	const cached = await getCachedAccessToken(baseUrl);
	if (cached) {
		consola.success("Using cached Cloudflare Access token from cloudflared.");
		return cached;
	}

	// Try interactive login via cloudflared
	consola.info("Launching browser for Cloudflare Access login...");
	const loginOk = await runCloudflaredLogin(baseUrl);

	if (loginOk) {
		const token = await getCachedAccessToken(baseUrl);
		if (token) {
			consola.success("Cloudflare Access authentication successful.");
			return token;
		}
	}

	// cloudflared not available or login failed — guide the user
	console.log();
	consola.info("Could not authenticate with Cloudflare Access automatically.");
	consola.info("You have two options:");
	console.log();
	consola.info(`  ${pc.bold("Option 1:")} Install cloudflared and run:`);
	console.log(`    ${pc.cyan(`cloudflared access login ${baseUrl}`)}`);
	console.log(`    ${pc.cyan(`emdash login --url ${baseUrl}`)}`);
	console.log();
	consola.info(`  ${pc.bold("Option 2:")} Use a service token:`);
	console.log(
		`    ${pc.cyan(`emdash login --url ${baseUrl} -H "CF-Access-Client-Id: <id>" -H "CF-Access-Client-Secret: <secret>"`)}`,
	);
	console.log();

	return null;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export const loginCommand = defineCommand({
	meta: { name: "login", description: "Log in to an EmDash instance" },
	args: {
		url: {
			type: "string",
			alias: "u",
			description: "EmDash instance URL",
			default: "http://localhost:4321",
		},
		header: {
			type: "string",
			alias: "H",
			description: 'Custom header "Name: Value" (repeatable, or use EMDASH_HEADERS env)',
		},
	},
	async run({ args }) {
		const baseUrl = args.url || "http://localhost:4321";
		consola.start(`Connecting to ${baseUrl}...`);

		// Resolve custom headers from --header flags and EMDASH_HEADERS env
		const customHeaders = resolveCustomHeaders();
		let headerFetch = createHeaderAwareFetch(customHeaders);

		try {
			// Step 1: Fetch auth discovery.
			// Use redirect: "manual" to detect Cloudflare Access.
			const discoveryUrl = new URL("/_emdash/.well-known/auth", baseUrl);
			let res = await headerFetch(discoveryUrl, { redirect: "manual" });

			// Handle Cloudflare Access
			if (isAccessRedirect(res)) {
				const accessToken = await handleAccessRedirect(baseUrl);
				if (!accessToken) {
					return; // handleAccessRedirect printed instructions
				}
				// Add the Access token to our custom headers and rebuild the fetch wrapper
				customHeaders["cf-access-token"] = accessToken;
				headerFetch = createHeaderAwareFetch(customHeaders);
				res = await headerFetch(discoveryUrl);
			} else if (res.status === 301 || res.status === 302) {
				// Non-Access redirect — follow it normally
				res = await headerFetch(discoveryUrl);
			}

			if (!res.ok) {
				if (res.status === 404) {
					const isLocal = baseUrl.includes("localhost") || baseUrl.includes("127.0.0.1");
					if (isLocal) {
						consola.info("Auth discovery not available. Trying dev bypass...");
						const bypassRes = await fetch(new URL("/_emdash/api/auth/dev-bypass", baseUrl), {
							redirect: "manual",
						});
						if (bypassRes.status === 302 || bypassRes.ok) {
							consola.success("Dev bypass available. Client will authenticate automatically.");
						} else {
							consola.error("Could not authenticate. Is the dev server running?");
						}
					} else {
						consola.error("Auth discovery endpoint not found. Is this an EmDash instance?");
					}
					return;
				}
				consola.error(`Discovery failed: ${res.status} ${res.statusText}`);
				process.exit(2);
			}

			const discovery = (await res.json()) as DiscoveryResponse;
			consola.success(`Connected to ${discovery.instance?.name || "EmDash"}`);

			const deviceFlow = discovery.auth?.methods?.device_flow;

			if (!deviceFlow) {
				// No device flow available (external auth mode)
				consola.info("Device Flow is not available for this instance.");
				consola.info("Generate an API token in Settings > API Tokens");
				consola.info(`Then run: ${pc.cyan(`emdash --token <token> --url ${baseUrl}`)}`);
				return;
			}

			// Step 2: Request device code
			const codeUrl = new URL(deviceFlow.device_authorization_endpoint, baseUrl);
			const codeRes = await headerFetch(codeUrl, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"X-EmDash-Request": "1",
				},
				body: JSON.stringify({
					client_id: "emdash-cli",
					scope: "admin",
				}),
			});

			if (!codeRes.ok) {
				consola.error(`Failed to request device code: ${codeRes.status}`);
				process.exit(2);
			}

			const deviceCodeBody = (await codeRes.json()) as { data: DeviceCodeResponse };
			const deviceCode = deviceCodeBody.data;

			// Step 3: Display instructions
			console.log();
			consola.info(`Open your browser to:`);
			console.log(`  ${pc.cyan(pc.bold(deviceCode.verification_uri))}`);
			console.log();
			consola.info(`Enter code: ${pc.yellow(pc.bold(deviceCode.user_code))}`);
			console.log();

			// Try to open browser (best-effort)
			try {
				const { execFile } = await import("node:child_process");
				if (process.platform === "darwin") {
					execFile("open", [deviceCode.verification_uri]);
				} else if (process.platform === "win32") {
					execFile("cmd", ["/c", "start", "", deviceCode.verification_uri]);
				} else {
					execFile("xdg-open", [deviceCode.verification_uri]);
				}
			} catch {
				// Ignore — user can open manually
			}

			// Step 4: Poll for token
			consola.start("Waiting for authorization...");

			const tokenUrl = new URL(deviceFlow.token_endpoint, baseUrl);
			const tokenResult = await pollForToken(
				tokenUrl.toString(),
				deviceCode.device_code,
				deviceCode.interval,
				deviceCode.expires_in,
				headerFetch,
			);

			// Step 5: Fetch user info
			let userEmail = "unknown";
			let userRole = "unknown";
			try {
				const meRes = await headerFetch(new URL("/_emdash/api/auth/me", baseUrl), {
					headers: { Authorization: `Bearer ${tokenResult.access_token}` },
				});
				if (meRes.ok) {
					const meJson = (await meRes.json()) as {
						data: { email?: string; role?: number };
					};
					const me = meJson.data;
					userEmail = me.email || "unknown";
					// Map role number to name
					const roleNames: Record<number, string> = {
						10: "subscriber",
						20: "contributor",
						30: "author",
						40: "editor",
						50: "admin",
					};
					userRole = (me.role ? roleNames[me.role] : undefined) || "unknown";
				}
			} catch {
				// Non-critical
			}

			// Step 6: Save credentials (persist custom headers so subsequent commands inherit them)
			const expiresAt = new Date(Date.now() + tokenResult.expires_in * 1000).toISOString();
			const hasCustomHeaders = Object.keys(customHeaders).length > 0;
			saveCredentials(baseUrl, {
				accessToken: tokenResult.access_token,
				refreshToken: tokenResult.refresh_token,
				expiresAt,
				...(hasCustomHeaders ? { customHeaders } : {}),
				user: { email: userEmail, role: userRole },
			});

			consola.success(`Logged in as ${pc.bold(userEmail)} (${userRole})`);
			consola.info(`Token saved to ${pc.dim(resolveCredentialKey(baseUrl))}`);
		} catch (error) {
			consola.error(error instanceof Error ? error.message : "Login failed");
			process.exit(2);
		}
	},
});

export const logoutCommand = defineCommand({
	meta: { name: "logout", description: "Log out of an EmDash instance" },
	args: {
		url: {
			type: "string",
			alias: "u",
			description: "EmDash instance URL",
			default: "http://localhost:4321",
		},
	},
	async run({ args }) {
		const baseUrl = args.url || "http://localhost:4321";

		// Get stored credentials
		const cred = getCredentials(baseUrl);

		if (!cred) {
			consola.info("No stored credentials found for this instance.");
			return;
		}

		const headerFetch = createHeaderAwareFetch(cred.customHeaders ?? {});

		// Revoke tokens server-side (best-effort)
		try {
			// Revoke the refresh token (which also revokes associated access tokens)
			await headerFetch(new URL("/_emdash/api/oauth/token/revoke", baseUrl), {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ token: cred.refreshToken }),
			});
		} catch {
			// Non-critical — the local removal still works
		}

		// Remove local credentials
		removeCredentials(baseUrl);
		consola.success("Logged out successfully.");
	},
});

export const whoamiCommand = defineCommand({
	meta: {
		name: "whoami",
		description: "Show current user and auth method",
	},
	args: {
		url: {
			type: "string",
			alias: "u",
			description: "EmDash instance URL",
			default: "http://localhost:4321",
		},
		token: {
			type: "string",
			alias: "t",
			description: "Auth token",
		},
		json: {
			type: "boolean",
			description: "Output as JSON",
		},
	},
	async run({ args }) {
		configureOutputMode(args);
		const baseUrl = args.url || "http://localhost:4321";

		// Resolve token: --token flag > EMDASH_TOKEN env > stored credentials
		let token = args.token || process.env["EMDASH_TOKEN"];
		let authMethod = token ? "token" : "none";
		let storedHeaders: Record<string, string> = {};

		if (!token) {
			const cred = getCredentials(baseUrl);
			if (cred) {
				token = cred.accessToken;
				authMethod = "stored";
				storedHeaders = cred.customHeaders ?? {};

				// Check if expired
				if (new Date(cred.expiresAt) < new Date()) {
					const headerFetch = createHeaderAwareFetch(storedHeaders);
					// Try to refresh
					try {
						const refreshRes = await headerFetch(
							new URL("/_emdash/api/oauth/token/refresh", baseUrl),
							{
								method: "POST",
								headers: { "Content-Type": "application/json" },
								body: JSON.stringify({
									refresh_token: cred.refreshToken,
									grant_type: "refresh_token",
								}),
							},
						);
						if (refreshRes.ok) {
							const json = (await refreshRes.json()) as Record<string, unknown>;
							// Token endpoint wraps response in { data: ... } via apiSuccess.
							// Handle both wrapped and bare shapes for robustness.
							const refreshed = (
								json.data && typeof json.data === "object" && "access_token" in json.data
									? json.data
									: json
							) as TokenResponse;
							token = refreshed.access_token;
							saveCredentials(baseUrl, {
								...cred,
								accessToken: refreshed.access_token,
								expiresAt: new Date(Date.now() + refreshed.expires_in * 1000).toISOString(),
							});
						} else {
							consola.warn("Stored token expired and refresh failed. Run: emdash login");
							process.exit(2);
						}
					} catch {
						consola.warn("Stored token expired. Run: emdash login");
						process.exit(2);
					}
				}
			}
		}

		if (!token) {
			// Try dev bypass for local
			const isLocal = baseUrl.includes("localhost") || baseUrl.includes("127.0.0.1");
			if (isLocal) {
				authMethod = "dev-bypass";
				consola.info(`Auth method: ${pc.cyan("dev-bypass")}`);
				consola.info("No stored credentials. Client will use dev bypass for localhost.");
				return;
			}

			consola.error("Not logged in. Run: emdash login");
			process.exit(2);
		}

		const headerFetch = createHeaderAwareFetch(storedHeaders);

		try {
			const meRes = await headerFetch(new URL("/_emdash/api/auth/me", baseUrl), {
				headers: { Authorization: `Bearer ${token}` },
			});

			if (!meRes.ok) {
				if (meRes.status === 401) {
					consola.error("Token is invalid or expired. Run: emdash login");
					process.exit(1);
				}
				consola.error(`Failed to fetch user info: ${meRes.status}`);
				process.exit(1);
			}

			const raw = (await meRes.json()) as {
				data: {
					id: string;
					email: string;
					name: string | null;
					role: number;
				};
			};
			const me = raw.data;

			const roleNames: Record<number, string> = {
				10: "subscriber",
				20: "contributor",
				30: "author",
				40: "editor",
				50: "admin",
			};

			if (args.json) {
				console.log(
					JSON.stringify({
						id: me.id,
						email: me.email,
						name: me.name,
						role: roleNames[me.role] || `unknown (${me.role})`,
						authMethod,
						url: baseUrl,
					}),
				);
			} else {
				consola.info(`Email: ${pc.bold(me.email)}`);
				if (me.name) consola.info(`Name:  ${me.name}`);
				consola.info(`Role:  ${pc.cyan(roleNames[me.role] || `unknown (${me.role})`)}`);
				consola.info(`Auth:  ${pc.dim(authMethod)}`);
				consola.info(`URL:   ${pc.dim(baseUrl)}`);
			}
		} catch (error) {
			consola.error(error instanceof Error ? error.message : "Unknown error");
			process.exit(1);
		}
	},
});
