export interface CandidatePublication {
	readonly branch: string;
	readonly commitSha: string;
	readonly files: string[];
}

export function requireCandidatePublication(
	claimed: boolean,
	publication: CandidatePublication | null,
): void {
	if (claimed && !publication) {
		throw new Error("publish_candidate must complete before reporting a published change");
	}
}
