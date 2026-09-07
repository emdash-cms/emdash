import { parseModerationModelOutput } from "./output.js";
import type {
	ImageModerationAdapter,
	ImageModerationRequest,
	ModerationInferenceResult,
	ModerationModelIdentity,
	ModerationUsage,
	TextModerationAdapter,
	TextModerationRequest,
} from "./types.js";

export interface RecordedModerationOutput {
	response: string;
	latencyMs: number;
	usage?: ModerationUsage;
}

export type RecordedOutputSource = (
	kind: "text" | "image",
	evidenceRefs: readonly string[],
) => RecordedModerationOutput | Promise<RecordedModerationOutput>;

export function createRecordedTextAdapter(
	identity: ModerationModelIdentity,
	read: RecordedOutputSource,
): TextModerationAdapter {
	return {
		identity,
		async moderate(request: TextModerationRequest): Promise<ModerationInferenceResult> {
			const refs = [...request.text.map(({ ref }) => ref), ...request.links.map(({ ref }) => ref)];
			return replay("text", refs, identity, read);
		},
	};
}

export function createRecordedImageAdapter(
	identity: ModerationModelIdentity,
	read: RecordedOutputSource,
): ImageModerationAdapter {
	return {
		identity,
		moderate(request: ImageModerationRequest): Promise<ModerationInferenceResult> {
			return replay("image", [request.evidenceRef], identity, read);
		},
	};
}

async function replay(
	kind: "text" | "image",
	refs: readonly string[],
	identity: ModerationModelIdentity,
	read: RecordedOutputSource,
): Promise<ModerationInferenceResult> {
	const recorded = await read(kind, refs);
	return {
		...parseModerationModelOutput(recorded.response, refs),
		identity,
		latencyMs: recorded.latencyMs,
		usage: recorded.usage ?? {},
	};
}
