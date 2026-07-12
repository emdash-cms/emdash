export type AssessmentState =
	| "observed"
	| "verifying"
	| "pending"
	| "running"
	| "passed"
	| "warned"
	| "blocked"
	| "error"
	| "stale"
	| "cancelled";

/** States a completed finalization can move `current_assessments` toward (spec §10). */
export const CURRENT_POINTER_STATES: ReadonlySet<AssessmentState> = new Set([
	"passed",
	"warned",
	"blocked",
]);

export const TERMINAL_STATES: ReadonlySet<AssessmentState> = new Set([
	"passed",
	"warned",
	"blocked",
	"error",
	"stale",
	"cancelled",
]);

const LEGAL_TRANSITIONS: Readonly<Record<AssessmentState, ReadonlySet<AssessmentState>>> = {
	observed: new Set(["verifying", "stale", "cancelled"]),
	verifying: new Set(["pending", "stale", "cancelled"]),
	pending: new Set(["running", "stale", "cancelled"]),
	running: new Set(["passed", "warned", "blocked", "error", "stale", "cancelled"]),
	passed: new Set(),
	warned: new Set(),
	blocked: new Set(),
	error: new Set(),
	stale: new Set(),
	cancelled: new Set(),
};

export function isLegalTransition(from: AssessmentState, to: AssessmentState): boolean {
	return LEGAL_TRANSITIONS[from].has(to);
}

export class AssessmentTransitionConflictError extends Error {
	constructor(
		public readonly assessmentId: string,
		public readonly expectedState: AssessmentState,
		public readonly attemptedState: AssessmentState,
		public readonly actualState: AssessmentState | null,
	) {
		super(
			`assessment ${assessmentId} could not transition ${expectedState} -> ${attemptedState}` +
				(actualState === null ? " (assessment not found)" : ` (actual state is ${actualState})`),
		);
	}
}

export function initialTriggerId(cid: string): string {
	return `initial:${cid}`;
}

export function intelTriggerId(corpusRevision: string): string {
	return `intel:${corpusRevision}`;
}

export function operatorTriggerId(actionId: string): string {
	return `operator:${actionId}`;
}

export interface RunKeyInput {
	uri: string;
	cid: string;
	policyVersion: string;
	modelId: string;
	promptHash: string;
	scannerSetVersion: string;
	triggerId: string;
}

/** Deterministic run identity per spec §9.2: redelivery observes the same run. */
export async function computeRunKey(input: RunKeyInput): Promise<string> {
	const material = [
		input.uri,
		input.cid,
		input.policyVersion,
		input.modelId,
		input.promptHash,
		input.scannerSetVersion,
		input.triggerId,
	].join("\n");
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(material));
	return toHex(new Uint8Array(digest));
}

/** Deterministic idempotency key for an automated label issuance action. */
export function automatedIdempotencyKey(runKey: string, val: string, neg: boolean): string {
	return `${runKey}:${val}:${neg ? "neg" : "pos"}`;
}

function toHex(bytes: Uint8Array): string {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
