// Live cutover smoke for the complete implementation delivery path.
// Use only with a staging worker configured for a disposable repository.

import { createHmac, randomUUID } from "node:crypto";

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_POLL_MS = 15 * 1000;
const TRAILING_SLASH = /\/$/;

function required(name: string): string {
	const value = process.env[name]?.trim();
	if (!value) fail(`missing required env ${name}`);
	return value;
}

function fail(message: string): never {
	console.error(`implementation smoke failed: ${message}`);
	process.exit(1);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

interface Issue {
	number: number;
	state: string;
	user?: { login?: string };
	labels?: Array<{ name?: string }>;
}

interface PullRequest {
	number: number;
	draft: boolean;
	html_url: string;
}

async function github<T>(path: string, token: string): Promise<T> {
	const response = await fetch(`https://api.github.com${path}`, {
		headers: {
			authorization: `Bearer ${token}`,
			accept: "application/vnd.github+json",
			"user-agent": "emdash-bot-implementation-smoke",
			"x-github-api-version": "2022-11-28",
		},
	});
	if (!response.ok)
		fail(`GitHub ${path} returned ${response.status}: ${(await response.text()).slice(0, 500)}`);
	return response.json<T>();
}

async function branchSha(owner: string, repo: string, issueNumber: number, token: string) {
	const response = await fetch(
		`https://api.github.com/repos/${owner}/${repo}/branches/${encodeURIComponent(`bot/fix-${issueNumber}`)}`,
		{
			headers: {
				authorization: `Bearer ${token}`,
				accept: "application/vnd.github+json",
				"user-agent": "emdash-bot-implementation-smoke",
			},
		},
	);
	if (response.status === 404) return null;
	if (!response.ok) fail(`branch lookup returned ${response.status}`);
	const body = await response.json<{ commit?: { sha?: string } }>();
	return body.commit?.sha ?? null;
}

async function postCommand(input: {
	workerUrl: string;
	secret: string;
	issue: Issue;
	body: string;
	actor: string;
}): Promise<void> {
	const payload = JSON.stringify({
		action: "created",
		issue: {
			number: input.issue.number,
			user: input.issue.user,
			labels: input.issue.labels,
		},
		comment: {
			body: input.body,
			author_association: "MEMBER",
			user: { login: input.actor },
		},
		sender: { login: input.actor },
	});
	const signature = createHmac("sha256", input.secret).update(payload).digest("hex");
	const response = await fetch(`${input.workerUrl.replace(TRAILING_SLASH, "")}/webhook/github`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"x-github-event": "issue_comment",
			"x-github-delivery": `implementation-smoke-${randomUUID()}`,
			"x-hub-signature-256": `sha256=${signature}`,
		},
		body: payload,
	});
	if (!response.ok)
		fail(`worker webhook returned ${response.status}: ${(await response.text()).slice(0, 500)}`);
}

async function waitFor<T>(
	description: string,
	timeoutMs: number,
	pollMs: number,
	probe: () => Promise<T | null>,
): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = await probe();
		if (value !== null) return value;
		if (Date.now() >= deadline) fail(`timed out waiting for ${description}`);
		await sleep(pollMs);
	}
}

async function main(): Promise<void> {
	if (process.env.ALLOW_GITHUB_WRITES !== "1") {
		fail("set ALLOW_GITHUB_WRITES=1; this test creates a branch, comments, labels, and a draft PR");
	}
	const workerUrl = required("WORKER_URL");
	const secret = required("ADMIN_TOKEN");
	const githubToken = required("GH_TOKEN");
	const directive = required("DIRECTIVE");
	const actor = required("SMOKE_ACTOR");
	const issueNumber = Number(required("ISSUE_NUMBER"));
	if (!Number.isSafeInteger(issueNumber) || issueNumber <= 0) fail("ISSUE_NUMBER must be positive");
	const [owner, repo] = required("REPO").split("/");
	if (!owner || !repo) fail("REPO must be owner/name");
	if (`${owner}/${repo}` === "emdash-cms/emdash" && process.env.ALLOW_PRODUCTION_REPO !== "1") {
		fail(
			"refusing production repository; use a disposable staging repo or set ALLOW_PRODUCTION_REPO=1",
		);
	}
	const timeoutMs = Number(process.env.TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
	const pollMs = Number(process.env.POLL_MS ?? DEFAULT_POLL_MS);
	const issue = await github<Issue>(`/repos/${owner}/${repo}/issues/${issueNumber}`, githubToken);
	if (issue.state !== "open") fail(`issue #${issueNumber} is not open`);
	const before = await branchSha(owner, repo, issueNumber, githubToken);

	console.log(`dispatching implementation smoke for ${owner}/${repo}#${issueNumber}`);
	await postCommand({ workerUrl, secret, issue, body: `@emdashbot implement ${directive}`, actor });

	const published = await waitFor("candidate branch publication", timeoutMs, pollMs, async () => {
		const sha = await branchSha(owner, repo, issueNumber, githubToken);
		return sha && sha !== before ? sha : null;
	});
	console.log(`candidate published at ${published}`);

	await waitFor("preview-ready state", timeoutMs, pollMs, async () => {
		const current = await github<Issue>(
			`/repos/${owner}/${repo}/issues/${issueNumber}`,
			githubToken,
		);
		return current.labels?.some((label) => label.name === "bot:awaiting-reporter") ? true : null;
	});
	console.log("preview published and reporter confirmation requested");

	await postCommand({ workerUrl, secret, issue, body: "@emdashbot confirm", actor });
	const pull = await waitFor<PullRequest>("draft pull request", timeoutMs, pollMs, async () => {
		const pulls = await github<PullRequest[]>(
			`/repos/${owner}/${repo}/pulls?state=open&head=${encodeURIComponent(`${owner}:bot/fix-${issueNumber}`)}`,
			githubToken,
		);
		return pulls.find((candidate) => candidate.draft) ?? null;
	});
	console.log(`implementation smoke passed: ${pull.html_url}`);
}

await main();
