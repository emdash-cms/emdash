export type AssessmentSubjectKind = "profile" | "release";

export interface AssessmentSubject {
	uri: string;
	cid: string;
	kind: AssessmentSubjectKind;
}

export interface AssessmentVersionSet {
	policyVersion: string;
	parserVersion: string;
	textModelId: string;
	textPromptHash: string;
	imageModelId: string;
	imagePromptHash: string;
}

export interface AssessmentWorkflowParams {
	runKey: string;
	subjectUri: string;
	subjectCid: string;
	subjectKind: AssessmentSubjectKind;
	policyVersion?: string;
	parserVersion?: string;
	textModelId?: string;
	textPromptHash?: string;
	imageModelId?: string;
	imagePromptHash?: string;
	logicalTriggerId?: string;
}

export interface AssessmentWorkflowResult {
	runKey: string;
	status: "prepared" | "passed" | "review" | "error" | "cancelled";
	moderationFingerprint?: string;
	mediaCount?: number;
}

export type AssessmentRunState =
	| "pending"
	| "running"
	| "review"
	| "passed"
	| "blocked"
	| "error"
	| "superseded"
	| "cancelled";

export interface AssessmentRunSnapshot {
	runKey: string;
	subject: AssessmentSubject;
	state: AssessmentRunState;
	stateVersion: number;
	deleted: boolean;
}
