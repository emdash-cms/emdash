/**
 * Verify GitHub webhook HMAC-SHA256 signature.
 */
export async function verifyGitHubSignature(
	body: string,
	signature: string | null,
	secret: string,
): Promise<boolean> {
	if (!signature?.startsWith("sha256=")) return false;

	const encoder = new TextEncoder();
	const key = await crypto.subtle.importKey(
		"raw",
		encoder.encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["verify"],
	);

	const sigBytes = hexToBytes(signature.slice("sha256=".length));
	return crypto.subtle.verify("HMAC", key, sigBytes, encoder.encode(body));
}

/**
 * Build the GitHub OAuth authorization URL.
 */
export function githubAuthUrl(env: Env, state: string): string {
	const params = new URLSearchParams({
		client_id: env.GITHUB_CLIENT_ID,
		redirect_uri: `${env.PUBLIC_URL}/callback/github`,
		state,
		scope: "", // no scope needed, just identity
	});
	return `https://github.com/login/oauth/authorize?${params.toString()}`;
}

/**
 * Exchange a GitHub OAuth code for an access token, then fetch the user.
 */
export async function exchangeGitHubCode(
	env: Env,
	code: string,
): Promise<{ login: string; id: number } | null> {
	const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
		method: "POST",
		headers: {
			"Content-Type": "application/x-www-form-urlencoded",
			Accept: "application/json",
		},
		body: new URLSearchParams({
			client_id: env.GITHUB_CLIENT_ID,
			client_secret: env.GITHUB_CLIENT_SECRET,
			code,
			redirect_uri: `${env.PUBLIC_URL}/callback/github`,
		}),
	});

	if (!tokenRes.ok) return null;

	const tokenData: { access_token?: string; error?: string } = await tokenRes.json();
	if (!tokenData.access_token) return null;

	const userRes = await fetch("https://api.github.com/user", {
		headers: {
			Authorization: `Bearer ${tokenData.access_token}`,
			Accept: "application/vnd.github+json",
			"User-Agent": "emdash-discord-bot",
			"X-GitHub-Api-Version": "2022-11-28",
		},
	});

	if (!userRes.ok) return null;

	const user: { login: string; id: number } = await userRes.json();
	return { login: user.login, id: user.id };
}

export async function postPullRequestComment(
	env: Env,
	prNumber: number,
	body: string,
): Promise<void> {
	const token = await mintInstallationToken(env);
	const response = await fetch(
		`https://api.github.com/repos/${env.GITHUB_REPO}/issues/${prNumber}/comments`,
		{
			method: "POST",
			headers: {
				Accept: "application/vnd.github+json",
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
				"User-Agent": "emdash-discord-bot",
				"X-GitHub-Api-Version": "2022-11-28",
			},
			body: JSON.stringify({ body }),
		},
	);

	if (!response.ok) {
		throw new Error(`GitHub comment failed with status ${response.status}`);
	}
}

const BASE64_PLUS = /\+/g;
const BASE64_SLASH = /\//g;
const BASE64_PADDING = /=+$/;
const PEM_BEGIN = /-----BEGIN [^-]+-----/g;
const PEM_END = /-----END [^-]+-----/g;
const PEM_WHITESPACE = /\s+/g;

async function mintInstallationToken(env: Env): Promise<string> {
	const jwt = await signAppJwt(env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY);
	const response = await fetch(
		`https://api.github.com/app/installations/${env.GITHUB_APP_INSTALLATION_ID}/access_tokens`,
		{
			method: "POST",
			headers: {
				Accept: "application/vnd.github+json",
				Authorization: `Bearer ${jwt}`,
				"User-Agent": "emdash-discord-bot",
				"X-GitHub-Api-Version": "2022-11-28",
			},
		},
	);
	if (!response.ok) {
		throw new Error(`GitHub installation token mint failed with status ${response.status}`);
	}
	const data: { token?: string } = await response.json();
	if (!data.token) throw new Error("GitHub installation token response had no token");
	return data.token;
}

async function signAppJwt(appId: string, privateKeyPem: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		"pkcs8",
		pemToPkcs8(privateKeyPem),
		{ name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
		false,
		["sign"],
	);
	const now = Math.floor(Date.now() / 1000);
	const header = { alg: "RS256", typ: "JWT" };
	const payload = { iat: now - 60, exp: now + 540, iss: appId };
	const signingInput = `${base64UrlFromString(JSON.stringify(header))}.${base64UrlFromString(JSON.stringify(payload))}`;
	const signature = await crypto.subtle.sign(
		"RSASSA-PKCS1-v1_5",
		key,
		new TextEncoder().encode(signingInput),
	);
	return `${signingInput}.${base64UrlFromBytes(new Uint8Array(signature))}`;
}

function base64UrlFromString(input: string): string {
	return base64UrlFromBytes(new TextEncoder().encode(input));
}

function base64UrlFromBytes(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary)
		.replace(BASE64_PLUS, "-")
		.replace(BASE64_SLASH, "_")
		.replace(BASE64_PADDING, "");
}

function pemToPkcs8(pem: string): ArrayBuffer {
	const body = pem.replace(PEM_BEGIN, "").replace(PEM_END, "").replace(PEM_WHITESPACE, "");
	const binary = atob(body);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes.buffer;
}

function hexToBytes(hex: string): Uint8Array {
	const bytes = new Uint8Array(hex.length / 2);
	for (let i = 0; i < hex.length; i += 2) {
		bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
	}
	return bytes;
}
