export type GitTreeMode = "100644" | "100755" | "120000";

export interface CandidateChange {
	readonly path: string;
	readonly mode: GitTreeMode;
	/** Null deletes the path from the candidate tree. */
	readonly content: Uint8Array | null;
}

export interface CandidateSnapshot {
	readonly baseCommitSha: string;
	readonly treeSha: string;
	readonly changes: readonly CandidateChange[];
}

export interface CandidateGitHub {
	getBranchSha(branch: string): Promise<string | null>;
	getCommit(sha: string): Promise<{ treeSha: string; message: string }>;
	createBlob(content: Uint8Array): Promise<string>;
	createTree(baseTreeSha: string, entries: readonly GitTreeEntry[]): Promise<string>;
	createCommit(message: string, treeSha: string, parentSha: string): Promise<string>;
	createBranch(branch: string, commitSha: string): Promise<void>;
	updateBranch(branch: string, commitSha: string): Promise<void>;
}

export interface GitTreeEntry {
	readonly path: string;
	readonly mode: GitTreeMode;
	readonly type: "blob";
	readonly sha: string | null;
}

export interface CandidatePublication {
	readonly branch: string;
	readonly commitSha: string;
	readonly files: string[];
}

export interface PublishCandidateInput {
	readonly branch: string;
	readonly runId: string;
	readonly commitMessage: string;
	readonly expectedPreviousSha: string | null;
	readonly snapshot: CandidateSnapshot;
}

export function requireCandidatePublication(
	claimed: boolean,
	publication: CandidatePublication | null,
): void {
	if (claimed && !publication) {
		throw new Error("publish_candidate must complete before reporting a published change");
	}
}

export async function publishCandidate(
	input: PublishCandidateInput,
	github: CandidateGitHub,
): Promise<CandidatePublication> {
	if (input.snapshot.changes.length === 0) throw new Error("candidate has no changes to publish");
	const files = input.snapshot.changes.map((change) => change.path);
	const runMarker = `EmDash-Run: ${input.runId}`;
	const liveBefore = await github.getBranchSha(input.branch);
	if (liveBefore !== input.expectedPreviousSha) {
		if (liveBefore) {
			const liveCommit = await github.getCommit(liveBefore);
			if (liveCommit.message.includes(runMarker)) {
				return { branch: input.branch, commitSha: liveBefore, files };
			}
		}
		throw new Error(
			`candidate branch changed since this run started (expected ${input.expectedPreviousSha ?? "absent"}, found ${liveBefore ?? "absent"})`,
		);
	}

	const baseCommit = await github.getCommit(input.snapshot.baseCommitSha);
	const entries: GitTreeEntry[] = [];
	for (const change of input.snapshot.changes) {
		entries.push({
			path: change.path,
			mode: change.mode,
			type: "blob",
			sha: change.content === null ? null : await github.createBlob(change.content),
		});
	}
	const treeSha = await github.createTree(baseCommit.treeSha, entries);
	if (treeSha !== input.snapshot.treeSha) {
		throw new Error(
			`GitHub created tree ${treeSha}, which does not match the verified candidate ${input.snapshot.treeSha}`,
		);
	}
	const message = `${input.commitMessage.trim()}\n\n${runMarker}`;
	const parentSha = input.expectedPreviousSha ?? input.snapshot.baseCommitSha;
	const commitSha = await github.createCommit(message, treeSha, parentSha);

	const liveAtUpdate = await github.getBranchSha(input.branch);
	if (liveAtUpdate !== input.expectedPreviousSha) {
		throw new Error("candidate branch changed while the publication was being prepared");
	}
	if (liveAtUpdate === null) await github.createBranch(input.branch, commitSha);
	else await github.updateBranch(input.branch, commitSha);

	const publishedSha = await github.getBranchSha(input.branch);
	if (publishedSha !== commitSha) {
		throw new Error(
			`candidate branch verification failed (expected ${commitSha}, found ${publishedSha ?? "absent"})`,
		);
	}
	return { branch: input.branch, commitSha, files };
}
