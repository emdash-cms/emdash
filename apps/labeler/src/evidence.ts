export type FindingSeverity = "critical" | "high" | "medium" | "low" | "info";

/**
 * The public shape a finding may be serialized to. `privateDetail` and
 * `evidenceRefs` are typed `never` here (not omitted) so that a
 * `PrivateFindingRecord` — which types those fields as `string` /
 * `readonly string[]` — is not structurally assignable to this type. Passing
 * a private record straight into `serializePublicFinding` is a compile error,
 * not just a convention.
 */
export interface PublicFindingView {
	id: string;
	assessmentId: string;
	category: string;
	severity: FindingSeverity;
	title: string;
	publicSummary: string;
	privateDetail?: never;
	evidenceRefs?: never;
}

export interface PrivateFindingRecord {
	id: string;
	assessmentId: string;
	category: string;
	severity: FindingSeverity;
	title: string;
	publicSummary: string;
	privateDetail: string;
	evidenceRefs: readonly string[];
}

export interface PublicFindingPayload {
	id: string;
	category: string;
	severity: FindingSeverity;
	title: string;
	summary: string;
}

/** Strips private fields at runtime; the only supported path from stored evidence to the public API. */
export function toPublicFinding(record: PrivateFindingRecord): PublicFindingView {
	return {
		id: record.id,
		assessmentId: record.assessmentId,
		category: record.category,
		severity: record.severity,
		title: record.title,
		publicSummary: record.publicSummary,
	};
}

export function serializePublicFinding(finding: PublicFindingView): PublicFindingPayload {
	return {
		id: finding.id,
		category: finding.category,
		severity: finding.severity,
		title: finding.title,
		summary: finding.publicSummary,
	};
}
