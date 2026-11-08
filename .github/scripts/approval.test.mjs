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

const governance = `### Project Lead

<!-- project-lead:start -->
- [Lead](https://github.com/project-lead)
<!-- project-lead:end -->

<!-- maintainers:start -->
https://github.com/project-lead
https://github.com/maintainer-one
https://github.com/maintainer-two
<!-- maintainers:end -->`;

function rfc({ authors = ["contributor"], sponsor = "maintainer-one", type = "rfc" } = {}) {
	return [
		"---",
		"title: Example",
		`type: ${type}`,
		"status: proposed",
		"authors:",
		...authors.map((author) => `  - Name (@${author})`),
		`champion: Name (@${authors[0]})`,
		`sponsor: ${sponsor ? `Name (@${sponsor})` : "null"}`,
		"---",
		"",
		"# Example",
	].join("\n");
}

const indexRow = {
	filename: "proposals/README.md",
	patch: "@@ -1,2 +1,3 @@\n | a | b |\n+| [Example](example.md) | RFC | | |",
};

function fixture({
	reviews = [],
	files = [],
	checks = [],
	draft = false,
	sweep = false,
	title = "fix: example",
	opener = "contributor",
	proposals = {},
} = {}) {
	const pr = {
		number: 42,
		title,
		body: "",
		user: { login: opener, type: "User" },
		head: { sha: "head" },
		labels: [],
		draft,
	};
	const state = {
		reviews,
		files: files.map((file) => (typeof file === "string" ? { filename: file } : file)),
		commits: [{ sha: "head", parents: [{ sha: "base" }] }],
		checks: checks.map((check) => ({ name: checkName, ...check })),
		comments: [],
		commentWrites: 0,
		writes: [],
	};
	const github = {
		rest: {
			repos: {
				getContent: async ({ path, ref }) => {
					const text = path === "GOVERNANCE.md" ? governance : proposals[path];
					assert.ok(text !== undefined, `unexpected read of ${path}`);
					if (path !== "GOVERNANCE.md") assert.equal(ref, "head");
					return { data: { type: "file", content: Buffer.from(text).toString("base64") } };
				},
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
				listComments: async () => structuredClone(state.comments),
				createComment: async ({ body }) => {
					state.commentWrites += 1;
					state.comments.push({
						id: state.comments.length + 1,
						user: { login: "github-actions[bot]" },
						body,
					});
				},
				deleteComment: async ({ comment_id }) => {
					state.commentWrites += 1;
					state.comments = state.comments.filter((comment) => comment.id !== comment_id);
				},
				updateComment: async ({ comment_id, body }) => {
					state.commentWrites += 1;
					state.comments.find((comment) => comment.id === comment_id).body = body;
				},
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

describe("Design pull request review status", () => {
	function design(options) {
		return fixture({
			title: "design: example",
			files: ["proposals/example.md", indexRow],
			...options,
			proposals: { "proposals/example.md": rfc(), ...options?.proposals },
		});
	}

	it("accepts an RFC with sponsor, supporter, and Project Lead approval", async () => {
		const test = design({ reviews: [review("maintainer-one"), review("project-lead")] });
		await test.run();
		assertStatus(test, "success", "review/approved");
	});

	it("waits for the Project Lead to accept an RFC", async () => {
		const test = design({ reviews: [review("maintainer-one"), review("maintainer-two")] });
		await test.run();
		assertStatus(test, "neutral", "review/needs-review");
		assert.ok(test.state.checks[0].output.summary.includes("@project-lead has not accepted"));
	});

	it("needs an RFC supporter other than the Project Lead", async () => {
		const test = design({
			reviews: [review("project-lead")],
			proposals: { "proposals/example.md": rfc({ sponsor: "project-lead" }) },
		});
		await test.run();
		assertStatus(test, "neutral", "review/needs-review");
		assert.ok(
			test.state.checks[0].output.summary.includes(
				"❌ Support from a Maintainer other than the author and the Project Lead",
			),
		);
	});

	it("needs the RFC sponsor to approve", async () => {
		const test = design({ reviews: [review("maintainer-two"), review("project-lead")] });
		await test.run();
		assertStatus(test, "neutral", "review/needs-review");
		assert.ok(test.state.checks[0].output.summary.includes("@maintainer-one has not approved"));
	});

	it("needs the RFC sponsor to be a Maintainer", async () => {
		const test = design({
			reviews: [review("maintainer-one"), review("project-lead")],
			proposals: { "proposals/example.md": rfc({ sponsor: "contributor" }) },
		});
		await test.run();
		assertStatus(test, "neutral", "review/needs-review");
		assert.ok(test.state.checks[0].output.summary.includes("found `@contributor`"));
	});

	it("lets a Maintainer sponsor their own RFC with one other supporter", async () => {
		const test = design({
			opener: "maintainer-one",
			reviews: [review("project-lead")],
			proposals: { "proposals/example.md": rfc({ authors: ["maintainer-one"] }) },
		});
		await test.run();
		assertStatus(test, "neutral", "review/needs-review");
		assert.ok(
			test.state.checks[0].output.summary.includes(
				"✅ The RFC sponsor `@maintainer-one` opened this pull request.",
			),
		);
		test.state.reviews.push(review("maintainer-two"));
		await test.run();
		assertStatus(test, "success", "review/approved");
	});

	it("counts the Project Lead opening an RFC as acceptance", async () => {
		const test = design({
			opener: "project-lead",
			reviews: [review("maintainer-one")],
			proposals: { "proposals/example.md": rfc({ authors: ["project-lead"] }) },
		});
		await test.run();
		assertStatus(test, "success", "review/approved");
	});

	it("does not count a listed author's approval as support", async () => {
		const test = design({
			reviews: [review("maintainer-one"), review("project-lead")],
			proposals: {
				"proposals/example.md": rfc({ authors: ["contributor", "maintainer-one"] }),
			},
		});
		await test.run();
		assertStatus(test, "neutral", "review/needs-review");
		assert.ok(
			test.state.checks[0].output.summary.includes(
				"❌ Support from a Maintainer other than the author and the Project Lead",
			),
		);
	});

	it("accepts a feature plan with one approval from a non-author", async () => {
		const plan = "---\ntype: feature-plan\nauthors:\n  - Name (@maintainer-two)\n---\n";
		const test = design({
			reviews: [review("maintainer-two")],
			proposals: { "proposals/example.md": plan },
		});
		await test.run();
		assertStatus(test, "neutral", "review/needs-review");
		test.state.reviews.push(review("maintainer-one"));
		await test.run();
		assertStatus(test, "success", "review/approved");
	});

	it("needs two approvals when a design PR changes proposal policy text", async () => {
		const plan = "---\ntype: feature-plan\nauthors:\n  - Name (@contributor)\n---\n";
		const test = design({
			reviews: [review("maintainer-one")],
			files: [
				"proposals/example.md",
				{
					filename: "proposals/README.md",
					patch: "@@ -1 +1 @@\n-An RFC requires:\n+An RFC needs:",
				},
			],
			proposals: { "proposals/example.md": plan },
		});
		await test.run();
		assertStatus(test, "neutral", "review/needs-review");
		assert.ok(test.state.checks[0].output.summary.includes("❌ 2 human Maintainer approvals"));
	});

	it("needs one approval when a design PR only adds a proposal index row", async () => {
		const plan = "---\ntype: feature-plan\nauthors:\n  - Name (@contributor)\n---\n";
		const test = design({
			reviews: [review("maintainer-one")],
			proposals: { "proposals/example.md": plan },
		});
		await test.run();
		assertStatus(test, "success", "review/approved");
	});

	it("ignores proposal front matter outside design PRs", async () => {
		const test = fixture({
			files: ["proposals/example.md"],
			reviews: [review("maintainer-one")],
		});
		await test.run();
		assertStatus(test, "success", "review/approved");
	});

	it("keeps one status comment up to date on a design PR", async () => {
		const test = design({ reviews: [review("maintainer-one")] });
		await test.run();
		assert.equal(test.state.comments.length, 1);
		assert.ok(
			test.state.comments[0].body.includes("❌ The Project Lead @project-lead has not accepted"),
		);
		await test.run();
		assert.equal(test.state.commentWrites, 1);
		test.state.reviews.push(review("project-lead"));
		await test.run();
		assert.equal(test.state.comments.length, 1);
		assert.ok(
			test.state.comments[0].body.includes("✅ The Project Lead `@project-lead` has accepted"),
		);
	});
});

describe("Approval status comment", () => {
	it("is posted on privileged PRs", async () => {
		const test = fixture({ files: [".github/workflows/approval.yml"] });
		await test.run();
		assert.equal(test.state.comments.length, 1);
		assert.ok(test.state.comments[0].body.includes("❌ 2 human Maintainer approvals"));
	});

	it("is not posted on normal PRs", async () => {
		const test = fixture({ reviews: [review("maintainer-one")] });
		await test.run();
		assert.equal(test.state.comments.length, 0);
	});

	it("updates an existing comment when the PR returns to draft, without creating one", async () => {
		const test = fixture({ files: [".github/workflows/approval.yml"] });
		await test.run();
		test.pr.draft = true;
		await test.run();
		assert.equal(test.state.comments.length, 1);
		assert.ok(test.state.comments[0].body.includes("This pull request is a draft."));

		const fresh = fixture({ draft: true, files: [".github/workflows/approval.yml"] });
		await fresh.run();
		assert.equal(fresh.state.comments.length, 0);
	});

	it("is removed when the PR no longer needs it", async () => {
		const test = fixture({ files: [".github/workflows/approval.yml"] });
		await test.run();
		assert.equal(test.state.comments.length, 1);
		test.state.files = [{ filename: "packages/core/src/index.ts" }];
		await test.run();
		assert.equal(test.state.comments.length, 0);
	});
});

describe("Proposal front matter", () => {
	for (const type of ['"rfc"', "'rfc'", "rfc # architectural change"]) {
		it(`applies RFC rules when the type is written as ${type}`, async () => {
			const test = fixture({
				title: "design: example",
				files: ["proposals/example.md"],
				reviews: [review("maintainer-two")],
				proposals: { "proposals/example.md": rfc({ type }) },
			});
			await test.run();
			assertStatus(test, "neutral", "review/needs-review");
			assert.ok(test.state.checks[0].output.summary.includes("@project-lead has not accepted"));
		});
	}

	it("does not pass a proposal with an unknown type", async () => {
		const test = fixture({
			title: "design: example",
			files: ["proposals/example.md"],
			reviews: [review("maintainer-one"), review("project-lead")],
			proposals: { "proposals/example.md": rfc({ type: "rfcc" }) },
		});
		await test.run();
		assertStatus(test, "neutral", "review/needs-review");
		assert.ok(test.state.checks[0].output.summary.includes("found `rfcc`"));
	});
});
