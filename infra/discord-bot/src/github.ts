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

function hexToBytes(hex: string): Uint8Array {
	const bytes = new Uint8Array(hex.length / 2);
	for (let i = 0; i < hex.length; i += 2) {
		bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
	}
	return bytes;
}
