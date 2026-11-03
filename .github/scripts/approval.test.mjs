import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const workflow = readFileSync(new URL("../workflows/approval.yml", import.meta.url), "utf8");
const script = workflow
	.split("          script: |\n")[1]
	.split("\n")
	.map((line) => line.slice(12))
	.join("\n");
const AsyncFunction = Object.getPrototypeOf(async () => null).constructor;
const execute = new AsyncFunction("github", "context", "core", script);
const checkName = "Human Maintainer approval";

function review(login, state = "APPROVED", commit = "head", type = "User") {
	return {
		user: { login, type },
		state,
		commit_id: commit,
		submitted_at: "2026-10-10T09:00:00Z",
	};
}

function fixture({ reviews = [], files = [], checks = [], draft = false, sweep = false } = {}) {
	const pr = {
		number: 42,
		user: { login: "contributor", type: "User" },
		head: { sha: "head" },
		labels: [],
		draft,
	};
	const state = {
		reviews,
		files: files.map((file) => (typeof file === "string" ? { filename: file } : file)),
		commits: [{ sha: "head", parents: [{ sha: "base" }] }],
		checks: checks.map((check) => ({ name: checkName, ...check })),
		writes: [],
	};
	const github = {
		rest: {
			repos: {
				getContent: async () => ({
					data: {
						type: "file",
						content: Buffer.from(
							"<!-- maintainers:start -->\nhttps://github.com/maintainer-one\nhttps://github.com/maintainer-two\n<!-- maintainers:end -->",
						).toString("base64"),
					},
				}),
			},
			pulls: {
				listReviews: async () => state.reviews,
				listCommits: async () => state.commits,
				listFiles: async () => state.files,
				list: async () => [pr],
			},
			checks: {
				listForRef: async () => ({ data: { check_runs: structuredClone(state.checks) } }),
				update: async (params) => {
					state.writes.push(params);
					const check = state.checks.find((item) => item.id === params.check_run_id);
					assert.ok(check, "updated check must exist");
					Object.assign(check, params);
				},
				create: async (params) => {
					state.writes.push(params);
					state.checks.unshift({ id: state.checks.length + 100, ...params });
				},
			},
			issues: {
				addLabels: async ({ labels }) => {
					pr.labels.push(...labels.map((name) => ({ name })));
				},
				removeLabel: async ({ name }) => {
					pr.labels = pr.labels.filter((label) => label.name !== name);
				},
			},
		},
		paginate: async (method, params) => {
			const result = await method(params);
			return Array.isArray(result) ? result : result.data.check_runs;
		},
	};
	const context = {
		repo: { owner: "emdash-cms", repo: "emdash" },
		serverUrl: "https://github.com",
		runId: 123,
		payload: sweep ? {} : { pull_request: pr },
	};
	const core = {
		info: () => null,
		notice: () => null,
		warning: (message) => assert.fail(message),
		setFailed: (message) => assert.fail(message),
	};
	return { state, pr, run: () => execute(github, context, core) };
}

function assertStatus(test, conclusion, label) {
	assert.equal(test.state.checks[0].status, "completed");
	assert.equal(test.state.checks[0].conclusion, conclusion);
	assert.deepEqual(
		test.pr.labels.map((item) => item.name),
		label ? [label] : [],
	);
	assert.ok(test.state.writes.every((write) => write.status === "completed"));
}

function workflowEdit(filename, line) {
	return {
		filename,
		status: "modified",
		patch: `@@ -40,2 +40,3 @@ jobs:\n       - run: pnpm build\n${line}`,
	};
}

async function assertNeedsTwo(files) {
	const test = fixture({ reviews: [review("maintainer-one")], files });
	await test.run();
	assertStatus(test, "neutral", "review/needs-review");
	assert.ok(test.state.checks[0].output.summary.includes("require 2"));
}

describe("Maintainer review status", () => {
	it("finishes neutrally when no human Maintainer has approved", async () => {
		const test = fixture({ reviews: [review("emdashbot[bot]", "APPROVED", "head", "Bot")] });
		await test.run();
		assertStatus(test, "neutral", "review/needs-review");
		assert.ok(test.state.checks[0].output.summary.includes("found 0"));
	});

	it("reports success when the current revision has enough human approval", async () => {
		const test = fixture({ reviews: [review("maintainer-one")] });
		await test.run();
		assertStatus(test, "success", "review/approved");
	});

	it("needs two distinct Maintainers for privileged changes", async () => {
		const test = fixture({
			reviews: [review("maintainer-one")],
			files: [".github/workflows/approval.yml"],
		});
		await test.run();
		assertStatus(test, "neutral", "review/needs-review");
		assert.ok(test.state.checks[0].output.summary.includes("found 1"));
		test.state.reviews.push(review("maintainer-two"));
		await test.run();
		assertStatus(test, "success", "review/approved");
		assert.equal(test.state.checks.length, 1);
	});

	it("needs one approval for edits to read-only workflows and their scripts", async () => {
		const test = fixture({
			reviews: [review("maintainer-one")],
			files: [
				workflowEdit(".github/workflows/ci.yml", "+      - run: pnpm test"),
				workflowEdit(".github/workflows/visual.yml", "-      - run: pnpm test:e2e"),
				{ filename: ".github/scripts/test-plan.mjs", status: "modified" },
			],
		});
		await test.run();
		assertStatus(test, "success", "review/approved");
	});

	for (const [change, line] of [
		["adds a write permission", "+  contents: write"],
		["requests an OIDC token", "+      id-token: write"],
		["uses a secret", "+          TOKEN: ${{ secrets.APP_PRIVATE_KEY }}"],
		["uses a secret in capitals", "+          TOKEN: ${{ SECRETS.APP_PRIVATE_KEY }}"],
		["spells a secret with a YAML escape", '+          TOKEN: "${{ \\x73ecrets.APP_ID }}"'],
		["removes its permissions", "-permissions:"],
		["adds a pull_request_target trigger", "+  pull_request_target:"],
		["adds a workflow_run trigger", "+  workflow_run:"],
		["adds an issue_comment trigger", "+  issue_comment:"],
	]) {
		it(`keeps two approvals when an edit to a read-only workflow ${change}`, async () => {
			await assertNeedsTwo([workflowEdit(".github/workflows/ci.yml", line)]);
		});
	}

	for (const { change, files } of [
		{
			change: "adds a workflow under a read-only workflow's name",
			files: [{ filename: ".github/workflows/ci.yml", status: "added", patch: "+name: CI" }],
		},
		{
			change: "renames a workflow to a read-only workflow's name",
			files: [
				{
					...workflowEdit(".github/workflows/ci.yml", "+      - run: pnpm test"),
					previous_filename: ".github/workflows/release.yml",
					status: "renamed",
				},
			],
		},
		{
			change: "deletes the test-plan script",
			files: [{ filename: ".github/scripts/test-plan.mjs", status: "removed" }],
		},
		{
			change: "also edits a privileged workflow",
			files: [
				workflowEdit(".github/workflows/ci.yml", "+      - run: pnpm test"),
				workflowEdit(".github/workflows/release.yml", "+      - run: pnpm test"),
			],
		},
		{
			change: "edits a read-only workflow so much that GitHub sends no patch",
			files: [{ filename: ".github/workflows/ci.yml", status: "modified" }],
		},
	]) {
		it(`keeps two approvals when a change ${change}`, async () => {
			await assertNeedsTwo(files);
		});
	}

	it("reports change requests neutrally rather than leaving a running check", async () => {
		const test = fixture({ reviews: [review("maintainer-one", "CHANGES_REQUESTED")] });
		await test.run();
		assertStatus(test, "neutral", "review/awaiting-author");
		assert.ok(test.state.checks[0].output.summary.includes("maintainer-one"));
	});

	it("updates a successful check to neutral when substantive code changes", async () => {
		const test = fixture({ reviews: [review("maintainer-one")] });
		await test.run();
		assertStatus(test, "success", "review/approved");
		test.state.commits.unshift({ sha: "reviewed", parents: [{ sha: "base" }] });
		test.state.reviews[0].commit_id = "reviewed";
		await test.run();
		assertStatus(test, "neutral", "review/needs-rereview");
		assert.equal(test.state.checks.length, 1);
	});

	it("preserves approval after a merge-only main update", async () => {
		const test = fixture({ reviews: [review("maintainer-one", "APPROVED", "reviewed")] });
		test.state.commits = [
			{ sha: "reviewed", parents: [{ sha: "base" }] },
			{ sha: "head", parents: [{ sha: "reviewed" }, { sha: "main" }] },
		];
		await test.run();
		assertStatus(test, "success", "review/approved");
	});

	it("finishes all legacy running checks during a sweep", async () => {
		const test = fixture({
			sweep: true,
			checks: [
				{ id: 2, status: "in_progress" },
				{ id: 1, status: "in_progress" },
			],
		});
		await test.run();
		assertStatus(test, "neutral", "review/needs-review");
		assert.ok(test.state.checks.every((check) => check.status === "completed"));
		assert.equal(test.state.checks.length, 2);
	});

	it("finishes a legacy running check and clears review labels on a draft", async () => {
		const test = fixture({ draft: true, checks: [{ id: 1, status: "in_progress" }] });
		test.pr.labels = [{ name: "review/needs-review" }];
		await test.run();
		assertStatus(test, "neutral", null);
		assert.ok(test.state.checks[0].output.title.includes("Draft"));
	});
});
