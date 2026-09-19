// GitHub App helpers. Used by the OrchestratorDO; never reachable from the
// agent's container.

import {
	parseGitHubResponseMetadata,
	type GitHubRateLimitGate,
} from "./github-rate-limit-client.js";

const GITHUB_API = "https://api.github.com";
const USER_AGENT = "emdash-bot";
const GITHUB_REQUEST_TIMEOUT_MS = 30_000;
const GITHUB_RATE_LIMIT_FALLBACK_MS = 60_000;

export interface CoordinatedGitHubToken {
	readonly token: string;
	readonly gate: GitHubRateLimitGate;
	readonly consumer: string;
}

export type GitHubToken = string | CoordinatedGitHubToken;

export class GitHubRateLimitError extends Error {
	constructor(
		readonly status: number,
		readonly retryAt: number,
		message: string,
	) {
		super(message);
		this.name = "GitHubRateLimitError";
	}
}

export class GitHubAnchorNotFoundError extends Error {
	constructor(readonly anchorNumber: number) {
		super(`GitHub anchor ${anchorNumber} was not found`);
		this.name = "GitHubAnchorNotFoundError";
	}
}

export class GitHubPullRequestNotFoundError extends Error {
	constructor(readonly pullRequestNumber: number) {
		super(`GitHub pull request ${pullRequestNumber} was not found`);
		this.name = "GitHubPullRequestNotFoundError";
	}
}

function retryHeaderAt(headers: Headers, now: number): number | null {
	const candidates: number[] = [];
	const retryAfter = headers.get("retry-after")?.trim();
	if (retryAfter) {
		const seconds = Number(retryAfter);
		if (Number.isFinite(seconds) && seconds >= 0) {
			candidates.push(now + seconds * 1_000);
		} else {
			const date = Date.parse(retryAfter);
			if (Number.isFinite(date)) candidates.push(date);
		}
	}
	const resetSeconds = Number(headers.get("x-ratelimit-reset"));
	if (Number.isFinite(resetSeconds) && resetSeconds > 0) {
		candidates.push(resetSeconds * 1_000);
	}
	return candidates.length > 0 ? Math.max(...candidates) : null;
}

function endpointCategory(input: string, method = "GET"): string {
	const url = new URL(input);
	if (url.pathname === "/graphql") return "graphql";
	if (url.pathname.includes("/access_tokens")) return "installation-token";
	if (url.pathname.includes("/comments")) return `issue-comment:${method.toLowerCase()}`;
	if (url.pathname.includes("/labels")) return `issue-label:${method.toLowerCase()}`;
	if (url.pathname.includes("/pulls")) return `pull-request:${method.toLowerCase()}`;
	if (url.pathname.includes("/issues")) return `issue:${method.toLowerCase()}`;
	if (url.pathname.includes("/git/refs")) return `git-ref:${method.toLowerCase()}`;
	return `other:${method.toLowerCase()}`;
}

function coordination(token?: GitHubToken): Omit<CoordinatedGitHubToken, "token"> | null {
	return token && typeof token !== "string" ? token : null;
}

async function githubFetch(
	input: string,
	init: RequestInit = {},
	token?: GitHubToken,
): Promise<Response> {
	const now = Date.now();
	const coordinated = coordination(token);
	const category = endpointCategory(input, init.method ?? "GET");
	if (coordinated) {
		const permit = await coordinated.gate.permit(category, coordinated.consumer);
		if (!permit.allowed) {
			throw new GitHubRateLimitError(
				429,
				permit.retryAt,
				`GitHub API request suppressed until ${new Date(permit.retryAt).toISOString()}`,
			);
		}
	}
	const response = await fetch(input, {
		...init,
		signal: init.signal ?? AbortSignal.timeout(GITHUB_REQUEST_TIMEOUT_MS),
	});
	if (coordinated) {
		await coordinated.gate.record(
			category,
			coordinated.consumer,
			parseGitHubResponseMetadata(response, now),
		);
	}
	const retryAt = retryHeaderAt(response.headers, now);
	const rateLimited =
		response.status === 429 ||
		(response.status === 403 &&
			(response.headers.get("x-ratelimit-remaining") === "0" ||
				response.headers.has("retry-after")));
	if (!rateLimited) return response;

	const backoffUntil = Math.max(retryAt ?? now + GITHUB_RATE_LIMIT_FALLBACK_MS, now + 1_000);
	if (!coordinated) {
		throw new GitHubRateLimitError(
			response.status,
			backoffUntil,
			`GitHub API rate limit exceeded: ${response.status}`,
		);
	}
	throw new GitHubRateLimitError(
		response.status,
		backoffUntil,
		`GitHub API rate limit exceeded: ${response.status}`,
	);
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
	coordinationToken?: GitHubToken,
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
		coordinationToken,
	);
	if (!res.ok) {
		throw new Error(`installation token mint failed: ${res.status}`);
	}
	const json = await res.json<{ token?: string }>();
	if (!json.token) throw new Error("installation token response had no token");
	return json.token;
}

function tokenValue(token: GitHubToken): string {
	return typeof token === "string" ? token : token.token;
}

function authHeaders(
	token: GitHubToken,
	extra: Record<string, string> = {},
): Record<string, string> {
	return {
		authorization: `Bearer ${tokenValue(token)}`,
		accept: "application/vnd.github+json",
		"user-agent": USER_AGENT,
		"x-github-api-version": "2022-11-28",
		...extra,
	};
}

function coordinatedFetch(
	token: GitHubToken,
	input: string,
	init: RequestInit = {},
): Promise<Response> {
	return githubFetch(input, init, token);
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
	token: GitHubToken,
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
			const res = await coordinatedFetch(
				token,
				`${GITHUB_API}/repos/${ctx.owner}/${ctx.repo}/issues?${params.toString()}`,
				{ headers: authHeaders(token) },
			);
			if (!res.ok) throw new Error(`listOpenManagedIssues failed: ${res.status}`);
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
	token: GitHubToken,
	ctx: RepoContext,
	issueNumber: number,
): Promise<IssueSummary> {
	const res = await coordinatedFetch(
		token,
		`${GITHUB_API}/repos/${ctx.owner}/${ctx.repo}/issues/${issueNumber}`,
		{ headers: authHeaders(token) },
	);
	if (res.status === 404) throw new GitHubAnchorNotFoundError(issueNumber);
	if (!res.ok) throw new Error(`getIssue failed: ${res.status}`);
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
	token: GitHubToken,
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
	let res = await coordinatedFetch(token, `${baseUrl}?${params.toString()}`, {
		headers: authHeaders(token),
	});
	if (!res.ok) throw new Error(`getIssueComments failed: ${res.status}`);

	if (options.since) {
		const lastPage = lastPageFromLink(res.headers.get("link"));
		if (lastPage && lastPage > 1) {
			params.set("page", String(lastPage));
			res = await coordinatedFetch(token, `${baseUrl}?${params.toString()}`, {
				headers: authHeaders(token),
			});
			if (!res.ok) throw new Error(`getIssueComments failed: ${res.status}`);
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
	token: GitHubToken,
	ctx: RepoContext,
	issueNumber: number,
	signal?: AbortSignal,
): Promise<string[]> {
	const res = await coordinatedFetch(
		token,
		`${GITHUB_API}/repos/${ctx.owner}/${ctx.repo}/issues/${issueNumber}/labels?per_page=100`,
		{ headers: authHeaders(token), signal },
	);
	if (res.status === 404) throw new GitHubAnchorNotFoundError(issueNumber);
	if (!res.ok) throw new Error(`getIssueLabels failed: ${res.status}`);
	const json = await res.json<Array<{ name?: string }>>();
	const out: string[] = [];
	for (const l of json) if (l.name) out.push(l.name);
	return out;
}

export async function confirmAnchorMissing(
	token: GitHubToken,
	ctx: RepoContext,
	issueNumber: number,
): Promise<boolean> {
	const repo = await coordinatedFetch(token, `${GITHUB_API}/repos/${ctx.owner}/${ctx.repo}`, {
		headers: authHeaders(token),
	});
	if (repo.status === 401 || repo.status === 403 || repo.status === 404) return false;
	if (!repo.ok) throw new Error(`confirmAnchorMissing repository probe failed: ${repo.status}`);
	const issue = await coordinatedFetch(
		token,
		`${GITHUB_API}/repos/${ctx.owner}/${ctx.repo}/issues/${issueNumber}`,
		{ headers: authHeaders(token) },
	);
	return issue.status === 404;
}

export async function confirmPullRequestMissing(
	token: GitHubToken,
	ctx: RepoContext,
	pullRequestNumber: number,
): Promise<boolean> {
	const repo = await coordinatedFetch(token, `${GITHUB_API}/repos/${ctx.owner}/${ctx.repo}`, {
		headers: authHeaders(token),
	});
	if (repo.status === 401 || repo.status === 403 || repo.status === 404) return false;
	if (!repo.ok)
		throw new Error(`confirmPullRequestMissing repository probe failed: ${repo.status}`);
	const pullRequest = await coordinatedFetch(
		token,
		`${GITHUB_API}/repos/${ctx.owner}/${ctx.repo}/pulls/${pullRequestNumber}`,
		{ headers: authHeaders(token) },
	);
	return pullRequest.status === 404;
}

export async function getBranchSha(
	token: GitHubToken,
	ctx: RepoContext,
	branch: string,
): Promise<string | null> {
	const res = await coordinatedFetch(
		token,
		`${GITHUB_API}/repos/${ctx.owner}/${ctx.repo}/branches/${encodeURIComponent(branch)}`,
		{ headers: authHeaders(token) },
	);
	if (res.status === 404) return null;
	if (!res.ok) throw new Error(`getBranchSha failed: ${res.status}`);
	const json = await res.json<{ commit?: { sha?: string } }>();
	return json.commit?.sha ?? null;
}

/** Deletes a branch ref. A 404/422 means it is already gone, which is fine. */
export async function deleteBranch(
	token: GitHubToken,
	ctx: RepoContext,
	branch: string,
): Promise<void> {
	const res = await coordinatedFetch(
		token,
		`${GITHUB_API}/repos/${ctx.owner}/${ctx.repo}/git/refs/heads/${encodeURIComponent(branch)}`,
		{ method: "DELETE", headers: authHeaders(token) },
	);
	if (res.status === 404 || res.status === 422) return;
	if (!res.ok) throw new Error(`deleteBranch(${branch}) failed: ${res.status}`);
}

export async function addLabels(
	token: GitHubToken,
	ctx: RepoContext,
	issueNumber: number,
	labels: readonly string[],
	signal?: AbortSignal,
): Promise<void> {
	if (labels.length === 0) return;
	const res = await coordinatedFetch(
		token,
		`${GITHUB_API}/repos/${ctx.owner}/${ctx.repo}/issues/${issueNumber}/labels`,
		{
			method: "POST",
			headers: authHeaders(token, { "content-type": "application/json" }),
			body: JSON.stringify({ labels: [...labels] }),
			signal,
		},
	);
	if (!res.ok) throw new Error(`addLabels failed: ${res.status}`);
}

/** Removes one label. GitHub treats a 404 as "already gone", which is fine. */
export async function removeLabel(
	token: GitHubToken,
	ctx: RepoContext,
	issueNumber: number,
	label: string,
	signal?: AbortSignal,
): Promise<void> {
	const url = `${GITHUB_API}/repos/${ctx.owner}/${ctx.repo}/issues/${issueNumber}/labels/${encodeURIComponent(label)}`;
	const res = await coordinatedFetch(token, url, {
		method: "DELETE",
		headers: authHeaders(token),
		signal,
	});
	if (res.status === 404) return;
	if (!res.ok) throw new Error(`removeLabel(${label}) failed: ${res.status}`);
}

export async function removeLabels(
	token: GitHubToken,
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

export interface PullRequestStatus {
	readonly number: number;
	readonly url: string;
	readonly state: "open" | "closed" | "merged";
	readonly draft: boolean;
	readonly headSha: string;
	readonly mergeability: "mergeable" | "conflicting" | "unknown";
	readonly review: "approved" | "changes-requested" | "review-required";
	readonly checks: "none" | "pending" | "passing" | "failing";
	readonly failingChecks: ReadonlyArray<{ name: string; url: string | null }>;
	readonly pendingChecks: string[];
	readonly updatedAt: string;
}

const PASSING_CHECK_CONCLUSIONS = new Set(["success", "neutral", "skipped"]);
const FAILING_CHECK_CONCLUSIONS = new Set([
	"action_required",
	"cancelled",
	"failure",
	"startup_failure",
	"stale",
	"timed_out",
]);

export async function getPullRequestStatus(
	token: GitHubToken,
	ctx: RepoContext,
	prNumber: number,
): Promise<PullRequestStatus> {
	const response = await coordinatedFetch(token, `${GITHUB_API}/graphql`, {
		method: "POST",
		headers: authHeaders(token, { "content-type": "application/json" }),
		body: JSON.stringify({
			query: `query EmDashPullRequestStatus($owner: String!, $repo: String!, $number: Int!) {
				repository(owner: $owner, name: $repo) {
					pullRequest(number: $number) {
						number url state isDraft merged mergeable headRefOid reviewDecision updatedAt
						commits(last: 1) {
							nodes {
								commit {
									statusCheckRollup {
										state
										contexts(first: 100) {
											nodes {
												... on CheckRun { name status conclusion detailsUrl }
												... on StatusContext { context state targetUrl }
											}
										}
									}
								}
							}
						}
					}
				}
			}`,
			variables: { owner: ctx.owner, repo: ctx.repo, number: prNumber },
		}),
	});
	if (!response.ok) throw new Error(`getPullRequestStatus failed: ${response.status}`);
	const payload = await response.json<{
		data?: {
			repository?: {
				pullRequest?: {
					number?: number;
					url?: string;
					state?: string;
					isDraft?: boolean;
					merged?: boolean;
					mergeable?: string;
					headRefOid?: string;
					reviewDecision?: string | null;
					updatedAt?: string;
					commits?: {
						nodes?: Array<{
							commit?: {
								statusCheckRollup?: {
									state?: string;
									contexts?: { nodes?: Array<Record<string, unknown>> };
								} | null;
							};
						}>;
					};
				};
			};
		};
		errors?: Array<{ message?: string }>;
	}>();
	if (payload.errors?.length) throw new Error("getPullRequestStatus GraphQL query failed");
	const pull = payload.data?.repository?.pullRequest;
	if (!pull) throw new GitHubPullRequestNotFoundError(prNumber);
	if (!pull.headRefOid) throw new Error("getPullRequestStatus response had no head SHA");
	const rollup = pull.commits?.nodes?.[0]?.commit?.statusCheckRollup;
	const contexts = rollup?.contexts?.nodes ?? [];

	const failingChecks: Array<{ name: string; url: string | null }> = [];
	const pendingChecks: string[] = [];
	let passingCount = 0;
	for (const context of contexts) {
		if (typeof context.name === "string") {
			const status = typeof context.status === "string" ? context.status.toLowerCase() : "";
			const conclusion =
				typeof context.conclusion === "string" ? context.conclusion.toLowerCase() : null;
			if (status !== "completed" || conclusion === null) pendingChecks.push(context.name);
			else if (FAILING_CHECK_CONCLUSIONS.has(conclusion)) {
				failingChecks.push({
					name: context.name,
					url: typeof context.detailsUrl === "string" ? context.detailsUrl : null,
				});
			} else if (PASSING_CHECK_CONCLUSIONS.has(conclusion)) passingCount += 1;
		} else if (typeof context.context === "string") {
			const state = typeof context.state === "string" ? context.state.toLowerCase() : "";
			if (state === "pending" || state === "expected") pendingChecks.push(context.context);
			else if (state === "failure" || state === "error") {
				failingChecks.push({
					name: context.context,
					url: typeof context.targetUrl === "string" ? context.targetUrl : null,
				});
			} else if (state === "success") passingCount += 1;
		}
	}
	const rollupState = rollup?.state?.toLowerCase();
	const checks =
		failingChecks.length > 0
			? "failing"
			: pendingChecks.length > 0 || rollupState === "pending" || rollupState === "expected"
				? "pending"
				: passingCount > 0 || rollupState === "success"
					? "passing"
					: "none";
	const review =
		pull.reviewDecision === "APPROVED"
			? "approved"
			: pull.reviewDecision === "CHANGES_REQUESTED"
				? "changes-requested"
				: "review-required";

	return {
		number: pull.number ?? prNumber,
		url: pull.url ?? `https://github.com/${ctx.owner}/${ctx.repo}/pull/${prNumber}`,
		state: pull.merged === true ? "merged" : pull.state === "CLOSED" ? "closed" : "open",
		draft: pull.isDraft === true,
		headSha: pull.headRefOid,
		mergeability:
			pull.mergeable === "MERGEABLE"
				? "mergeable"
				: pull.mergeable === "CONFLICTING"
					? "conflicting"
					: "unknown",
		review,
		checks,
		failingChecks,
		pendingChecks,
		updatedAt: pull.updatedAt ?? new Date().toISOString(),
	};
}

export async function getPullRequestHeadBranch(
	token: GitHubToken,
	ctx: RepoContext,
	prNumber: number,
	signal?: AbortSignal,
): Promise<string | null> {
	const res = await coordinatedFetch(
		token,
		`${GITHUB_API}/repos/${ctx.owner}/${ctx.repo}/pulls/${prNumber}`,
		{
			headers: authHeaders(token),
			signal,
		},
	);
	if (res.status === 404) return null;
	if (!res.ok) {
		throw new Error(`getPullRequestHeadBranch failed: ${res.status}`);
	}
	const json = await res.json<{ head?: { ref?: unknown } }>();
	return typeof json.head?.ref === "string" && json.head.ref !== "" ? json.head.ref : null;
}

export async function getOpenPullRequest(
	token: GitHubToken,
	ctx: RepoContext,
	headBranch: string,
): Promise<CreatedPullRequest | null> {
	const head = encodeURIComponent(`${ctx.owner}:${headBranch}`);
	const res = await coordinatedFetch(
		token,
		`${GITHUB_API}/repos/${ctx.owner}/${ctx.repo}/pulls?state=open&head=${head}&per_page=1`,
		{ headers: authHeaders(token) },
	);
	if (!res.ok) {
		throw new Error(`getOpenPullRequest failed: ${res.status}`);
	}
	const json = await res.json<Array<{ number?: number; html_url?: string }>>();
	const pull = json[0];
	if (!pull?.number) return null;
	return { number: pull.number, htmlUrl: pull.html_url ?? "" };
}

export async function createPullRequest(
	token: GitHubToken,
	ctx: RepoContext,
	args: { headBranch: string; baseBranch: string; title: string; body: string; draft?: boolean },
): Promise<CreatedPullRequest> {
	const res = await coordinatedFetch(token, `${GITHUB_API}/repos/${ctx.owner}/${ctx.repo}/pulls`, {
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
		throw new Error(`createPullRequest failed: ${res.status}`);
	}
	const json = await res.json<{ number?: number; html_url?: string }>();
	if (!json.number) throw new Error("createPullRequest response had no number");
	return { number: json.number, htmlUrl: json.html_url ?? "" };
}

export async function closePullRequest(
	token: GitHubToken,
	ctx: RepoContext,
	prNumber: number,
): Promise<void> {
	const res = await coordinatedFetch(
		token,
		`${GITHUB_API}/repos/${ctx.owner}/${ctx.repo}/pulls/${prNumber}`,
		{
			method: "PATCH",
			headers: authHeaders(token, { "content-type": "application/json" }),
			body: JSON.stringify({ state: "closed" }),
		},
	);
	if (!res.ok) {
		throw new Error(`closePullRequest failed: ${res.status}`);
	}
}

export async function postIssueComment(
	token: GitHubToken,
	ctx: RepoContext,
	issueNumber: number,
	body: string,
): Promise<void> {
	const res = await coordinatedFetch(
		token,
		`${GITHUB_API}/repos/${ctx.owner}/${ctx.repo}/issues/${issueNumber}/comments`,
		{
			method: "POST",
			headers: authHeaders(token, { "content-type": "application/json" }),
			body: JSON.stringify({ body }),
		},
	);
	if (!res.ok) throw new Error(`postIssueComment failed: ${res.status}`);
}

export interface IssueCommentReference {
	readonly id: number;
	readonly body: string;
	readonly htmlUrl: string;
}

export async function createIssueComment(
	token: GitHubToken,
	ctx: RepoContext,
	issueNumber: number,
	body: string,
): Promise<IssueCommentReference> {
	const res = await coordinatedFetch(
		token,
		`${GITHUB_API}/repos/${ctx.owner}/${ctx.repo}/issues/${issueNumber}/comments`,
		{
			method: "POST",
			headers: authHeaders(token, { "content-type": "application/json" }),
			body: JSON.stringify({ body }),
		},
	);
	if (!res.ok) throw new Error(`createIssueComment failed: ${res.status}`);
	const comment = await res.json<{ id?: number; body?: string | null; html_url?: string }>();
	if (!Number.isSafeInteger(comment.id) || !comment.id || comment.id < 1) {
		throw new Error("createIssueComment response had no valid id");
	}
	return { id: comment.id, body: comment.body ?? body, htmlUrl: comment.html_url ?? "" };
}

export async function updateIssueComment(
	token: GitHubToken,
	ctx: RepoContext,
	commentId: number,
	body: string,
): Promise<boolean> {
	const res = await coordinatedFetch(
		token,
		`${GITHUB_API}/repos/${ctx.owner}/${ctx.repo}/issues/comments/${commentId}`,
		{
			method: "PATCH",
			headers: authHeaders(token, { "content-type": "application/json" }),
			body: JSON.stringify({ body }),
		},
	);
	if (res.status === 404) return false;
	if (!res.ok) throw new Error(`updateIssueComment failed: ${res.status}`);
	return true;
}

export async function findIssueCommentByMarker(
	token: GitHubToken,
	ctx: RepoContext,
	issueNumber: number,
	marker: string,
): Promise<IssueCommentReference | null> {
	for (let page = 1; ; page += 1) {
		const res = await coordinatedFetch(
			token,
			`${GITHUB_API}/repos/${ctx.owner}/${ctx.repo}/issues/${issueNumber}/comments?per_page=100&page=${page}`,
			{ headers: authHeaders(token) },
		);
		if (!res.ok) {
			throw new Error(`listIssueComments failed: ${res.status}`);
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
	token: GitHubToken,
	ctx: RepoContext,
	issueNumber: number,
	marker: string,
): Promise<boolean> {
	for (let page = 1; ; page++) {
		const res = await coordinatedFetch(
			token,
			`${GITHUB_API}/repos/${ctx.owner}/${ctx.repo}/issues/${issueNumber}/comments?per_page=100&page=${page}`,
			{ headers: authHeaders(token) },
		);
		if (!res.ok) {
			throw new Error(`listIssueComments failed: ${res.status}`);
		}
		const comments = await res.json<Array<{ body?: string | null }>>();
		if (comments.some((comment) => comment.body?.includes(marker))) return true;
		if (comments.length < 100) return false;
	}
}

export async function getPullRequestReviewComments(
	token: GitHubToken,
	ctx: RepoContext,
	prNumber: number,
	reviewId: number,
	signal?: AbortSignal,
): Promise<string[]> {
	const result: string[] = [];
	for (let page = 1; ; page += 1) {
		const res = await coordinatedFetch(
			token,
			`${GITHUB_API}/repos/${ctx.owner}/${ctx.repo}/pulls/${prNumber}/reviews/${reviewId}/comments?per_page=100&page=${page}`,
			{ headers: authHeaders(token), signal },
		);
		if (!res.ok) throw new Error(`getPullRequestReviewComments failed: ${res.status}`);
		const comments = await res.json<
			Array<{
				body?: string | null;
				path?: string;
				line?: number | null;
				original_line?: number | null;
				diff_hunk?: string;
			}>
		>();
		for (const comment of comments) {
			if (!comment.body?.trim()) continue;
			const line = comment.line ?? comment.original_line;
			result.push(
				[
					`File: ${comment.path ?? "unknown"}${line ? `:${line}` : ""}`,
					comment.diff_hunk ?? "",
					comment.body,
				]
					.filter(Boolean)
					.join("\n\n"),
			);
		}
		if (comments.length < 100) return result;
	}
}

async function listPullRequestPages<T>(
	token: GitHubToken,
	ctx: RepoContext,
	prNumber: number,
	resource: "reviews" | "commits",
	signal?: AbortSignal,
): Promise<T[]> {
	const result: T[] = [];
	for (let page = 1; ; page += 1) {
		const res = await coordinatedFetch(
			token,
			`${GITHUB_API}/repos/${ctx.owner}/${ctx.repo}/pulls/${prNumber}/${resource}?per_page=100&page=${page}`,
			{ headers: authHeaders(token), signal },
		);
		if (!res.ok) {
			throw new Error(`listing PR ${resource} failed: ${res.status}`);
		}
		const items = await res.json<T[]>();
		result.push(...items);
		if (items.length < 100) return result;
	}
}

export interface PullRequestReview {
	readonly state: string;
	readonly submittedAt: string | null;
	readonly authorLogin: string | null;
	readonly authorType: string | null;
	readonly authorAssociation: string | null;
}

export async function listPullRequestReviews(
	token: GitHubToken,
	ctx: RepoContext,
	prNumber: number,
	signal?: AbortSignal,
): Promise<PullRequestReview[]> {
	const reviews = await listPullRequestPages<{
		state?: string;
		submitted_at?: string | null;
		author_association?: string | null;
		user?: { login?: string; type?: string } | null;
	}>(token, ctx, prNumber, "reviews", signal);
	return reviews.map((review) => ({
		state: review.state ?? "",
		submittedAt: review.submitted_at ?? null,
		authorLogin: review.user?.login ?? null,
		authorType: review.user?.type ?? null,
		authorAssociation: review.author_association ?? null,
	}));
}

export interface PullRequestCommit {
	readonly committedAt: string | null;
	readonly parentCount: number;
}

export async function listPullRequestCommits(
	token: GitHubToken,
	ctx: RepoContext,
	prNumber: number,
	signal?: AbortSignal,
): Promise<PullRequestCommit[]> {
	const commits = await listPullRequestPages<{
		parents?: unknown[];
		commit?: { committer?: { date?: string | null } | null };
	}>(token, ctx, prNumber, "commits", signal);
	return commits.map((commit) => ({
		committedAt: commit.commit?.committer?.date ?? null,
		parentCount: commit.parents?.length ?? 0,
	}));
}
