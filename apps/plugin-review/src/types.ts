export const REVIEW_CATEGORIES = [
	"malicious-code",
	"vulnerability",
	"reviewer-manipulation",
] as const;
export const SEVERITIES = ["low", "medium", "high", "critical"] as const;

export type ReviewCategory = (typeof REVIEW_CATEGORIES)[number];
export type Severity = (typeof SEVERITIES)[number];

export interface ReviewFile {
	path: string;
	byteLength: number;
	/** Absent for binary files, which the reviewer can see listed but not read. */
	text?: string;
}

export interface PluginReviewRequest {
	model: string;
	subject: { uri: string; cid: string; version: string };
	listing: readonly { ref: string; text: string }[];
	declaredAccess: Record<string, unknown>;
	files: readonly ReviewFile[];
}

export interface Citation {
	file: string;
	line: number;
	quote: string;
}

export interface ReviewFinding {
	category: ReviewCategory;
	severity: Severity;
	confidence: number;
	summary: string;
	evidence: Citation[];
}

export interface PluginReviewResponse {
	model: string;
	promptVersion: string;
	summary: string;
	findings: ReviewFinding[];
	/** The model refused to review the bundle; `summary` carries its stated reason. */
	declined?: true;
}
