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
const LINK_PAGE = /[?&]page=(\d+)/;

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

export async function mintInstallationToken(
	creds: GitHubAppCreds,
	signal?: AbortSignal,
): Promise<string> {
	const jwt = await signAppJwt(creds);
	const res = await githubFetch(
		`${GITHUB_API}/app/installations/${creds.installationId}/access_tokens`,
		{
			method: "POST",
			signal,
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
	commentCount: number;
}

export interface ManagedIssueSummary {
	number: number;
	title: string;
	url: string;
	updatedAt: string;
	labels: string[];
}

export async function listOpenManagedIssues(
	token: string,
	ctx: RepoContext,
): Promise<ManagedIssueSummary[]> {
	const kindLabels = ["bot:bug", "bot:enhancement", "bot:task"];
	const pages = await Promise.all(
		kindLabels.map(async (label) => {
			const params = new URLSearchParams({
				state: "open",
				labels: label,
				sort: "updated",
				direction: "desc",
				per_page: "100",
			});
			const res = await githubFetch(
				`${GITHUB_API}/repos/${ctx.owner}/${ctx.repo}/issues?${params.toString()}`,
				{ headers: authHeaders(token) },
			);
			if (!res.ok)
				throw new Error(`listOpenManagedIssues failed: ${res.status} ${await res.text()}`);
			return res.json<
				Array<{
					number?: number;
					title?: string;
					html_url?: string;
					updated_at?: string;
					labels?: Array<{ name?: string }>;
					pull_request?: unknown;
				}>
			>();
		}),
	);

	const issues = new Map<number, ManagedIssueSummary>();
	for (const page of pages) {
		for (const issue of page) {
			if (
				(issue.number !== undefined && issues.has(issue.number)) ||
				issue.pull_request !== undefined ||
				issue.number === undefined ||
				!issue.title ||
				!issue.html_url ||
				!issue.updated_at
			) {
				continue;
			}
			const labels = issue.labels?.flatMap((label) => (label.name ? [label.name] : [])) ?? [];
			issues.set(issue.number, {
				number: issue.number,
				title: issue.title,
				url: issue.html_url,
				updatedAt: issue.updated_at,
				labels,
			});
		}
	}
	return [...issues.values()].toSorted((left, right) =>
		right.updatedAt.localeCompare(left.updatedAt),
	);
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
		comments?: number;
	}>();
	const labels: string[] = [];
	for (const l of json.labels ?? []) if (l.name) labels.push(l.name);
	return {
		title: json.title ?? "",
		body: json.body ?? "",
		labels,
		authorLogin: json.user?.login ?? null,
		commentCount: json.comments ?? 0,
	};
}

export interface GitHubIssueComment {
	id: number;
	body: string;
	authorLogin: string | null;
	authorAssociation: string | null;
	authorType: string | null;
	createdAt: string;
}

export async function getIssueComments(
	token: string,
	ctx: RepoContext,
	issueNumber: number,
	options: { since?: string; commentCount?: number } = {},
): Promise<GitHubIssueComment[]> {
	const perPage = 100;
	const params = new URLSearchParams({ per_page: String(perPage) });
	if (options.since) params.set("since", options.since);
	else if (options.commentCount) {
		params.set("page", String(Math.max(1, Math.ceil(options.commentCount / perPage))));
	}
	const baseUrl = `${GITHUB_API}/repos/${ctx.owner}/${ctx.repo}/issues/${issueNumber}/comments`;
	let res = await githubFetch(`${baseUrl}?${params.toString()}`, { headers: authHeaders(token) });
	if (!res.ok) throw new Error(`getIssueComments failed: ${res.status} ${await res.text()}`);

	if (options.since) {
		const lastPage = lastPageFromLink(res.headers.get("link"));
		if (lastPage && lastPage > 1) {
			params.set("page", String(lastPage));
			res = await githubFetch(`${baseUrl}?${params.toString()}`, { headers: authHeaders(token) });
			if (!res.ok) throw new Error(`getIssueComments failed: ${res.status} ${await res.text()}`);
		}
	}

	const comments = await res.json<
		Array<{
			id?: number;
			body?: string | null;
			author_association?: string | null;
			created_at?: string;
			user?: { login?: string; type?: string };
		}>
	>();
	return comments.flatMap((comment) => {
		if (comment.id === undefined || !comment.created_at) return [];
		return [
			{
				id: comment.id,
				body: comment.body ?? "",
				authorLogin: comment.user?.login ?? null,
				authorAssociation: comment.author_association ?? null,
				authorType: comment.user?.type ?? null,
				createdAt: comment.created_at,
			} satisfies GitHubIssueComment,
		];
	});
}

function lastPageFromLink(link: string | null): number | null {
	if (!link) return null;
	for (const part of link.split(",")) {
		if (!part.includes('rel="last"')) continue;
		const match = part.match(LINK_PAGE);
		if (!match?.[1]) return null;
		const page = Number(match[1]);
		return Number.isSafeInteger(page) && page > 0 ? page : null;
	}
	return null;
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

/** Deletes a branch ref. A 404/422 means it is already gone, which is fine. */
export async function deleteBranch(token: string, ctx: RepoContext, branch: string): Promise<void> {
	const res = await githubFetch(
		`${GITHUB_API}/repos/${ctx.owner}/${ctx.repo}/git/refs/heads/${encodeURIComponent(branch)}`,
		{ method: "DELETE", headers: authHeaders(token) },
	);
	if (res.status === 404 || res.status === 422) return;
	if (!res.ok) throw new Error(`deleteBranch(${branch}) failed: ${res.status} ${await res.text()}`);
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

export async function getPullRequestHeadBranch(
	token: string,
	ctx: RepoContext,
	prNumber: number,
	signal?: AbortSignal,
): Promise<string | null> {
	const res = await githubFetch(`${GITHUB_API}/repos/${ctx.owner}/${ctx.repo}/pulls/${prNumber}`, {
		headers: authHeaders(token),
		signal,
	});
	if (res.status === 404) return null;
	if (!res.ok) {
		throw new Error(`getPullRequestHeadBranch failed: ${res.status} ${await res.text()}`);
	}
	const json = await res.json<{ head?: { ref?: unknown } }>();
	return typeof json.head?.ref === "string" && json.head.ref !== "" ? json.head.ref : null;
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
	args: { headBranch: string; baseBranch: string; title: string; body: string; draft?: boolean },
): Promise<CreatedPullRequest> {
	const res = await githubFetch(`${GITHUB_API}/repos/${ctx.owner}/${ctx.repo}/pulls`, {
		method: "POST",
		headers: authHeaders(token, { "content-type": "application/json" }),
		body: JSON.stringify({
			head: args.headBranch,
			base: args.baseBranch,
			title: args.title,
			body: args.body,
			draft: args.draft === true,
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

export interface IssueCommentReference {
	readonly id: number;
	readonly body: string;
	readonly htmlUrl: string;
}

export async function createIssueComment(
	token: string,
	ctx: RepoContext,
	issueNumber: number,
	body: string,
): Promise<IssueCommentReference> {
	const res = await githubFetch(
		`${GITHUB_API}/repos/${ctx.owner}/${ctx.repo}/issues/${issueNumber}/comments`,
		{
			method: "POST",
			headers: authHeaders(token, { "content-type": "application/json" }),
			body: JSON.stringify({ body }),
		},
	);
	if (!res.ok) throw new Error(`createIssueComment failed: ${res.status} ${await res.text()}`);
	const comment = await res.json<{ id?: number; body?: string | null; html_url?: string }>();
	if (!Number.isSafeInteger(comment.id) || !comment.id || comment.id < 1) {
		throw new Error("createIssueComment response had no valid id");
	}
	return { id: comment.id, body: comment.body ?? body, htmlUrl: comment.html_url ?? "" };
}

export async function updateIssueComment(
	token: string,
	ctx: RepoContext,
	commentId: number,
	body: string,
): Promise<boolean> {
	const res = await githubFetch(
		`${GITHUB_API}/repos/${ctx.owner}/${ctx.repo}/issues/comments/${commentId}`,
		{
			method: "PATCH",
			headers: authHeaders(token, { "content-type": "application/json" }),
			body: JSON.stringify({ body }),
		},
	);
	if (res.status === 404) return false;
	if (!res.ok) throw new Error(`updateIssueComment failed: ${res.status} ${await res.text()}`);
	return true;
}

export async function findIssueCommentByMarker(
	token: string,
	ctx: RepoContext,
	issueNumber: number,
	marker: string,
): Promise<IssueCommentReference | null> {
	for (let page = 1; ; page += 1) {
		const res = await githubFetch(
			`${GITHUB_API}/repos/${ctx.owner}/${ctx.repo}/issues/${issueNumber}/comments?per_page=100&page=${page}`,
			{ headers: authHeaders(token) },
		);
		if (!res.ok) {
			throw new Error(`listIssueComments failed: ${res.status} ${await res.text()}`);
		}
		const comments =
			await res.json<Array<{ id?: number; body?: string | null; html_url?: string }>>();
		const found = comments.find(
			(comment) => Number.isSafeInteger(comment.id) && comment.id && comment.body?.includes(marker),
		);
		if (found?.id) {
			return { id: found.id, body: found.body ?? "", htmlUrl: found.html_url ?? "" };
		}
		if (comments.length < 100) return null;
	}
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
