import type { NormalizedModerationFinding } from "@emdash-cms/registry-moderation";

import type { ModerationLinkField, ModerationTextField } from "../assessment/canonical.js";

export const AI_ADAPTER_VERSION = "listing-metadata-ai-v1";

export interface ExactAssessmentSubject {
	uri: string;
	cid: string;
	kind: "profile" | "release";
}

export interface TextModerationRequest {
	subject: ExactAssessmentSubject;
	text: readonly ModerationTextField[];
	links: readonly ModerationLinkField[];
}

export interface ImageModerationRequest {
	subject: ExactAssessmentSubject & { kind: "release" };
	evidenceRef: string;
	mimeType: "image/gif" | "image/jpeg" | "image/png" | "image/webp";
	bytes: Uint8Array;
}

export interface ModerationModelIdentity {
	adapterVersion: string;
	modelId: string;
	promptVersion: string;
	promptHash: string;
	parameters: Readonly<Record<string, number | string | boolean>>;
}

export interface ModerationUsage {
	inputTokens?: number;
	outputTokens?: number;
	totalTokens?: number;
	configuredUnits?: number;
}

export interface ModerationInferenceResult {
	findings: readonly NormalizedModerationFinding[];
	coveredEvidenceRefs: readonly string[];
	identity: ModerationModelIdentity;
	latencyMs: number;
	usage: ModerationUsage;
}

export interface TextModerationAdapter {
	readonly identity: ModerationModelIdentity;
	moderate(request: TextModerationRequest): Promise<ModerationInferenceResult>;
}

export interface ImageModerationAdapter {
	readonly identity: ModerationModelIdentity;
	moderate(request: ImageModerationRequest): Promise<ModerationInferenceResult>;
}

export type ModelOutputErrorCode =
	| "invalid-json"
	| "invalid-schema"
	| "unknown-evidence"
	| "missing-evidence"
	| "contradictory-output";

export class ModelOutputError extends Error {
	override readonly name = "ModelOutputError";

	constructor(
		readonly code: ModelOutputErrorCode,
		message: string,
	) {
		super(message);
	}
}
