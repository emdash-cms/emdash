import type { ModerationModelIdentity } from "../src/ai/types.js";
import baseline from "./recordings/v1/baseline.json";
import type { EvalRecording } from "./types.js";

export interface RecordedEvalBaseline {
	textIdentity: ModerationModelIdentity;
	imageIdentity: ModerationModelIdentity;
	recordings: Readonly<Record<string, EvalRecording>>;
}

export function loadRecordedBaseline(): RecordedEvalBaseline {
	const identity = baseline.modelIdentity;
	const parameters = { ...identity.parameters };
	return {
		textIdentity: {
			adapterVersion: identity.adapterVersion,
			modelId: identity.textModelId,
			promptVersion: identity.textPromptVersion,
			promptHash: identity.textPromptHash,
			parameters,
		},
		imageIdentity: {
			adapterVersion: identity.adapterVersion,
			modelId: identity.imageModelId,
			promptVersion: identity.imagePromptVersion,
			promptHash: identity.imagePromptHash,
			parameters,
		},
		recordings: Object.fromEntries(
			Object.entries(baseline.cases).map(([id, recording]) => [
				id,
				{
					output: recording.output,
					latencyMs: recording.latencyMs,
					usage: recording.usage,
				},
			]),
		),
	};
}
