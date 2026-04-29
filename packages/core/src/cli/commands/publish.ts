/**
 * emdash plugin publish
 *
 * Publishes a plugin tarball to the EmDash Marketplace.
 *
 * Flow:
 * 1. Resolve tarball (from --tarball path, or build via `emdash plugin bundle`)
 * 2. Read manifest.json from tarball to show summary
 * 3. Authenticate (stored credential or GitHub device flow)
 * 4. Pre-publish validation (check plugin exists, version not published)
 * 5. Upload via multipart POST
 * 6. Display audit results
 */

import { readFile, stat } from "node:fs/promises";
import { resolve, basename } from "node:path";

import { defineCommand } from "citty";
import consola from "consola";
import { createGzipDecoder, unpackTar } from "modern-tar";
import pc from "picocolors";

import { pluginManifestSchema } from "../../plugins/manifest-schema.js";
import { CAPABILITY_RENAMES, isDeprecatedCapability } from "../../plugins/types.js";
import {
	getMarketplaceCredential,
	saveMarketplaceCredential,
	removeMarketplaceCredential,
} from "../credentials.js";

const DEFAULT_REGISTRY = "https://marketplace.emdashcms.com";

// ── GitHub Device Flow ──────────────────────────────────────────

interface DeviceCodeResponse {
	device_code: string;
	user_code: string;
	verification_uri: string;
	expires_in: number;
	interval: number;
}

interface GitHubTokenResponse {
	access_token?: string;
	token_type?: string;
	error?: string;
	error_description?: string;
	interval?: number;
}

interface MarketplaceAuthResponse {
	token: string;
	author: {
		id: string;
		name: string;
		avatarUrl: string;
	};
}

interface AuthDiscovery {
	github: {
		clientId: string;
		deviceAuthorizationEndpoint: string;
		tokenEndpoint: string;
	};
	marketplace: {
		deviceTokenEndpoint: string;
	};
}

/**
 * Authenticate with the marketplace via GitHub Device Flow.
 * Returns the marketplace JWT and author info.
 */
async function authenticateViaDeviceFlow(registryUrl: string): Promise<MarketplaceAuthResponse> {
	// Step 1: Fetch auth discovery to get GitHub client_id
	consola.start("Fetching auth configuration...");
	const discoveryRes = await fetch(new URL("/api/v1/auth/discovery", registryUrl));
	if (!discoveryRes.ok) {
		throw new Error(`Marketplace unreachable: ${discoveryRes.status} ${discoveryRes.statusText}`);
	}
	const discovery = (await discoveryRes.json()) as AuthDiscovery;

	// Step 2: Request device code from GitHub
	const deviceRes = await fetch(discovery.github.deviceAuthorizationEndpoint, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Accept: "application/json",
		},
		body: JSON.stringify({
			client_id: discovery.github.clientId,
			scope: "read:user user:email",
		}),
	});

	if (!deviceRes.ok) {
		throw new Error(`GitHub device flow failed: ${deviceRes.status}`);
	}

	const deviceCode = (await deviceRes.json()) as DeviceCodeResponse;

	// Step 3: Display instructions
	console.log();
	consola.info("Open your browser to:");
	console.log(`  ${pc.cyan(pc.bold(deviceCode.verification_uri))}`);
	console.log();
	consola.info(`Enter code: ${pc.yellow(pc.bold(deviceCode.user_code))}`);
	console.log();

	// Try to open browser
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
		// User can open manually
	}

	// Step 4: Poll GitHub for access token
	consola.start("Waiting for authorization...");
	const githubToken = await pollGitHubDeviceFlow(
		discovery.github.tokenEndpoint,
		discovery.github.clientId,
		deviceCode.device_code,
		deviceCode.interval,
		deviceCode.expires_in,
	);

	// Step 5: Exchange GitHub token for marketplace JWT
	consola.start("Authenticating with marketplace...");
	const deviceTokenUrl = new URL(discovery.marketplace.deviceTokenEndpoint, registryUrl);
	const authRes = await fetch(deviceTokenUrl, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ access_token: githubToken }),
	});

	if (!authRes.ok) {
		const body = (await authRes.json().catch(() => ({}))) as { error?: string };
		throw new Error(`Marketplace auth failed: ${body.error ?? authRes.statusText}`);
	}

	return (await authRes.json()) as MarketplaceAuthResponse;
}

async function pollGitHubDeviceFlow(
	tokenEndpoint: string,
	clientId: string,
	deviceCode: string,
	interval: number,
	expiresIn: number,
): Promise<string> {
	const deadline = Date.now() + expiresIn * 1000;
	let currentInterval = interval;

	while (Date.now() < deadline) {
		await new Promise((r) => setTimeout(r, currentInterval * 1000));

		const res = await fetch(tokenEndpoint, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json",
			},
			body: JSON.stringify({
				client_id: clientId,
				device_code: deviceCode,
				grant_type: "urn:ietf:params:oauth:grant-type:device_code",
			}),
		});

		const body = (await res.json()) as GitHubTokenResponse;

		if (body.access_token) {
			return body.access_token;
		}

		if (body.error === "authorization_pending") continue;
		if (body.error === "slow_down") {
			currentInterval = body.interval ?? currentInterval + 5;
			continue;
		}
		if (body.error === "expired_token") {
			throw new Error("Device code expired. Please try again.");
		}
		if (body.error === "access_denied") {
			throw new Error("Authorization was denied.");
		}

		throw new Error(`GitHub token exchange failed: ${body.error ?? "unknown error"}`);
	}

	throw new Error("Device code expired (timeout). Please try again.");
}

// ── Tarball reading ─────────────────────────────────────────────

const manifestSummarySchema = pluginManifestSchema.pick({
	id: true,
	version: true,
	capabilities: true,
	allowedHosts: true,
});

type ManifestSummary = typeof manifestSummarySchema._zod.output;

/**
 * Read manifest.json from a tarball without fully extracting it.
 */
async function readManifestFromTarball(tarballPath: string): Promise<ManifestSummary> {
	const data = await readFile(tarballPath);
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
			controller.close();
		},
	});

	const entries = await unpackTar(stream.pipeThrough(createGzipDecoder()), {
		filter: (header) => header.name === "manifest.json",
	});

	const manifest = entries.find((e) => e.header.name === "manifest.json");
	if (!manifest?.data) {
		throw new Error("Tarball does not contain manifest.json");
	}

	const content = new TextDecoder().decode(manifest.data);
	const parsed: unknown = JSON.parse(content);
	const result = manifestSummarySchema.safeParse(parsed);
	if (!result.success) {
		throw new Error(`Invalid manifest.json: ${result.error.message}`);
	}
	return result.data;
}

// ── Audit polling helpers ───────────────────────────────────────

const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 120_000; // 2 minutes

interface VersionStatusResponse {
	version: string;
	status: string;
	audit_verdict?: string | null;
	audit_id?: string | null;
	image_audit_verdict?: string | null;
}

/**
 * Poll the version endpoint until status leaves "pending" or timeout.
 * Returns the final version data, or null on timeout.
 */
async function pollVersionStatus(
	versionUrl: string,
	token: string,
): Promise<VersionStatusResponse | null> {
	const deadline = Date.now() + POLL_TIMEOUT_MS;

	while (Date.now() < deadline) {
		await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));

		try {
			const res = await fetch(versionUrl, {
				headers: { Authorization: `Bearer ${token}` },
			});

			if (!res.ok) continue;

			const data = (await res.json()) as VersionStatusResponse;
			if (data.status !== "pending") {
				return data;
			}
		} catch {
			// Network error — retry
		}
	}

	return null;
}

function displayAuditResults(version: VersionStatusResponse): void {
	const statusColor =
		version.status === "published" ? pc.green : version.status === "flagged" ? pc.yellow : pc.red;
	consola.info(`  Status: ${statusColor(version.status)}`);

	if (version.audit_verdict) {
		const verdictColor =
			version.audit_verdict === "pass"
				? pc.green
				: version.audit_verdict === "warn"
					? pc.yellow
					: pc.red;
		consola.info(`  Audit: ${verdictColor(version.audit_verdict)}`);
	}

	if (version.image_audit_verdict) {
		const verdictColor =
			version.image_audit_verdict === "pass"
				? pc.green
				: version.image_audit_verdict === "warn"
					? pc.yellow
					: pc.red;
		consola.info(`  Image audit: ${verdictColor(version.image_audit_verdict)}`);
	}
}

function displayInlineAuditResults(
	audit: {
		verdict: string;
		riskScore: number;
		summary: string;
		findings: { category: string; severity: string; description: string }[];
	},
	imageAudit: { verdict: string } | null,
): void {
	const verdictColor =
		audit.verdict === "pass" ? pc.green : audit.verdict === "warn" ? pc.yellow : pc.red;
	consola.info(`  Audit: ${verdictColor(audit.verdict)} (risk: ${audit.riskScore}/100)`);
	if (audit.findings.length > 0) {
		for (const finding of audit.findings) {
			const icon = finding.severity === "high" ? pc.red("!") : pc.yellow("~");
			consola.info(`    ${icon} [${finding.category}] ${finding.description}`);
		}
	}

	if (imageAudit) {
		const imgColor =
			imageAudit.verdict === "pass" ? pc.green : imageAudit.verdict === "warn" ? pc.yellow : pc.red;
		consola.info(`  Image audit: ${imgColor(imageAudit.verdict)}`);
	}
}

// ── Publish command ─────────────────────────────────────────────

export const publishCommand = defineCommand({
	meta: {
		name: "publish",
		description: "Publish a plugin to the EmDash Marketplace",
	},
	args: {
		tarball: {
			type: "string",
			description: "Path to plugin tarball (default: build first via `emdash plugin bundle`)",
		},
		dir: {
			type: "string",
			description: "Plugin directory (used with --build, default: current directory)",
			default: process.cwd(),
		},
		build: {
			type: "boolean",
			description: "Build the plugin before publishing",
			default: false,
		},
		registry: {
			type: "string",
			description: "Marketplace registry URL",
			default: DEFAULT_REGISTRY,
		},
		"no-wait": {
			type: "boolean",
			description: "Exit immediately after upload without waiting for audit (useful for CI)",
			default: false,
		},
	},
	async run({ args }) {
		const registryUrl = args.registry;

		// ── Step 1: Resolve tarball ──

		let tarballPath: string;

		if (args.tarball) {
			tarballPath = resolve(args.tarball);
		} else if (args.build) {
			// Build first, then find the output tarball
			consola.start("Building plugin...");
			const pluginDir = resolve(args.dir);
			try {
				const { runCommand } = await import("citty");
				const { bundleCommand } = await import("./bundle.js");
				await runCommand(bundleCommand, {
					rawArgs: ["--dir", pluginDir],
				});
			} catch {
				consola.error("Build failed");
				process.exit(1);
			}

			// Find the tarball in dist/
			const { readdir } = await import("node:fs/promises");
			const distDir = resolve(pluginDir, "dist");
			const files = await readdir(distDir);
			const tarball = files.find((f) => f.endsWith(".tar.gz"));
			if (!tarball) {
				consola.error("Build succeeded but no .tar.gz found in dist/");
				process.exit(1);
			}
			tarballPath = resolve(distDir, tarball);
		} else {
			// Look for an existing tarball in dist/
			const pluginDir = resolve(args.dir);
			const { readdir } = await import("node:fs/promises");
			try {
				const distDir = resolve(pluginDir, "dist");
				const files = await readdir(distDir);
				const tarball = files.find((f) => f.endsWith(".tar.gz"));
				if (tarball) {
					tarballPath = resolve(distDir, tarball);
				} else {
					consola.error("No tarball found. Run `emdash plugin bundle` first or use --build.");
					process.exit(1);
				}
			} catch {
				consola.error("No dist/ directory found. Run `emdash plugin bundle` first or use --build.");
				process.exit(1);
			}
		}

		const tarballStat = await stat(tarballPath);
		const sizeKB = (tarballStat.size / 1024).toFixed(1);
		consola.info(`Tarball: ${pc.dim(tarballPath)} (${sizeKB}KB)`);

		// ── Step 2: Read manifest from tarball ──

		const manifest = await readManifestFromTarball(tarballPath);
		console.log();
		consola.info(`Plugin: ${pc.bold(`${manifest.id}@${manifest.version}`)}`);
		if (manifest.capabilities.length > 0) {
			consola.info(`Capabilities: ${manifest.capabilities.join(", ")}`);
		}
		if (manifest.allowedHosts?.length) {
			consola.info(`Allowed hosts: ${manifest.allowedHosts.join(", ")}`);
		}
		console.log();

		// ── Step 2.5: Hard-fail on deprecated capability names ──
		//
		// Refusing to publish manifests that use deprecated capability names
		// keeps the marketplace clean while the deprecation window is open.
		// The fix is mechanical and entirely in the author's hands — they
		// rename, re-bundle, and republish. Better to refuse 5 publishes
		// than ship 500 deprecated manifests. We check before authentication
		// so authors don't burn a device-flow login on a doomed publish.
		const deprecatedCaps = manifest.capabilities.filter(isDeprecatedCapability);
		if (deprecatedCaps.length > 0) {
			consola.error(
				"Plugin declares deprecated capability names. Rename them and re-bundle before publishing:",
			);
			for (const cap of deprecatedCaps) {
				const replacement = CAPABILITY_RENAMES[cap];
				consola.error(`  ${cap} → ${replacement}`);
			}
			consola.error(
				"See https://emdashcms.com/docs/plugins/capabilities for the full rename table.",
			);
			process.exit(1);
		}

		// ── Step 3: Authenticate ──
		//
		// Priority: EMDASH_MARKETPLACE_TOKEN env var > stored credential > interactive device flow.
		// The env var enables CI pipelines (including seed token auth) without interactive login.

		let token: string;
		const envToken = process.env.EMDASH_MARKETPLACE_TOKEN;
		const stored = !envToken ? getMarketplaceCredential(registryUrl) : null;

		if (envToken) {
			token = envToken;
			consola.info("Using EMDASH_MARKETPLACE_TOKEN for authentication");
		} else if (stored) {
			token = stored.token;
			consola.info(`Authenticated as ${pc.bold(stored.author?.name ?? "unknown")}`);
		} else {
			consola.info("Not logged in to marketplace. Starting GitHub authentication...");
			const result = await authenticateViaDeviceFlow(registryUrl);
			token = result.token;

			// Save for next time
			saveMarketplaceCredential(registryUrl, {
				token: result.token,
				expiresAt: new Date(Date.now() + 30 * 86400 * 1000).toISOString(), // 30 days
				author: { id: result.author.id, name: result.author.name },
			});

			consola.success(`Authenticated as ${pc.bold(result.author.name)}`);
		}

		// ── Step 4: Pre-publish validation ──

		consola.start("Checking marketplace...");

		// Check if plugin exists
		const pluginRes = await fetch(new URL(`/api/v1/plugins/${manifest.id}`, registryUrl));

		if (pluginRes.status === 404 && !envToken) {
			// Plugin doesn't exist — register it first.
			// When using env token (seed), the server auto-registers on publish.
			consola.info(`Plugin ${pc.bold(manifest.id)} not found in marketplace. Registering...`);

			const createRes = await fetch(new URL("/api/v1/plugins", registryUrl), {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${token}`,
				},
				body: JSON.stringify({
					id: manifest.id,
					name: manifest.id, // Use ID as name initially
					capabilities: manifest.capabilities,
				}),
			});

			if (!createRes.ok) {
				const body = (await createRes.json().catch(() => ({}))) as { error?: string };
				if (createRes.status === 401) {
					// Token expired — clear and retry
					removeMarketplaceCredential(registryUrl);
					consola.error(
						"Authentication expired. Please run `emdash plugin publish` again to re-authenticate.",
					);
					process.exit(1);
				}
				consola.error(`Failed to register plugin: ${body.error ?? createRes.statusText}`);
				process.exit(1);
			}

			consola.success(`Registered ${pc.bold(manifest.id)}`);
		} else if (pluginRes.status === 404 && envToken) {
			// Using env token — server handles auto-registration on publish
			consola.info(`Plugin ${pc.bold(manifest.id)} will be auto-registered on publish`);
		} else if (!pluginRes.ok) {
			consola.error(`Marketplace error: ${pluginRes.status}`);
			process.exit(1);
		}

		// ── Step 5: Upload ──

		consola.start(`Publishing ${manifest.id}@${manifest.version}...`);

		const tarballData = await readFile(tarballPath);
		const formData = new FormData();
		formData.append(
			"bundle",
			new Blob([tarballData], { type: "application/gzip" }),
			basename(tarballPath),
		);

		const uploadUrl = new URL(`/api/v1/plugins/${manifest.id}/versions`, registryUrl);
		const uploadRes = await fetch(uploadUrl, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
			},
			body: formData,
		});

		if (!uploadRes.ok && uploadRes.status !== 202) {
			const body = (await uploadRes.json().catch(() => ({}))) as {
				error?: string;
				latestVersion?: string;
				audit?: { verdict: string; summary: string; findings: unknown[] };
			};

			if (uploadRes.status === 401) {
				if (envToken) {
					consola.error("EMDASH_MARKETPLACE_TOKEN was rejected by the marketplace.");
				} else {
					removeMarketplaceCredential(registryUrl);
					consola.error("Authentication expired. Please run `emdash plugin publish` again.");
				}
				process.exit(1);
			}

			if (uploadRes.status === 409) {
				if (body.latestVersion) {
					consola.error(`Version ${manifest.version} must be greater than ${body.latestVersion}`);
				} else {
					consola.error(body.error ?? "Version conflict");
				}
				process.exit(1);
			}

			if (uploadRes.status === 422 && body.audit) {
				// Failed security audit
				consola.error("Plugin failed security audit:");
				consola.error(`  Verdict: ${pc.red(body.audit.verdict)}`);
				consola.error(`  Summary: ${body.audit.summary}`);
				process.exit(1);
			}

			consola.error(`Publish failed: ${body.error ?? uploadRes.statusText}`);
			process.exit(1);
		}

		// ── Step 6: Handle response ──

		const result = (await uploadRes.json()) as {
			version: string;
			bundleSize: number;
			checksum: string;
			publishedAt: string;
			status?: string;
			workflowId?: string;
			audit?: {
				verdict: string;
				riskScore: number;
				summary: string;
				findings: { category: string; severity: string; description: string }[];
			};
			imageAudit?: {
				verdict: string;
			} | null;
		};

		console.log();
		consola.success(`Uploaded ${pc.bold(`${manifest.id}@${result.version}`)}`);
		consola.info(`  Checksum: ${pc.dim(result.checksum)}`);
		consola.info(`  Size: ${(result.bundleSize / 1024).toFixed(1)}KB`);

		// Async audit flow (202 Accepted)
		if (uploadRes.status === 202) {
			consola.info(`  Status: ${pc.yellow("pending")} (audit running in background)`);

			if (args["no-wait"]) {
				consola.info("Skipping audit wait (--no-wait). Check status later.");
				console.log();
				return;
			}

			// Poll version endpoint for audit completion
			consola.start("Waiting for security audit to complete...");
			const versionUrl = new URL(
				`/api/v1/plugins/${manifest.id}/versions/${manifest.version}`,
				registryUrl,
			);
			const finalStatus = await pollVersionStatus(versionUrl.toString(), token);

			if (finalStatus) {
				displayAuditResults(finalStatus);
			} else {
				consola.warn("Audit did not complete within timeout. Check status later with:");
				consola.info(`  ${pc.dim(`curl ${versionUrl.toString()}`)}`);
			}
		} else {
			// Synchronous response (201 or legacy)
			if (result.audit) {
				displayInlineAuditResults(result.audit, result.imageAudit ?? null);
			}
			consola.info(`  Status: ${pc.green(result.status ?? "published")}`);
		}

		console.log();
	},
});

// ── Marketplace auth subcommands ────────────────────────────────

export const marketplaceLoginCommand = defineCommand({
	meta: {
		name: "login",
		description: "Log in to the EmDash Marketplace via GitHub",
	},
	args: {
		registry: {
			type: "string",
			description: "Marketplace registry URL",
			default: DEFAULT_REGISTRY,
		},
	},
	async run({ args }) {
		const registryUrl = args.registry;

		const existing = getMarketplaceCredential(registryUrl);
		if (existing) {
			consola.info(`Already logged in as ${pc.bold(existing.author?.name ?? "unknown")}`);
			consola.info("Use `emdash plugin logout` to log out first.");
			return;
		}

		const result = await authenticateViaDeviceFlow(registryUrl);

		saveMarketplaceCredential(registryUrl, {
			token: result.token,
			expiresAt: new Date(Date.now() + 30 * 86400 * 1000).toISOString(),
			author: { id: result.author.id, name: result.author.name },
		});

		consola.success(`Logged in as ${pc.bold(result.author.name)}`);
	},
});

export const marketplaceLogoutCommand = defineCommand({
	meta: {
		name: "logout",
		description: "Log out of the EmDash Marketplace",
	},
	args: {
		registry: {
			type: "string",
			description: "Marketplace registry URL",
			default: DEFAULT_REGISTRY,
		},
	},
	async run({ args }) {
		const removed = removeMarketplaceCredential(args.registry);
		if (removed) {
			consola.success("Logged out of marketplace.");
		} else {
			consola.info("No marketplace credentials found.");
		}
	},
});
