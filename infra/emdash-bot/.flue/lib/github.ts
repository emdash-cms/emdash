// GitHub App helpers. Used by the OrchestratorDO; never reachable from the
// agent's container.

const GITHUB_API = "https://api.github.com";
const USER_AGENT = "emdash-bot";
const GITHUB_REQUEST_TIMEOUT_MS = 30_000;

function githubFetch(input: string, init: RequestInit = {}): Promise<Response> {
	return fetch(input, {
		...init,
		signal: init.signal ?? AbortSignal.timeout(GITHUB_REQUEST_TIMEOUT_MS),
	});
}

export interface GitHubAppCreds {
	appId: string;
	/** PKCS#8 PEM ("BEGIN PRIVATE KEY"). */
	privateKeyPem: string;
	installationId: string;
}

export interface RepoContext {
	owner: string;
	repo: string;
}

/** Returns creds if all three are present, else null (dev mode: skip writes). */
export function readAppCreds(env: Env): GitHubAppCreds | null {
	const appId = env.GITHUB_APP_ID;
	const privateKeyPem = env.GITHUB_APP_PRIVATE_KEY;
	const installationId = env.GITHUB_APP_INSTALLATION_ID;
	if (!appId || !privateKeyPem || !installationId) return null;
	return { appId, privateKeyPem, installationId };
}

export function readRepoContext(env: Env): RepoContext | null {
	if (!env.GITHUB_OWNER || !env.GITHUB_REPO) return null;
	return { owner: env.GITHUB_OWNER, repo: env.GITHUB_REPO };
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

export async function mintInstallationToken(creds: GitHubAppCreds): Promise<string> {
	const jwt = await signAppJwt(creds);
	const res = await githubFetch(
		`${GITHUB_API}/app/installations/${creds.installationId}/access_tokens`,
		{
			method: "POST",
			headers: {
				authorization: `Bearer ${jwt}`,
				accept: "application/vnd.github+json",
				"user-agent": USER_AGENT,
				"x-github-api-version": "2022-11-28",
			},
		},
	);
	if (!res.ok) {
		throw new Error(`installation token mint failed: ${res.status} ${await res.text()}`);
	}
	const json = await res.json<{ token?: string }>();
	if (!json.token) throw new Error("installation token response had no token");
	return json.token;
}

function authHeaders(token: string, extra: Record<string, string> = {}): Record<string, string> {
	return {
		authorization: `Bearer ${token}`,
		accept: "application/vnd.github+json",
		"user-agent": USER_AGENT,
		"x-github-api-version": "2022-11-28",
		...extra,
	};
}

export interface IssueSummary {
	title: string;
	body: string;
	labels: string[];
	authorLogin: string | null;
}

export async function getIssue(
	token: string,
	ctx: RepoContext,
	issueNumber: number,
): Promise<IssueSummary> {
	const res = await githubFetch(
		`${GITHUB_API}/repos/${ctx.owner}/${ctx.repo}/issues/${issueNumber}`,
		{ headers: authHeaders(token) },
	);
	if (!res.ok) throw new Error(`getIssue failed: ${res.status} ${await res.text()}`);
	const json = await res.json<{
		title?: string;
		body?: string | null;
		labels?: Array<{ name?: string }>;
		user?: { login?: string };
	}>();
	const labels: string[] = [];
	for (const l of json.labels ?? []) if (l.name) labels.push(l.name);
	return {
		title: json.title ?? "",
		body: json.body ?? "",
		labels,
		authorLogin: json.user?.login ?? null,
	};
}

export async function getIssueLabels(
	token: string,
	ctx: RepoContext,
	issueNumber: number,
): Promise<string[]> {
	const res = await githubFetch(
		`${GITHUB_API}/repos/${ctx.owner}/${ctx.repo}/issues/${issueNumber}/labels?per_page=100`,
		{ headers: authHeaders(token) },
	);
	if (!res.ok) throw new Error(`getIssueLabels failed: ${res.status} ${await res.text()}`);
	const json = await res.json<Array<{ name?: string }>>();
	const out: string[] = [];
	for (const l of json) if (l.name) out.push(l.name);
	return out;
}

export async function getBranchSha(
	token: string,
	ctx: RepoContext,
	branch: string,
): Promise<string | null> {
	const res = await githubFetch(
		`${GITHUB_API}/repos/${ctx.owner}/${ctx.repo}/branches/${encodeURIComponent(branch)}`,
		{ headers: authHeaders(token) },
	);
	if (res.status === 404) return null;
	if (!res.ok) throw new Error(`getBranchSha failed: ${res.status} ${await res.text()}`);
	const json = await res.json<{ commit?: { sha?: string } }>();
	return json.commit?.sha ?? null;
}

export async function addLabels(
	token: string,
	ctx: RepoContext,
	issueNumber: number,
	labels: readonly string[],
): Promise<void> {
	if (labels.length === 0) return;
	const res = await githubFetch(
		`${GITHUB_API}/repos/${ctx.owner}/${ctx.repo}/issues/${issueNumber}/labels`,
		{
			method: "POST",
			headers: authHeaders(token, { "content-type": "application/json" }),
			body: JSON.stringify({ labels: [...labels] }),
		},
	);
	if (!res.ok) throw new Error(`addLabels failed: ${res.status} ${await res.text()}`);
}

/** Removes one label. GitHub treats a 404 as "already gone", which is fine. */
export async function removeLabel(
	token: string,
	ctx: RepoContext,
	issueNumber: number,
	label: string,
): Promise<void> {
	const url = `${GITHUB_API}/repos/${ctx.owner}/${ctx.repo}/issues/${issueNumber}/labels/${encodeURIComponent(label)}`;
	const res = await githubFetch(url, { method: "DELETE", headers: authHeaders(token) });
	if (res.status === 404) return;
	if (!res.ok) throw new Error(`removeLabel(${label}) failed: ${res.status} ${await res.text()}`);
}

export async function removeLabels(
	token: string,
	ctx: RepoContext,
	issueNumber: number,
	labels: readonly string[],
): Promise<void> {
	for (const label of labels) {
		await removeLabel(token, ctx, issueNumber, label);
	}
}

export interface CreatedPullRequest {
	number: number;
	htmlUrl: string;
}

export async function getOpenPullRequest(
	token: string,
	ctx: RepoContext,
	headBranch: string,
): Promise<CreatedPullRequest | null> {
	const head = encodeURIComponent(`${ctx.owner}:${headBranch}`);
	const res = await githubFetch(
		`${GITHUB_API}/repos/${ctx.owner}/${ctx.repo}/pulls?state=open&head=${head}&per_page=1`,
		{ headers: authHeaders(token) },
	);
	if (!res.ok) {
		throw new Error(`getOpenPullRequest failed: ${res.status} ${await res.text()}`);
	}
	const json = await res.json<Array<{ number?: number; html_url?: string }>>();
	const pull = json[0];
	if (!pull?.number) return null;
	return { number: pull.number, htmlUrl: pull.html_url ?? "" };
}

export async function createPullRequest(
	token: string,
	ctx: RepoContext,
	args: { headBranch: string; baseBranch: string; title: string; body: string },
): Promise<CreatedPullRequest> {
	const res = await githubFetch(`${GITHUB_API}/repos/${ctx.owner}/${ctx.repo}/pulls`, {
		method: "POST",
		headers: authHeaders(token, { "content-type": "application/json" }),
		body: JSON.stringify({
			head: args.headBranch,
			base: args.baseBranch,
			title: args.title,
			body: args.body,
		}),
	});
	if (!res.ok) {
		throw new Error(`createPullRequest failed: ${res.status} ${await res.text()}`);
	}
	const json = await res.json<{ number?: number; html_url?: string }>();
	if (!json.number) throw new Error("createPullRequest response had no number");
	return { number: json.number, htmlUrl: json.html_url ?? "" };
}

export async function closePullRequest(
	token: string,
	ctx: RepoContext,
	prNumber: number,
): Promise<void> {
	const res = await githubFetch(`${GITHUB_API}/repos/${ctx.owner}/${ctx.repo}/pulls/${prNumber}`, {
		method: "PATCH",
		headers: authHeaders(token, { "content-type": "application/json" }),
		body: JSON.stringify({ state: "closed" }),
	});
	if (!res.ok) {
		throw new Error(`closePullRequest failed: ${res.status} ${await res.text()}`);
	}
}

export async function postIssueComment(
	token: string,
	ctx: RepoContext,
	issueNumber: number,
	body: string,
): Promise<void> {
	const res = await githubFetch(
		`${GITHUB_API}/repos/${ctx.owner}/${ctx.repo}/issues/${issueNumber}/comments`,
		{
			method: "POST",
			headers: authHeaders(token, { "content-type": "application/json" }),
			body: JSON.stringify({ body }),
		},
	);
	if (!res.ok) throw new Error(`postIssueComment failed: ${res.status} ${await res.text()}`);
}

export async function hasIssueCommentMarker(
	token: string,
	ctx: RepoContext,
	issueNumber: number,
	marker: string,
): Promise<boolean> {
	for (let page = 1; ; page++) {
		const res = await githubFetch(
			`${GITHUB_API}/repos/${ctx.owner}/${ctx.repo}/issues/${issueNumber}/comments?per_page=100&page=${page}`,
			{ headers: authHeaders(token) },
		);
		if (!res.ok) {
			throw new Error(`listIssueComments failed: ${res.status} ${await res.text()}`);
		}
		const comments = await res.json<Array<{ body?: string | null }>>();
		if (comments.some((comment) => comment.body?.includes(marker))) return true;
		if (comments.length < 100) return false;
	}
}
