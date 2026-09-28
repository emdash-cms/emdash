import type { ListingModerationPolicy } from "@emdash-cms/registry-moderation";
import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";

import type {
	ImageModerationAdapter,
	ImageModerationRequest,
	TextModerationAdapter,
} from "../ai/types.js";
import {
	createAssessmentFinalizationProposal,
	finalizeResolvedAssessment,
	type AssessmentFinalizationIssuer,
} from "./finalization.js";
import {
	runAssessmentFoundation,
	type AssessmentFoundationDependencies,
	type DurableAssessmentStep,
} from "./foundation.js";
import { resolveAssessmentPolicy, type ModerationStage } from "./policy.js";
import { workflowParamsToIdentity } from "./run-key.js";
import { createProductionAssessmentWorkflowDependencies } from "./runtime.js";
import type { AssessmentWorkflowParams, AssessmentWorkflowResult } from "./types.js";

const MAX_INFERENCE_MEDIA_BYTES = 8 * 1024 * 1024;
const MAX_CONCURRENT_IMAGE_INFERENCE = 3;

export interface ModerationMediaReader {
	read(input: {
		contentRef: string;
		expectedSha256: string;
		maxBytes: number;
	}): Promise<Uint8Array>;
}

export interface AssessmentWorkflowDependencies extends AssessmentFoundationDependencies {
	textAdapter: TextModerationAdapter;
	imageAdapter?: ImageModerationAdapter;
	mediaReader?: ModerationMediaReader;
	policy: ListingModerationPolicy;
	finalizer: AssessmentFinalizationIssuer;
}

export class AssessmentWorkflowConfigurationError extends Error {
	override readonly name = "AssessmentWorkflowConfigurationError";
}

export async function runBoundAssessmentWorkflow(
	event: Readonly<WorkflowEvent<AssessmentWorkflowParams>>,
	step: DurableAssessmentStep,
	dependencies?: AssessmentWorkflowDependencies,
): Promise<AssessmentWorkflowResult> {
	if (!dependencies) {
		throw new AssessmentWorkflowConfigurationError(
			"assessment Workflow dependencies are not configured; refusing to acknowledge the run",
		);
	}
	if (event.instanceId !== event.payload.runKey) {
		throw new Error("assessment run key does not match the Workflow instance ID");
	}
	let foundation;
	try {
		foundation = await runAssessmentFoundation(event.payload, step, dependencies);
	} catch (error) {
		const current = await dependencies.lifecycle.getRun(event.payload.runKey);
		const failRun = dependencies.lifecycle.failRun;
		if (current?.state !== "running" || !failRun) throw error;
		await step.do("persist operational assessment error", async () =>
			failRun(
				event.payload.runKey,
				current.stateVersion,
				"RECORD_VERIFICATION_OR_CANONICALIZATION_FAILED",
				(dependencies.now ?? (() => new Date()))().toISOString(),
			),
		);
		return { runKey: event.payload.runKey, status: "error" };
	}
	if (foundation.status === "cancelled") return foundation;
	const identity = workflowParamsToIdentity(event.payload);
	assertRuntimeConfiguration(identity.versions, dependencies, foundation.media.length > 0);

	const expectedTextRefs = foundation.canonicalInput.text.map(({ ref }) => ref);
	const expectedLinkRefs = foundation.canonicalInput.links.map(({ ref }) => ref);
	const text =
		expectedTextRefs.length + expectedLinkRefs.length === 0
			? undefined
			: await runModerationStage(step, "moderate displayed text and links", async () =>
					dependencies.textAdapter.moderate({
						subject: foundation.run.subject,
						text: foundation.canonicalInput.text,
						links: foundation.canonicalInput.links,
					}),
				);
	const completedImageEntries = await mapConcurrent(
		foundation.media,
		MAX_CONCURRENT_IMAGE_INFERENCE,
		async (media) => {
			const ref = `release.media.${media.kind}:${media.index}`;
			const stage = await runModerationStage(step, `moderate ${ref}`, async () => {
				const reader = dependencies.mediaReader;
				const adapter = dependencies.imageAdapter;
				if (!reader || !adapter || foundation.run.subject.kind !== "release") {
					throw new AssessmentWorkflowConfigurationError(
						"release display-media inference dependencies are not configured",
					);
				}
				const releaseSubject = {
					uri: foundation.run.subject.uri,
					cid: foundation.run.subject.cid,
					kind: "release" as const,
				};
				const bytes = await reader.read({
					contentRef: media.contentRef,
					expectedSha256: media.sha256,
					maxBytes: MAX_INFERENCE_MEDIA_BYTES,
				});
				if (bytes.byteLength > MAX_INFERENCE_MEDIA_BYTES) {
					throw new RangeError("verified display media exceeds the inference byte limit");
				}
				if ((await sha256Hex(bytes)) !== media.sha256) {
					throw new Error("stored display media no longer matches its verified hash");
				}
				return adapter.moderate({
					subject: releaseSubject,
					evidenceRef: ref,
					mimeType: parseImageMimeType(media.mimeType),
					bytes,
				});
			});
			return [ref, stage] as const;
		},
	);
	const imageEntries = [
		...completedImageEntries,
		...foundation.failedMediaRefs.map(
			(ref) => [ref, { status: "error", code: "acquisition-unavailable" }] as const,
		),
	];
	const images = Object.fromEntries(imageEntries);
	const resolution = await step.do("resolve assessment policy", async () =>
		resolveAssessmentPolicy({
			policy: dependencies.policy,
			expectedTextRefs,
			expectedLinkRefs,
			expectedMediaRefs: foundation.canonicalInput.media.map(
				(descriptor) => `release.media.${descriptor.kind}:${descriptor.index}`,
			),
			checkedLinks: foundation.checkedLinks,
			...(text ? { text } : {}),
			images,
		}),
	);
	const proposal = createAssessmentFinalizationProposal({
		run: foundation.run,
		moderationFingerprint: foundation.moderationFingerprint,
		resolution,
	});
	const committed = await step.do("finalize assessment and signed label", async () =>
		finalizeResolvedAssessment(dependencies.finalizer, proposal, dependencies.now?.()),
	);
	if (
		committed.run.state !== "passed" &&
		committed.run.state !== "review" &&
		committed.run.state !== "error"
	) {
		throw new Error("assessment finalization returned a non-terminal automated state");
	}
	return {
		runKey: event.payload.runKey,
		status: committed.run.state,
		moderationFingerprint: foundation.moderationFingerprint,
		mediaCount: foundation.mediaCount,
	};
}

export class AssessmentWorkflow extends WorkflowEntrypoint<Env, AssessmentWorkflowParams> {
	override async run(
		event: Readonly<WorkflowEvent<AssessmentWorkflowParams>>,
		step: WorkflowStep,
	): Promise<AssessmentWorkflowResult> {
		return runBoundAssessmentWorkflow(
			event,
			step,
			await createProductionAssessmentWorkflowDependencies(this.env),
		);
	}
}

async function mapConcurrent<Input, Output>(
	items: readonly Input[],
	limit: number,
	callback: (item: Input) => Promise<Output>,
): Promise<Output[]> {
	const output: Array<Output | undefined> = Array.from({ length: items.length });
	let cursor = 0;
	const worker = async (): Promise<void> => {
		while (cursor < items.length) {
			const index = cursor;
			cursor += 1;
			output[index] = await callback(items[index]!);
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
	return output.map((value) => {
		if (value === undefined) throw new Error("image inference did not produce every result");
		return value;
	});
}

async function runModerationStage(
	step: DurableAssessmentStep,
	name: string,
	callback: () => Promise<Extract<ModerationStage, { status: "complete" }>["result"]>,
): Promise<ModerationStage> {
	try {
		return { status: "complete", result: await step.do(name, callback) };
	} catch {
		return { status: "error", code: "inference-unavailable" };
	}
}

function assertRuntimeConfiguration(
	versions: ReturnType<typeof workflowParamsToIdentity>["versions"],
	dependencies: AssessmentWorkflowDependencies,
	requiresImages: boolean,
): void {
	if (dependencies.policy.policyVersion !== versions.policyVersion) {
		throw new AssessmentWorkflowConfigurationError(
			"assessment policy does not match the run identity",
		);
	}
	assertAdapterIdentity(
		dependencies.textAdapter.identity,
		versions.textModelId,
		versions.textPromptHash,
		"text",
	);
	if (requiresImages) {
		if (!dependencies.imageAdapter || !dependencies.mediaReader) {
			throw new AssessmentWorkflowConfigurationError(
				"release display-media inference dependencies are not configured",
			);
		}
		assertAdapterIdentity(
			dependencies.imageAdapter.identity,
			versions.imageModelId,
			versions.imagePromptHash,
			"image",
		);
	}
}

function assertAdapterIdentity(
	identity: TextModerationAdapter["identity"],
	modelId: string,
	promptHash: string,
	purpose: "text" | "image",
): void {
	if (identity.modelId !== modelId || identity.promptHash !== promptHash) {
		throw new AssessmentWorkflowConfigurationError(
			`${purpose} adapter identity does not match the assessment run`,
		);
	}
}

function parseImageMimeType(value: string): ImageModerationRequest["mimeType"] {
	switch (value) {
		case "image/gif":
		case "image/jpeg":
		case "image/png":
		case "image/webp":
			return value;
		default:
			throw new TypeError("verified display media has an unsupported image MIME type");
	}
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
	return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (value) =>
		value.toString(16).padStart(2, "0"),
	).join("");
}
