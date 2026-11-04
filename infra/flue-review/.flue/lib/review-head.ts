export interface PullRequestRevision {
	headSha: string;
	baseSha: string;
}

export type ReviewHeadMove = "format_only" | "substantive";

interface ReviewHeadCallbacks<T> {
	review(revision: PullRequestRevision): Promise<T>;
	currentRevision(): Promise<PullRequestRevision>;
	classifyMove(fromHeadSha: string, toHeadSha: string): Promise<ReviewHeadMove>;
	publish(result: T, reviewedRevision: PullRequestRevision): Promise<void>;
}

const MAX_REVIEWED_REVISIONS = 3;

export async function reviewUntilCurrentHead<T>(
	initialRevision: PullRequestRevision,
	callbacks: ReviewHeadCallbacks<T>,
): Promise<T> {
	let revision = initialRevision;

	for (let attempt = 1; attempt <= MAX_REVIEWED_REVISIONS; attempt++) {
		const result = await callbacks.review(revision);
		const current = await callbacks.currentRevision();
		const headUnchanged = current.headSha.toLowerCase() === revision.headSha.toLowerCase();
		const baseUnchanged = current.baseSha.toLowerCase() === revision.baseSha.toLowerCase();
		if (headUnchanged && baseUnchanged) {
			await callbacks.publish(result, revision);
			return result;
		}

		const move = headUnchanged
			? "substantive"
			: await callbacks.classifyMove(revision.headSha, current.headSha);
		if (move === "format_only" && baseUnchanged) {
			await callbacks.publish(result, revision);
			return result;
		}

		revision = current;
	}

	throw new Error(
		`PR head kept changing during review after ${MAX_REVIEWED_REVISIONS} reviewed revisions`,
	);
}
