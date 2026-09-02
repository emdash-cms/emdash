import {
	createCloudflareImagesDerivativeTransformer,
	createResizedImageModerationAdapter,
	DEFAULT_MODERATION_IMAGE_DERIVATIVE_OPTIONS,
} from "../src/ai/image-resize.js";
import {
	createWorkersAiImageAdapter,
	createWorkersAiTextAdapter,
	workersAiBindingFromEnv,
	type WorkersAiAdapterConfig,
	type WorkersAiBinding,
} from "../src/ai/workers-ai.js";
import { assertSealedEvalDataset } from "./dataset.js";
import { runEvaluation, type EvaluationRunOptions } from "./harness.js";
import type { EvalCaseRun, EvalResultBundle, SealedEvalDataset } from "./types.js";

const liveEvaluationArtifactBrand: unique symbol = Symbol("liveEvaluationArtifact");

export interface LiveEvaluationArtifact {
	readonly bundle: EvalResultBundle;
	readonly [liveEvaluationArtifactBrand]: true;
}

export interface ProtectedLiveEvaluationInput {
	dataset: SealedEvalDataset;
	text: WorkersAiAdapterConfig & { configuredUnits: number };
	image: WorkersAiAdapterConfig & { configuredUnits: number };
	repeatCount: number;
	runnerCommit: string;
	executedAt?: string;
}

export interface ProtectedLiveEvaluationDurability {
	runCase(name: string, callback: () => Promise<EvalCaseRun>): Promise<EvalCaseRun>;
}

const liveArtifacts = new WeakSet<object>();

export async function runProtectedLiveEvaluation(
	input: ProtectedLiveEvaluationInput,
	durability?: ProtectedLiveEvaluationDurability,
): Promise<LiveEvaluationArtifact> {
	if ("ai" in input) {
		throw new TypeError("protected live evaluation does not accept an AI override");
	}
	assertSealedEvalDataset(input.dataset);
	const { env } = await import("cloudflare:workers");
	if (!env.AI) throw new Error("native Workers AI binding is unavailable");
	const ai = workersAiBindingFromEnv(env.AI);
	const options = createLiveEvaluationOptions(
		ai,
		env.IMAGES,
		input,
		input.executedAt ?? new Date().toISOString(),
		durability,
	);
	const bundle = deepFreeze(await runEvaluation(options));
	const artifact = Object.freeze<LiveEvaluationArtifact>({
		bundle,
		[liveEvaluationArtifactBrand]: true,
	});
	liveArtifacts.add(artifact);
	return artifact;
}

function createLiveEvaluationOptions(
	ai: WorkersAiBinding,
	images: ImagesBinding | undefined,
	input: ProtectedLiveEvaluationInput,
	executedAt: string,
	durability?: ProtectedLiveEvaluationDurability,
): EvaluationRunOptions {
	const text = createWorkersAiTextAdapter(ai, input.text);
	const baseImage = createWorkersAiImageAdapter(ai, input.image);
	const image = images
		? createResizedImageModerationAdapter(
				createCloudflareImagesDerivativeTransformer(images),
				baseImage,
				DEFAULT_MODERATION_IMAGE_DERIVATIVE_OPTIONS,
			)
		: baseImage;
	return {
		dataset: input.dataset,
		mode: "live",
		repeatCount: input.repeatCount,
		textIdentity: text.identity,
		imageIdentity: image.identity,
		runnerCommit: input.runnerCommit,
		executedAt,
		createAdapters: () => ({ text, image }),
		...(durability ? { runCase: durability.runCase } : {}),
	};
}

function deepFreeze<T>(value: T): T {
	if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
	for (const child of Object.values(value)) deepFreeze(child);
	return Object.freeze(value);
}

export function assertLiveEvaluationArtifact(
	value: unknown,
): asserts value is LiveEvaluationArtifact {
	if (typeof value !== "object" || value === null || !liveArtifacts.has(value)) {
		throw new TypeError("promotion requires a protected live evaluation artifact");
	}
}
