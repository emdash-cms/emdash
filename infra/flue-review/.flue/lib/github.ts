// GitHub App helpers, used only by trusted Worker/Durable-Object code (the
// review workflow's run()). None of this runs in the agent's container, so the
// installation token is never reachable by the model-directed shell.
//
// Auth model: a GitHub App authenticates as an installation. We mint a short
// JWT signed with the app's private key (RS256), exchange it for an
// installation access token (valid ~1h, scoped to the installation's repos and
// the app's permissions), and use that token for reads and for posting the
// review. The app needs `pull_requests: write`, `checks: write`, and
// `contents: read`.

import { limitUtf8Text } from "./byte-budget.js";
import type { PullRequestRevision, ReviewHeadMove } from "./review-head.js";
import type { ReviewResult } from "./review-schema.js";

const GITHUB_API = "https://api.github.com";
const USER_AGENT = "emdash-flue-review";
const GITHUB_REQUEST_TIMEOUT_MS = 30_000;
const REVIEW_RATE_LIMIT_RETRIES = 3;
const REVIEW_RATE_LIMIT_FALLBACK_MS = 60_000;
const REVIEW_RATE_LIMIT_MAX_DELAY_MS = 60 * 60_000;
const REVIEW_RATE_LIMIT_RESET_BUFFER_MS = 1_000;
const INLINE_PERMIT_WAIT_MS = 5_000;
export const POST_MODEL_PERMIT_WAIT_MS = REVIEW_RATE_LIMIT_MAX_DELAY_MS;
const RATE_LIMIT_ERROR = /\brate limit\b/i;
const AUTO_FORMAT_MESSAGE = "style: format";
const EMDASH_BOT_LOGIN = "emdashbot[bot]";
const AUTO_FORMAT_NAME = "emdashbot[bot]";
const AUTO_FORMAT_EMAIL = "emdashbot[bot]@users.noreply.github.com";
const GITHUB_HEADERS = {
	accept: "application/vnd.github+json",
	"content-type": "application/json",
	"user-agent": USER_AGENT,
	"x-github-api-version": "2022-11-28",
};

export interface GitHubRateLimitGate {
	permit(category: string, consumer: string): Promise<{ allowed: boolean; retryAt: number }>;
	getInstallationToken(): Promise<string>;
	record(
		category: string,
		consumer: string,
		metadata: {
			status: number;
			limit: number | null;
			remaining: number | null;
			resetAt: number | null;
			retryAfterAt: number | null;
		},
	): Promise<void>;
}

class ExternalGitHubRateLimitGate implements GitHubRateLimitGate {
	constructor(private readonly stub: DurableObjectStub) {}

	async permit(category: string, consumer: string) {
		const response = await this.stub.fetch("http://github-rate-limit/permit", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ category, consumer }),
		});
		if (!response.ok) throw new Error(`GitHub coordinator permit failed: ${response.status}`);
		const payload = await response.json<unknown>();
		if (!payload || typeof payload !== "object")
			throw new Error("GitHub coordinator permit was invalid");
		const value = Object.fromEntries(Object.entries(payload));
		if (typeof value.allowed !== "boolean" || typeof value.retryAt !== "number") {
			throw new Error("GitHub coordinator permit was invalid");
		}
		return { allowed: value.allowed, retryAt: value.retryAt };
	}

	async getInstallationToken(): Promise<string> {
		const response = await this.stub.fetch("http://github-rate-limit/token");
		if (!response.ok) throw new Error(`GitHub token broker failed: ${response.status}`);
		const payload = await response.json<unknown>();
		if (!payload || typeof payload !== "object" || !("token" in payload)) {
			throw new Error("GitHub token broker response was invalid");
		}
		const token = payload.token;
		if (typeof token !== "string" || token.length === 0) {
			throw new Error("GitHub token broker response was invalid");
		}
		return token;
	}

	async record(
		category: string,
		consumer: string,
		metadata: Parameters<GitHubRateLimitGate["record"]>[2],
	): Promise<void> {
		const response = await this.stub.fetch("http://github-rate-limit/record", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ category, consumer, metadata }),
		});
		if (!response.ok) throw new Error(`GitHub coordinator record failed: ${response.status}`);
	}
}

export function githubRateLimitGate(env: Env): GitHubRateLimitGate {
	return new ExternalGitHubRateLimitGate(
		env.GITHUB_RATE_LIMIT.getByName(`installation:${env.GITHUB_APP_INSTALLATION_ID}`),
	);
}

export type GitHubToken =
	| string
	| {
			readonly token: string;
			readonly gate: GitHubRateLimitGate;
			readonly consumer: string;
			readonly maxPermitWaitMs?: number;
	  };

function tokenValue(token: GitHubToken): string {
	return typeof token === "string" ? token : token.token;
}

function responseMetadata(response: Response, now = Date.now()) {
	const numberHeader = (name: string) => {
		const header = response.headers.get(name);
		if (header === null) return null;
		const value = Number(header);
		return Number.isFinite(value) && value >= 0 ? value : null;
	};
	const retryAfter = response.headers.get("retry-after")?.trim() ?? "";
	const retrySeconds = Number(retryAfter);
	const retryDate = Date.parse(retryAfter);
	return {
		status: response.status,
		limit: numberHeader("x-ratelimit-limit"),
		remaining: numberHeader("x-ratelimit-remaining"),
		resetAt: (() => {
			const seconds = numberHeader("x-ratelimit-reset");
			return seconds === null ? null : seconds * 1_000;
		})(),
		retryAfterAt: retryAfter
			? Number.isFinite(retrySeconds)
				? now + retrySeconds * 1_000
				: Number.isFinite(retryDate)
					? retryDate
					: null
			: null,
	};
}

async function acquireGitHubPermit(
	gate: GitHubRateLimitGate,
	category: string,
	consumer: string,
	maxWaitMs = INLINE_PERMIT_WAIT_MS,
) {
	const deadline = Date.now() + maxWaitMs;
	for (;;) {
		const permit = await gate.permit(category, consumer);
		if (permit.allowed) return permit;
		const now = Date.now();
		if (now >= deadline || permit.retryAt > deadline) return permit;
		await sleep(Math.max(1, permit.retryAt - now));
	}
}

async function githubFetch(
	input: string,
	init: RequestInit = {},
	token?: GitHubToken,
): Promise<Response> {
	const coordinated = token && typeof token !== "string" ? token : null;
	const category = new URL(input).pathname === "/graphql" ? "graphql" : "review-rest";
	if (coordinated) {
		const permit = await acquireGitHubPermit(
			coordinated.gate,
			category,
			coordinated.consumer,
			coordinated.maxPermitWaitMs,
		);
		if (!permit.allowed) {
			throw new GitHubRateLimitError(
				`GitHub request suppressed until ${new Date(permit.retryAt).toISOString()}`,
				Math.max(1_000, permit.retryAt - Date.now()),
			);
		}
	}
	const response = await fetch(input, {
		...init,
		signal: init.signal ?? AbortSignal.timeout(GITHUB_REQUEST_TIMEOUT_MS),
	});
	if (coordinated) {
		await coordinated.gate.record(category, coordinated.consumer, responseMetadata(response));
	}
	return response;
}

function coordinatedFetch(token: GitHubToken, input: string, init: RequestInit = {}) {
	return githubFetch(input, init, token);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryAfterMs(value: string | null, now: number): number | undefined {
	if (value === null) return undefined;
	const seconds = Number(value);
	if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
	const retryAt = Date.parse(value);
	if (Number.isNaN(retryAt)) return undefined;
	return Math.max(0, retryAt - now);
}

function rateLimitRetryDelayMs(
	response: Response,
	errorBody: string,
	retryCount: number,
	now = Date.now(),
): number | undefined {
	const retryAfter = response.headers.get("retry-after");
	const reset = response.headers.get("x-ratelimit-reset");
	const remaining = response.headers.get("x-ratelimit-remaining");
	const rateLimited =
		response.status === 429 ||
		(response.status === 403 &&
			(retryAfter !== null ||
				reset !== null ||
				remaining === "0" ||
				RATE_LIMIT_ERROR.test(errorBody)));
	if (!rateLimited) return undefined;

	const retryAfterDelay = retryAfterMs(retryAfter, now);
	if (retryAfterDelay !== undefined) {
		return Math.min(REVIEW_RATE_LIMIT_MAX_DELAY_MS, Math.max(1_000, retryAfterDelay));
	}
	const resetSeconds = Number(reset);
	if (Number.isFinite(resetSeconds) && resetSeconds > 0) {
		const resetDelay = resetSeconds * 1_000 - now + REVIEW_RATE_LIMIT_RESET_BUFFER_MS;
		return Math.min(REVIEW_RATE_LIMIT_MAX_DELAY_MS, Math.max(1_000, resetDelay));
	}
	return Math.min(REVIEW_RATE_LIMIT_MAX_DELAY_MS, REVIEW_RATE_LIMIT_FALLBACK_MS * 2 ** retryCount);
}

export class GitHubRateLimitError extends Error {
	constructor(
		message: string,
		readonly retryDelayMs: number,
		readonly hasRetryHint = true,
	) {
		super(message);
		this.name = "GitHubRateLimitError";
	}
}

interface ReviewRetryOptions {
	pullRequestAuthorLogin?: string;
	beforeRetry?: (input: {
		retry: number;
		maxRetries: number;
		delayMs: number;
	}) => Promise<GitHubToken | undefined>;
}

async function postReviewRequest(
	url: string,
	token: GitHubToken,
	body: unknown,
	options?: ReviewRetryOptions,
): Promise<{ response: Response; errorBody: string }> {
	let currentToken = token;
	for (let retryCount = 0; ; retryCount++) {
		const response = await coordinatedFetch(currentToken, url, {
			method: "POST",
			headers: { ...GITHUB_HEADERS, authorization: `Bearer ${tokenValue(currentToken)}` },
			body: JSON.stringify(body),
		});
		if (response.ok) return { response, errorBody: "" };
		const errorBody = await response.text();
		const delayMs = rateLimitRetryDelayMs(response, errorBody, retryCount);
		if (delayMs === undefined || retryCount >= REVIEW_RATE_LIMIT_RETRIES) {
			return { response, errorBody };
		}
		await sleep(delayMs);
		const refreshedToken = await options?.beforeRetry?.({
			retry: retryCount + 1,
			maxRetries: REVIEW_RATE_LIMIT_RETRIES,
			delayMs,
		});
		if (refreshedToken) currentToken = refreshedToken;
	}
}

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
export async function mintInstallationToken(
	creds: GitHubAppCreds,
	coordinationToken?: GitHubToken,
): Promise<string> {
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
		coordinationToken,
	);
	if (!res.ok) {
		await requireGitHubResponse(res, "installation token mint");
	}
	const json = await res.json<{ token?: string }>();
	if (!json.token) throw new Error("installation token response had no token");
	return json.token;
}

function installationHeaders(token: GitHubToken): Record<string, string> {
	return { ...GITHUB_HEADERS, authorization: `Bearer ${tokenValue(token)}` };
}

function pullRequestUrl(owner: string, repo: string, prNumber: number, files = false): string {
	return `https://github.com/${owner}/${repo}/pull/${prNumber}${files ? "/files" : ""}`;
}

async function requireGitHubResponse(res: Response, operation: string): Promise<void> {
	if (res.ok) return;
	const retryDelay = rateLimitRetryDelayMs(res, "", 0);
	const message = `${operation} failed: ${res.status}`;
	if (retryDelay !== undefined) {
		const hasRetryHint =
			res.headers.get("retry-after") !== null || res.headers.get("x-ratelimit-reset") !== null;
		throw new GitHubRateLimitError(message, retryDelay, hasRetryHint);
	}
	throw new Error(message);
}

export async function getPullRequestHeadSha(
	token: GitHubToken,
	owner: string,
	repo: string,
	prNumber: number,
): Promise<string> {
	const res = await coordinatedFetch(
		token,
		`${GITHUB_API}/repos/${owner}/${repo}/pulls/${prNumber}`,
		{
			headers: installationHeaders(token),
		},
	);
	await requireGitHubResponse(res, "read pull request head");
	const body = await res.json<{ head?: { sha?: string } }>();
	if (!body.head?.sha) throw new Error("read pull request head response had no SHA");
	return body.head.sha;
}

export async function createReviewCheck(
	token: GitHubToken,
	owner: string,
	repo: string,
	input: { headSha: string; attemptId: string; prNumber: number },
): Promise<number> {
	const res = await coordinatedFetch(token, `${GITHUB_API}/repos/${owner}/${repo}/check-runs`, {
		method: "POST",
		headers: installationHeaders(token),
		body: JSON.stringify({
			name: "EmDashBot review",
			head_sha: input.headSha,
			status: "in_progress",
			details_url: pullRequestUrl(owner, repo, input.prNumber, true),
			external_id: input.attemptId,
			started_at: new Date().toISOString(),
			output: {
				title: `Reviewing PR #${input.prNumber}`,
				summary: "The review request was accepted and is being admitted.",
			},
		}),
	});
	await requireGitHubResponse(res, "create review check");
	const json = await res.json<{ id?: number }>();
	if (typeof json.id !== "number" || !Number.isInteger(json.id)) {
		throw new Error("create review check response had no id");
	}
	return json.id;
}

export async function findReviewCheck(
	token: GitHubToken,
	owner: string,
	repo: string,
	headSha: string,
	attemptId: string,
): Promise<number | undefined> {
	const query = new URLSearchParams({
		check_name: "EmDashBot review",
		filter: "all",
		per_page: "100",
	});
	const res = await coordinatedFetch(
		token,
		`${GITHUB_API}/repos/${owner}/${repo}/commits/${encodeURIComponent(headSha)}/check-runs?${query.toString()}`,
		{ headers: installationHeaders(token) },
	);
	await requireGitHubResponse(res, "find review check");
	const body = await res.json<{ check_runs?: Array<{ id?: number; external_id?: string }> }>();
	return body.check_runs?.find((check) => check.external_id === attemptId)?.id;
}

const REVIEW_PROGRESS = [
	{ stage: "hydrating", label: "Prepare the workspace" },
	{ stage: "fetching_diff", label: "Load the pull request diff" },
	{ stage: "model_review", label: "Analyze the changes" },
	{ stage: "posting_review", label: "Publish the review" },
] as const;

const REVIEW_STAGE_COPY: Record<string, { title: string; guidance: string }> = {
	hydrating: {
		title: "Preparing",
		guidance: "Next, EmDashBot will load the pull request diff.",
	},
	fetching_diff: {
		title: "Loading changes for",
		guidance: "Next, the model will analyze the changed code.",
	},
	model_review: {
		title: "Analyzing",
		guidance:
			"This is usually the longest step and can take several minutes. Next, EmDashBot will publish the review to GitHub.",
	},
	posting_review: {
		title: "Publishing review for",
		guidance: "The analysis is complete and the review should appear shortly.",
	},
};

function renderReviewProgress(stage: string, runId: string): string {
	const currentIndex = REVIEW_PROGRESS.findIndex((step) => step.stage === stage);
	const progress = REVIEW_PROGRESS.map((step, index) => {
		if (index < currentIndex) return `- [x] ${step.label}`;
		if (index === currentIndex) return `- [ ] **${step.label} (in progress)**`;
		return `- [ ] ${step.label}`;
	});
	return [
		"### Progress",
		"",
		...progress,
		"",
		"<details>",
		"<summary>Diagnostics</summary>",
		"",
		`Run ID: \`${runId}\``,
		"",
		`Stage: \`${stage}\``,
		"</details>",
	].join("\n");
}

export async function updateReviewCheck(
	token: GitHubToken,
	owner: string,
	repo: string,
	checkRunId: number,
	input: {
		prNumber: number;
		runId?: string;
		stage: string;
		detail: string;
	},
): Promise<void> {
	const correlation = input.runId ?? "pending admission";
	const stageCopy = REVIEW_STAGE_COPY[input.stage] ?? {
		title: "Reviewing",
		guidance: "EmDashBot will update this check when the next step begins.",
	};
	const body: Record<string, unknown> = {
		status: "in_progress",
		details_url: pullRequestUrl(owner, repo, input.prNumber, true),
		output: {
			title: `${stageCopy.title} PR #${input.prNumber}`,
			summary: `${input.detail} ${stageCopy.guidance}`,
			text: renderReviewProgress(input.stage, correlation),
		},
	};
	if (input.runId) body.external_id = input.runId;
	const res = await coordinatedFetch(
		token,
		`${GITHUB_API}/repos/${owner}/${repo}/check-runs/${checkRunId}`,
		{
			method: "PATCH",
			headers: installationHeaders(token),
			body: JSON.stringify(body),
		},
	);
	await requireGitHubResponse(res, "update review check");
}

export async function completeReviewCheck(
	token: GitHubToken,
	owner: string,
	repo: string,
	checkRunId: number,
	input: {
		conclusion: "success" | "failure" | "timed_out";
		prNumber: number;
		runId: string;
		summary: string;
	},
): Promise<void> {
	const title =
		input.conclusion === "success"
			? `Review completed for PR #${input.prNumber}`
			: input.conclusion === "timed_out"
				? `Review timed out for PR #${input.prNumber}`
				: `Review failed for PR #${input.prNumber}`;
	const res = await coordinatedFetch(
		token,
		`${GITHUB_API}/repos/${owner}/${repo}/check-runs/${checkRunId}`,
		{
			method: "PATCH",
			headers: installationHeaders(token),
			body: JSON.stringify({
				status: "completed",
				conclusion: input.conclusion,
				completed_at: new Date().toISOString(),
				details_url: pullRequestUrl(owner, repo, input.prNumber),
				external_id: input.runId,
				output: { title, summary: input.summary, text: `Run: \`${input.runId}\`` },
			}),
		},
	);
	await requireGitHubResponse(res, "complete review check");
}

export async function removePullRequestLabel(
	token: GitHubToken,
	owner: string,
	repo: string,
	prNumber: number,
	label: string,
): Promise<void> {
	const res = await coordinatedFetch(
		token,
		`${GITHUB_API}/repos/${owner}/${repo}/issues/${prNumber}/labels/${encodeURIComponent(label)}`,
		{
			method: "DELETE",
			headers: installationHeaders(token),
		},
	);
	if (res.status !== 404) await requireGitHubResponse(res, "remove pull request label");
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
	token?: GitHubToken,
	baseSha?: string,
	headSha?: string,
): Promise<string> {
	const headers: Record<string, string> = {
		accept: "application/vnd.github.v3.diff",
		"user-agent": USER_AGENT,
		"x-github-api-version": "2022-11-28",
	};
	if (token) headers.authorization = `Bearer ${tokenValue(token)}`;
	const path =
		baseSha && headSha
			? `/repos/${owner}/${repo}/compare/${encodeURIComponent(baseSha)}...${encodeURIComponent(headSha)}`
			: `/repos/${owner}/${repo}/pulls/${prNumber}`;
	const res = token
		? await coordinatedFetch(token, `${GITHUB_API}${path}`, { headers })
		: await githubFetch(`${GITHUB_API}${path}`, { headers });
	if (!res.ok) {
		throw new Error(`unified diff fetch failed: ${res.status}`);
	}
	return res.text();
}

export async function fetchPullRequestRevision(
	token: GitHubToken,
	owner: string,
	repo: string,
	prNumber: number,
): Promise<PullRequestRevision> {
	const res = await coordinatedFetch(
		token,
		`${GITHUB_API}/repos/${owner}/${repo}/pulls/${prNumber}`,
		{
			headers: installationHeaders(token),
		},
	);
	await requireGitHubResponse(res, "fetch pull request revision");
	const pull = await res.json<{ head?: { sha?: string }; base?: { sha?: string } }>();
	if (!pull.head?.sha || !pull.base?.sha) {
		throw new Error("Pull request response did not include base and head SHAs");
	}
	return { headSha: pull.head.sha, baseSha: pull.base.sha };
}

interface ComparisonCommit {
	author?: { login?: string; type?: string } | null;
	commit?: {
		author?: { name?: string; email?: string } | null;
		message?: string;
	};
}

function isAutoFormatCommit(commit: ComparisonCommit): boolean {
	return (
		commit.commit?.message?.split("\n", 1)[0] === AUTO_FORMAT_MESSAGE &&
		commit.author?.login === EMDASH_BOT_LOGIN &&
		commit.author.type === "Bot" &&
		commit.commit.author?.name === AUTO_FORMAT_NAME &&
		commit.commit.author.email === AUTO_FORMAT_EMAIL
	);
}

export async function classifyPullRequestHeadMove(
	token: GitHubToken,
	owner: string,
	repo: string,
	fromHeadSha: string,
	toHeadSha: string,
): Promise<ReviewHeadMove> {
	const res = await coordinatedFetch(
		token,
		`${GITHUB_API}/repos/${owner}/${repo}/compare/${encodeURIComponent(fromHeadSha)}...${encodeURIComponent(toHeadSha)}`,
		{ headers: installationHeaders(token) },
	);
	await requireGitHubResponse(res, "compare pull request heads");
	const comparison = await res.json<{
		status?: string;
		total_commits?: number;
		commits?: ComparisonCommit[];
	}>();
	if (
		comparison.status !== "ahead" ||
		!Number.isInteger(comparison.total_commits) ||
		!comparison.total_commits ||
		comparison.commits?.length !== comparison.total_commits
	) {
		return "substantive";
	}
	return comparison.commits.every(isAutoFormatCommit) ? "format_only" : "substantive";
}

const REVIEWER_LOGIN = "emdashbot[bot]";
const PRIOR_FINDINGS_MAX_CHARS = 30_000;
const PRIOR_COMMENT_MAX_BYTES = 4_000;
const REVIEW_COMMENTS_PAGE_SIZE = 100;
const LINE_BREAK = /\r\n|[\n\r\u2028\u2029]/;

interface ReviewComment {
	id?: number;
	in_reply_to_id?: number | null;
	user?: { login?: string } | null;
	author_association?: string | null;
	body?: string;
	path?: string;
	line?: number | null;
	original_line?: number | null;
	created_at?: string;
}

async function fetchNewestReviewComments(
	token: GitHubToken,
	owner: string,
	repo: string,
	prNumber: number,
): Promise<ReviewComment[]> {
	const res = await githubFetch(
		`${GITHUB_API}/repos/${owner}/${repo}/pulls/${prNumber}/comments?sort=created&direction=desc&per_page=${REVIEW_COMMENTS_PAGE_SIZE}`,
		{ headers: installationHeaders(token) },
		token,
	);
	await requireGitHubResponse(res, "list review comments");
	return res.json<ReviewComment[]>();
}

/**
 * Quoted, so a line inside a comment body cannot pass for a reply header of
 * its own.
 */
function quote(text: string, spaces: number): string {
	const pad = " ".repeat(spaces);
	return limitUtf8Text(text.trim(), PRIOR_COMMENT_MAX_BYTES, " … (truncated)")
		.split(LINE_BREAK)
		.map((line) => `${pad}> ${line}`)
		.join("\n");
}

function byCreated(a: ReviewComment, b: ReviewComment): number {
	return (a.created_at ?? "").localeCompare(b.created_at ?? "");
}

function renderPriorFindings(comments: readonly ReviewComment[]): string {
	const findings: ReviewComment[] = [];
	const replies = new Map<number, ReviewComment[]>();
	for (const comment of comments) {
		if (typeof comment.in_reply_to_id === "number") {
			replies.set(comment.in_reply_to_id, [
				...(replies.get(comment.in_reply_to_id) ?? []),
				comment,
			]);
		} else if (comment.user?.login === REVIEWER_LOGIN) {
			findings.push(comment);
		}
	}
	if (findings.length === 0) return "";
	const threads = findings
		.toSorted((a, b) => byCreated(b, a))
		.map((finding) => {
			// GitHub reports `line: null` once a push has changed the code under
			// the comment; `original_line` then numbers an older commit.
			const anchor =
				typeof finding.line === "number"
					? `${finding.path}:${finding.line}`
					: `${finding.path}:${finding.original_line} (outdated: the code under it has changed since)`;
			const lines = [`- \`${anchor}\``, quote(finding.body ?? "", 2)];
			const thread = finding.id === undefined ? [] : (replies.get(finding.id) ?? []);
			for (const reply of thread.toSorted(byCreated)) {
				const author = `${reply.user?.login ?? "unknown"} (${reply.author_association ?? "NONE"})`;
				lines.push(`  - Reply from ${author}:`, quote(reply.body ?? "", 4));
			}
			return lines.join("\n");
		});
	const kept: string[] = [];
	let length = 0;
	for (const thread of threads) {
		length += thread.length + 2;
		if (kept.length > 0 && length > PRIOR_FINDINGS_MAX_CHARS) break;
		kept.push(
			thread.length > PRIOR_FINDINGS_MAX_CHARS
				? `${thread.slice(0, PRIOR_FINDINGS_MAX_CHARS)} … (thread truncated)`
				: thread,
		);
	}
	const omitted =
		kept.length < threads.length || comments.length >= REVIEW_COMMENTS_PAGE_SIZE
			? "\n\n(older findings omitted)"
			: "";
	return `\n\n### Your inline findings, newest first, with the replies to each\n\n${kept.join("\n\n")}${omitted}`;
}

/**
 * Fetch the most recent emdashbot[bot] review body, plus the bot's inline
 * findings and the replies to them, for a re-review, so the agent can avoid
 * re-flagging findings that were addressed or answered. Returns undefined on a
 * first review or when the reviews can't be read (non-fatal: we just review
 * fresh); unreadable threads only leave the findings out.
 */
export async function fetchPriorReview(
	token: GitHubToken,
	owner: string,
	repo: string,
	prNumber: number,
): Promise<string | undefined> {
	try {
		const res = await coordinatedFetch(
			token,
			`${GITHUB_API}/repos/${owner}/${repo}/pulls/${prNumber}/reviews?per_page=100`,
			{
				headers: {
					authorization: `Bearer ${tokenValue(token)}`,
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
			.filter((r) => r.user?.login === REVIEWER_LOGIN && r.body)
			.toSorted((a, b) => (a.submitted_at ?? "").localeCompare(b.submitted_at ?? ""));
		const latest = ours.at(-1);
		if (!latest) return undefined;
		const findings = await fetchNewestReviewComments(token, owner, repo, prNumber).then(
			renderPriorFindings,
			() => "",
		);
		return `Your previous review (state: ${latest.state ?? "unknown"}):\n\n${latest.body}${findings}`;
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
	token: GitHubToken,
	owner: string,
	repo: string,
	prNumber: number,
): Promise<number | undefined> {
	try {
		const res = await coordinatedFetch(
			token,
			`${GITHUB_API}/repos/${owner}/${repo}/issues/${prNumber}/reactions`,
			{
				method: "POST",
				headers: {
					authorization: `Bearer ${tokenValue(token)}`,
					accept: "application/vnd.github+json",
					"content-type": "application/json",
					"user-agent": USER_AGENT,
					"x-github-api-version": "2022-11-28",
				},
				body: JSON.stringify({ content: "eyes" }),
			},
		);
		if (!res.ok) return undefined;
		const json = await res.json<{ id?: number }>();
		return json.id;
	} catch {
		return undefined;
	}
}

/** Remove a previously-added reaction (the in-progress marker). Non-fatal. */
export async function removeReaction(
	token: GitHubToken,
	owner: string,
	repo: string,
	prNumber: number,
	reactionId: number,
): Promise<void> {
	try {
		await coordinatedFetch(
			token,
			`${GITHUB_API}/repos/${owner}/${repo}/issues/${prNumber}/reactions/${reactionId}`,
			{
				method: "DELETE",
				headers: {
					authorization: `Bearer ${tokenValue(token)}`,
					accept: "application/vnd.github+json",
					"user-agent": USER_AGENT,
					"x-github-api-version": "2022-11-28",
				},
			},
		);
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

type ReviewLookup =
	| { status: "present" }
	| { status: "absent" }
	| { status: "unavailable"; error: Error };

const REVIEW_LOOKUP_MAX_PAGES = 10;

async function reviewWasPosted(
	token: GitHubToken,
	owner: string,
	repo: string,
	prNumber: number,
	commitId: string,
	marker: string,
): Promise<ReviewLookup> {
	try {
		for (let page = 1; page <= REVIEW_LOOKUP_MAX_PAGES; page++) {
			const suffix = page === 1 ? "" : `&page=${page}`;
			const res = await coordinatedFetch(
				token,
				`${GITHUB_API}/repos/${owner}/${repo}/pulls/${prNumber}/reviews?per_page=100${suffix}`,
				{ headers: installationHeaders(token) },
			);
			if (!res.ok) {
				return {
					status: "unavailable",
					error: new Error(`review marker inspection failed: ${res.status}`),
				};
			}
			const reviews = await res.json<Array<{ body?: string; commit_id?: string }>>();
			if (
				reviews.some(
					(review) => review.commit_id === commitId && review.body?.includes(marker) === true,
				)
			) {
				return { status: "present" };
			}
			if (reviews.length < 100) return { status: "absent" };
		}
		return {
			status: "unavailable",
			error: new Error(`review marker inspection exceeded ${REVIEW_LOOKUP_MAX_PAGES} pages`),
		};
	} catch (error) {
		return {
			status: "unavailable",
			error: new Error("review marker inspection failed", { cause: error }),
		};
	}
}

/**
 * Post the review. Maps verdict -> review event and findings -> line comments.
 * If GitHub rejects the inline comments (a comment anchors outside the diff),
 * retry body-only with the findings folded into the body so nothing is lost.
 * The body is always non-empty -- GitHub 422s a blank COMMENT review body.
 */
export async function postReview(
	token: GitHubToken,
	owner: string,
	repo: string,
	prNumber: number,
	result: ReviewResult,
	commitId?: string,
	attemptId?: string,
	retryOptions?: ReviewRetryOptions,
): Promise<void> {
	const url = `${GITHUB_API}/repos/${owner}/${repo}/pulls/${prNumber}/reviews`;
	const event =
		retryOptions?.pullRequestAuthorLogin === EMDASH_BOT_LOGIN
			? "COMMENT"
			: verdictToEvent(result.verdict);
	const marker = attemptId ? `<!-- emdash-review-attempt:${attemptId} -->` : undefined;
	const summary = `${result.summary.trim() || FALLBACK_SUMMARY}${marker ? `\n\n${marker}` : ""}`;
	if (commitId && marker) {
		const lookup = await reviewWasPosted(token, owner, repo, prNumber, commitId, marker);
		if (lookup.status === "present") return;
		if (lookup.status === "unavailable") throw lookup.error;
	}
	const withComments = {
		body: summary,
		event,
		...(commitId ? { commit_id: commitId } : {}),
		comments: result.findings.map(findingToComment),
	};
	let res: Response;
	try {
		({ response: res } = await postReviewRequest(url, token, withComments, retryOptions));
	} catch (error) {
		if (commitId && marker) {
			const lookup = await reviewWasPosted(token, owner, repo, prNumber, commitId, marker);
			if (lookup.status === "present") return;
		}
		throw error;
	}
	if (res.ok) return;

	// Most likely cause: a comment anchors to a line outside the diff
	// ("Path could not be resolved"). Fall back to a body-only review that
	// carries the summary AND the findings inline, so the review still lands.
	if (res.status !== 422) {
		if (commitId && marker) {
			const lookup = await reviewWasPosted(token, owner, repo, prNumber, commitId, marker);
			if (lookup.status === "present") return;
		}
		throw new Error(`postReview failed: ${res.status}`);
	}
	const bodyOnly = {
		body: summary + renderFindingsMarkdown(result.findings),
		event,
		...(commitId ? { commit_id: commitId } : {}),
	};
	try {
		({ response: res } = await postReviewRequest(url, token, bodyOnly, retryOptions));
	} catch (error) {
		if (commitId && marker) {
			const lookup = await reviewWasPosted(token, owner, repo, prNumber, commitId, marker);
			if (lookup.status === "present") return;
		}
		throw error;
	}
	if (!res.ok) {
		if (commitId && marker) {
			const lookup = await reviewWasPosted(token, owner, repo, prNumber, commitId, marker);
			if (lookup.status === "present") return;
		}
		throw new Error(`postReview failed after body-only retry: ${res.status}`);
	}
}
