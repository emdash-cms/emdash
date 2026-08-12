import { describe, expect, test, vi } from "vitest";

import {
	publishCandidate,
	requireCandidatePublication,
	type CandidateGitHub,
} from "../../.flue/lib/candidate-publisher.js";

function fakeGitHub(overrides: Partial<CandidateGitHub> = {}): CandidateGitHub {
	return {
		getBranchSha: vi.fn(async () => null),
		getCommit: vi.fn(async () => ({ treeSha: "base-tree", message: "base" })),
		createBlob: vi.fn(async (_content: Uint8Array) => "blob-sha"),
		createTree: vi.fn(async () => "tree-sha"),
		createCommit: vi.fn(async () => "commit-sha"),
		createBranch: vi.fn(async () => {}),
		updateBranch: vi.fn(async () => {}),
		...overrides,
	};
}

describe("publishCandidate", () => {
	test("requires a completed publication before a model can claim delivery", () => {
		expect(() => requireCandidatePublication(true, null)).toThrow(/publish_candidate/);
		expect(() => requireCandidatePublication(false, null)).not.toThrow();
		expect(() =>
			requireCandidatePublication(true, {
				branch: "bot/fix-1",
				commitSha: "sha",
				files: ["x.ts"],
			}),
		).not.toThrow();
	});

	test("creates and verifies an issue-scoped candidate branch", async () => {
		const getBranchSha = vi
			.fn<() => Promise<string | null>>()
			.mockResolvedValueOnce(null)
			.mockResolvedValueOnce(null)
			.mockResolvedValueOnce("commit-sha");
		const github = fakeGitHub({ getBranchSha });

		const result = await publishCandidate(
			{
				branch: "bot/fix-2299",
				runId: "run-123",
				commitMessage: "Fix the CLI",
				expectedPreviousSha: null,
				snapshot: {
					baseCommitSha: "base-commit",
					treeSha: "tree-sha",
					changes: [
						{
							path: "src/index.ts",
							mode: "100644",
							content: new TextEncoder().encode("export {};\n"),
						},
					],
				},
			},
			github,
		);

		expect(result).toEqual({
			branch: "bot/fix-2299",
			commitSha: "commit-sha",
			files: ["src/index.ts"],
		});
		expect(github.createTree).toHaveBeenCalledWith("base-tree", [
			{ path: "src/index.ts", mode: "100644", type: "blob", sha: "blob-sha" },
		]);
		expect(github.createCommit).toHaveBeenCalledWith(
			expect.stringContaining("EmDash-Run: run-123"),
			"tree-sha",
			"base-commit",
		);
		expect(github.createBranch).toHaveBeenCalledWith("bot/fix-2299", "commit-sha");
	});

	test("refuses to overwrite a branch that changed after the run started", async () => {
		const github = fakeGitHub({ getBranchSha: vi.fn(async () => "someone-elses-commit") });

		await expect(
			publishCandidate(
				{
					branch: "bot/fix-42",
					runId: "run-42",
					commitMessage: "Change",
					expectedPreviousSha: "expected",
					snapshot: {
						baseCommitSha: "base",
						treeSha: "tree-sha",
						changes: [{ path: "x.ts", mode: "100644", content: new Uint8Array([1]) }],
					},
				},
				github,
			),
		).rejects.toThrow(/changed since this run started/);
		expect(github.createBlob).not.toHaveBeenCalled();
	});

	test("treats a repeated run marker as an idempotent successful publication", async () => {
		const github = fakeGitHub({
			getBranchSha: vi.fn(async () => "already-published"),
			getCommit: vi.fn(async () => ({
				treeSha: "tree",
				message: "Change\n\nEmDash-Run: run-42",
			})),
		});

		await expect(
			publishCandidate(
				{
					branch: "bot/fix-42",
					runId: "run-42",
					commitMessage: "Change",
					expectedPreviousSha: null,
					snapshot: {
						baseCommitSha: "base",
						treeSha: "tree-sha",
						changes: [{ path: "x.ts", mode: "100644", content: new Uint8Array([1]) }],
					},
				},
				github,
			),
		).resolves.toEqual({
			branch: "bot/fix-42",
			commitSha: "already-published",
			files: ["x.ts"],
		});
		expect(github.createBlob).not.toHaveBeenCalled();
	});

	test("represents deletions as null tree entries", async () => {
		const getBranchSha = vi
			.fn<() => Promise<string | null>>()
			.mockResolvedValueOnce("old")
			.mockResolvedValueOnce("old")
			.mockResolvedValueOnce("commit-sha");
		const github = fakeGitHub({ getBranchSha });

		await publishCandidate(
			{
				branch: "bot/fix-1",
				runId: "run-1",
				commitMessage: "Delete obsolete file",
				expectedPreviousSha: "old",
				snapshot: {
					baseCommitSha: "old",
					treeSha: "tree-sha",
					changes: [{ path: "obsolete.ts", mode: "100644", content: null }],
				},
			},
			github,
		);

		expect(github.createBlob).not.toHaveBeenCalled();
		expect(github.createTree).toHaveBeenCalledWith("base-tree", [
			{ path: "obsolete.ts", mode: "100644", type: "blob", sha: null },
		]);
		expect(github.updateBranch).toHaveBeenCalledWith("bot/fix-1", "commit-sha");
	});

	test("refuses a GitHub tree that differs from the verified candidate", async () => {
		const github = fakeGitHub();

		await expect(
			publishCandidate(
				{
					branch: "bot/fix-1",
					runId: "run-1",
					commitMessage: "Change candidate",
					expectedPreviousSha: null,
					snapshot: {
						baseCommitSha: "base",
						treeSha: "verified-tree",
						changes: [{ path: "x.ts", mode: "100644", content: new Uint8Array([1]) }],
					},
				},
				github,
			),
		).rejects.toThrow(/tree.*verified candidate/);
		expect(github.createCommit).not.toHaveBeenCalled();
	});

	test("parents an update to the expected branch head so the ref update can be fast-forward-only", async () => {
		const getBranchSha = vi
			.fn<() => Promise<string | null>>()
			.mockResolvedValueOnce("previous-candidate")
			.mockResolvedValueOnce("previous-candidate")
			.mockResolvedValueOnce("commit-sha");
		const github = fakeGitHub({ getBranchSha });

		await publishCandidate(
			{
				branch: "bot/fix-9",
				runId: "run-9",
				commitMessage: "Update candidate",
				expectedPreviousSha: "previous-candidate",
				snapshot: {
					baseCommitSha: "new-main-head",
					treeSha: "tree-sha",
					changes: [{ path: "x.ts", mode: "100644", content: new Uint8Array([1]) }],
				},
			},
			github,
		);

		expect(github.createCommit).toHaveBeenCalledWith(
			expect.any(String),
			"tree-sha",
			"previous-candidate",
		);
	});
});
