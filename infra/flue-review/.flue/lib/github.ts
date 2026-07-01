// GitHub App helpers, used only by trusted Worker/Durable-Object code (the
// review workflow's run()). None of this runs in the agent's container, so the
// installation token is never reachable by the model-directed shell.
//
// Auth model: a GitHub App authenticates as an installation. We mint a short
// JWT signed with the app's private key (RS256), exchange it for an
// installation access token (valid ~1h, scoped to the installation's repos and
// the app's permissions), and use that token for reads and for posting the
// review. The app needs `pull_requests: write` and `contents: read`.

import type { ReviewResult } from "./review-schema.js";

const GITHUB_API = "https://api.github.com";
const USER_AGENT = "emdash-flue-review";

export interface GitHubAppCreds {
	appId: string;
	/** PKCS#8 PEM ("BEGIN PRIVATE KEY"). Convert a GitHub PKCS#1 key with `openssl pkcs8`. */
	privateKeyPem: string;
	installationId: string;
}

/** Returns creds if all three are present, else null (dev mode: skip posting). */
export function readAppCreds(env: Env): GitHubAppCreds | null {
	const appId = env.GITHUB_APP_ID;
	const privateKeyPem = env.GITHUB_APP_PRIVATE_KEY;
	const installationId = env.GITHUB_APP_INSTALLATION_ID;
	if (!appId || !privateKeyPem || !installationId) return null;
	return { appId, privateKeyPem, installationId };
}

const BASE64_PLUS = /\+/g;
const BASE64_SLASH = /\//g;
const BASE64_PADDING = /=+$/;
const PEM_BEGIN = /-----BEGIN [^-]+-----/g;
const PEM_END = /-----END [^-]+-----/g;
const PEM_WHITESPACE = /\s+/g;

function base64UrlFromBytes(bytes: Uint8Array): string {
	let binary = "";
	for (const b of bytes) binary += String.fromCharCode(b);
	return btoa(binary)
		.replace(BASE64_PLUS, "-")
		.replace(BASE64_SLASH, "_")
		.replace(BASE64_PADDING, "");
}

function base64UrlFromString(input: string): string {
	return base64UrlFromBytes(new TextEncoder().encode(input));
}

function pemToPkcs8(pem: string): ArrayBuffer {
	const body = pem.replace(PEM_BEGIN, "").replace(PEM_END, "").replace(PEM_WHITESPACE, "");
	const binary = atob(body);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes.buffer;
}

async function signAppJwt(creds: GitHubAppCreds): Promise<string> {
	const key = await crypto.subtle.importKey(
		"pkcs8",
		pemToPkcs8(creds.privateKeyPem),
		{ name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
		false,
		["sign"],
	);
	const now = Math.floor(Date.now() / 1000);
	// iat backdated 60s for clock skew; GitHub caps exp at 10 minutes.
	const header = { alg: "RS256", typ: "JWT" };
	const payload = { iat: now - 60, exp: now + 540, iss: creds.appId };
	const signingInput = `${base64UrlFromString(JSON.stringify(header))}.${base64UrlFromString(JSON.stringify(payload))}`;
	const signature = await crypto.subtle.sign(
		"RSASSA-PKCS1-v1_5",
		key,
		new TextEncoder().encode(signingInput),
	);
	return `${signingInput}.${base64UrlFromBytes(new Uint8Array(signature))}`;
}

/** Mint a short-lived installation access token. */
export async function mintInstallationToken(creds: GitHubAppCreds): Promise<string> {
	const jwt = await signAppJwt(creds);
	const res = await fetch(`${GITHUB_API}/app/installations/${creds.installationId}/access_tokens`, {
		method: "POST",
		headers: {
			authorization: `Bearer ${jwt}`,
			accept: "application/vnd.github+json",
			"user-agent": USER_AGENT,
			"x-github-api-version": "2022-11-28",
		},
	});
	if (!res.ok) {
		throw new Error(`installation token mint failed: ${res.status} ${await res.text()}`);
	}
	const json = await res.json<{ token?: string }>();
	if (!json.token) throw new Error("installation token response had no token");
	return json.token;
}

/**
 * Fetch the PR's unified diff (the canonical base...head diff, 3-dot). Used to
 * stage the exact changed lines into the agent's workspace, since the cf-shell
 * sandbox has no `git` CLI. `token` is optional (public repos work anonymously,
 * but a token avoids low rate limits). Returns the raw diff text.
 */
export async function fetchUnifiedDiff(
	owner: string,
	repo: string,
	prNumber: number,
	token?: string,
): Promise<string> {
	const headers: Record<string, string> = {
		accept: "application/vnd.github.v3.diff",
		"user-agent": USER_AGENT,
		"x-github-api-version": "2022-11-28",
	};
	if (token) headers.authorization = `Bearer ${token}`;
	const res = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/pulls/${prNumber}`, { headers });
	if (!res.ok) {
		throw new Error(`unified diff fetch failed: ${res.status} ${await res.text()}`);
	}
	return res.text();
}

/**
 * Fetch the most recent emdashbot[bot] review body for a re-review, so the
 * agent can avoid re-flagging already-addressed findings. Returns undefined on
 * a first review or any failure (non-fatal: we just review fresh).
 */
export async function fetchPriorReview(
	token: string,
	owner: string,
	repo: string,
	prNumber: number,
): Promise<string | undefined> {
	try {
		const res = await fetch(
			`${GITHUB_API}/repos/${owner}/${repo}/pulls/${prNumber}/reviews?per_page=100`,
			{
				headers: {
					authorization: `Bearer ${token}`,
					accept: "application/vnd.github+json",
					"user-agent": USER_AGENT,
					"x-github-api-version": "2022-11-28",
				},
			},
		);
		if (!res.ok) return undefined;
		const reviews = await res.json<
			Array<{
				user?: { login?: string };
				body?: string;
				state?: string;
				submitted_at?: string;
			}>
		>();
		const ours = reviews
			.filter((r) => r.user?.login === "emdashbot[bot]" && r.body)
			.toSorted((a, b) => (a.submitted_at ?? "").localeCompare(b.submitted_at ?? ""));
		const latest = ours.at(-1);
		if (!latest) return undefined;
		return `Your previous review (state: ${latest.state ?? "unknown"}):\n\n${latest.body}`;
	} catch {
		return undefined;
	}
}

/**
 * Add an 👀 reaction to the PR to signal "review in progress". Returns the
 * reaction id (to remove later) or undefined on failure. Non-fatal: a missing
 * progress marker should never block a review.
 */
export async function addEyesReaction(
	token: string,
	owner: string,
	repo: string,
	prNumber: number,
): Promise<number | undefined> {
	try {
		const res = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/issues/${prNumber}/reactions`, {
			method: "POST",
			headers: {
				authorization: `Bearer ${token}`,
				accept: "application/vnd.github+json",
				"content-type": "application/json",
				"user-agent": USER_AGENT,
				"x-github-api-version": "2022-11-28",
			},
			body: JSON.stringify({ content: "eyes" }),
		});
		if (!res.ok) return undefined;
		const json = await res.json<{ id?: number }>();
		return json.id;
	} catch {
		return undefined;
	}
}

/** Remove a previously-added reaction (the in-progress marker). Non-fatal. */
export async function removeReaction(
	token: string,
	owner: string,
	repo: string,
	prNumber: number,
	reactionId: number,
): Promise<void> {
	try {
		await fetch(`${GITHUB_API}/repos/${owner}/${repo}/issues/${prNumber}/reactions/${reactionId}`, {
			method: "DELETE",
			headers: {
				authorization: `Bearer ${token}`,
				accept: "application/vnd.github+json",
				"user-agent": USER_AGENT,
				"x-github-api-version": "2022-11-28",
			},
		});
	} catch {
		// Best-effort cleanup; leaving a stray reaction is harmless.
	}
}

function verdictToEvent(
	verdict: ReviewResult["verdict"],
): "APPROVE" | "REQUEST_CHANGES" | "COMMENT" {
	switch (verdict) {
		case "approve":
			return "APPROVE";
		case "request_changes":
			return "REQUEST_CHANGES";
		default:
			return "COMMENT";
	}
}

function findingToComment(finding: ReviewResult["findings"][number]) {
	const label = finding.severity === "needs_fixing" ? "**[needs fixing]** " : "**[suggestion]** ";
	const base: Record<string, unknown> = {
		path: finding.path,
		line: finding.line,
		side: finding.side,
		body: label + finding.body,
	};
	if (finding.startLine && finding.startLine < finding.line) {
		base.start_line = finding.startLine;
		base.start_side = finding.side;
	}
	return base;
}

/** GitHub rejects a COMMENT review with an empty body, so we must never send one. */
const FALLBACK_SUMMARY = "Automated review completed.";

/**
 * Render findings as a markdown list. Used for the body-only fallback so that
 * when GitHub can't anchor inline comments (a finding points outside the diff),
 * the findings still reach the PR in the review body instead of being dropped.
 */
function renderFindingsMarkdown(findings: ReviewResult["findings"]): string {
	if (findings.length === 0) return "";
	const lines = findings.map((f) => {
		const label = f.severity === "needs_fixing" ? "needs fixing" : "suggestion";
		const range = f.startLine && f.startLine < f.line ? `${f.startLine}-${f.line}` : `${f.line}`;
		return `- **[${label}]** \`${f.path}:${range}\`\n\n  ${f.body.replace(/\n/g, "\n  ")}`;
	});
	return `\n\n---\n\n### Findings\n\n${lines.join("\n\n")}`;
}

/**
 * Post the review. Maps verdict -> review event and findings -> line comments.
 * If GitHub rejects the inline comments (a comment anchors outside the diff),
 * retry body-only with the findings folded into the body so nothing is lost.
 * The body is always non-empty -- GitHub 422s a blank COMMENT review body.
 */
export async function postReview(
	token: string,
	owner: string,
	repo: string,
	prNumber: number,
	result: ReviewResult,
): Promise<void> {
	const url = `${GITHUB_API}/repos/${owner}/${repo}/pulls/${prNumber}/reviews`;
	const event = verdictToEvent(result.verdict);
	const summary = result.summary.trim() || FALLBACK_SUMMARY;
	const headers = {
		authorization: `Bearer ${token}`,
		accept: "application/vnd.github+json",
		"content-type": "application/json",
		"user-agent": USER_AGENT,
		"x-github-api-version": "2022-11-28",
	};

	const withComments = {
		body: summary,
		event,
		comments: result.findings.map(findingToComment),
	};
	let res = await fetch(url, { method: "POST", headers, body: JSON.stringify(withComments) });
	if (res.ok) return;

	// Most likely cause: a comment anchors to a line outside the diff
	// ("Path could not be resolved"). Fall back to a body-only review that
	// carries the summary AND the findings inline, so the review still lands.
	const firstError = await res.text();
	const bodyOnly = { body: summary + renderFindingsMarkdown(result.findings), event };
	res = await fetch(url, { method: "POST", headers, body: JSON.stringify(bodyOnly) });
	if (!res.ok) {
		throw new Error(
			`postReview failed (with comments: ${firstError}); body-only retry: ${res.status} ${await res.text()}`,
		);
	}
}
