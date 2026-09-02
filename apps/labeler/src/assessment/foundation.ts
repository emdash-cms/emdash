import {
	buildCanonicalAssessmentInput,
	parseCanonicalAssessmentProjection,
	type CanonicalAssessmentInput,
} from "./canonical.js";
import { createModerationFingerprint } from "./fingerprint.js";
import type { AssessmentLifecycleStore } from "./lifecycle.js";
import { checkModerationLinks } from "./links.js";
import type { CheckedModerationLink } from "./links.js";
import {
	acquireDisplayMediaSet,
	type DisplayMediaAcquirer,
	type VerifiedDisplayMedia,
} from "./media.js";
import { verifyExactRegistryRecord, type ExactRecordVerifier } from "./records.js";
import { assertAssessmentWorkflowParams, workflowParamsToIdentity } from "./run-key.js";
import type { AssessmentWorkflowParams } from "./types.js";
import type { AssessmentRunSnapshot } from "./types.js";

const MAX_VERIFIED_PROJECTION_BYTES = 256 * 1024;

export interface AssessmentFoundationDependencies {
	lifecycle: AssessmentLifecycleStore;
	recordVerifier: ExactRecordVerifier;
	mediaAcquirer?: DisplayMediaAcquirer;
	now?: () => Date;
}

export interface DurableAssessmentStep {
	do<T>(name: string, callback: () => Promise<T>): Promise<T>;
}

export type AssessmentFoundationResult =
	| { runKey: string; status: "cancelled" }
	| {
			runKey: string;
			status: "prepared";
			moderationFingerprint: string;
			mediaCount: number;
			run: AssessmentRunSnapshot;
			canonicalInput: CanonicalAssessmentInput;
			checkedLinks: readonly CheckedModerationLink[];
			media: readonly VerifiedDisplayMedia[];
			failedMediaRefs: readonly string[];
	  };

export async function runAssessmentFoundation(
	params: AssessmentWorkflowParams,
	step: DurableAssessmentStep,
	dependencies: AssessmentFoundationDependencies,
): Promise<AssessmentFoundationResult> {
	await assertAssessmentWorkflowParams(params);
	const identity = workflowParamsToIdentity(params);
	const now = dependencies.now ?? (() => new Date());
	const observed = await step.do("load authoritative assessment run", async () => {
		const run = await dependencies.lifecycle.getRun(params.runKey);
		if (!run) throw new Error("assessment run is absent from authoritative storage");
		return run;
	});
	if (observed.state === "cancelled" || observed.deleted) {
		return { runKey: params.runKey, status: "cancelled" };
	}
	const started = await step.do("start assessment run", async () =>
		dependencies.lifecycle.startRun(params.runKey, observed.stateVersion, now().toISOString()),
	);
	const projectionJson = await step.do("verify and project exact publisher record", async () => {
		const verified = await verifyExactRegistryRecord(dependencies.recordVerifier, identity.subject);
		const canonical = buildCanonicalAssessmentInput(verified);
		const serialized = JSON.stringify({
			kind: canonical.kind,
			input: canonical.input,
			neverFetchUrls: canonical.neverFetchUrls,
		});
		if (new TextEncoder().encode(serialized).byteLength > MAX_VERIFIED_PROJECTION_BYTES) {
			throw new RangeError("verified moderation projection exceeds its Workflow step limit");
		}
		return serialized;
	});
	const projection: unknown = JSON.parse(projectionJson);
	const canonicalValue = parseCanonicalAssessmentProjection(projection);
	const checkedLinks = await step.do("check displayed links", async () =>
		checkModerationLinks(canonicalValue.links),
	);
	const mediaAcquisition = await acquireMedia(
		identity.subject,
		canonicalValue,
		step,
		dependencies.mediaAcquirer,
	);
	const media = mediaAcquisition.media;
	const preparedInput =
		mediaAcquisition.failedMediaRefs.length === 0
			? attachVerifiedMedia(canonicalValue, media)
			: canonicalValue;
	const moderationFingerprint = await step.do("fingerprint moderation input", async () =>
		createModerationFingerprint(preparedInput, identity.versions),
	);
	const persisted = await step.do("persist prepared assessment", async () =>
		dependencies.lifecycle.persistPrepared(
			params.runKey,
			started.stateVersion,
			{
				moderationFingerprint,
				canonicalInput: {
					input: preparedInput.input,
					text: preparedInput.text,
					links: checkedLinks,
					mediaEvidence: media,
				},
				coverage: {
					text: preparationCoverage(preparedInput.text.length),
					links: preparationCoverage(preparedInput.links.length),
					media:
						mediaAcquisition.failedMediaRefs.length === 0
							? preparationCoverage(preparedInput.media.length)
							: { acquisition: "unavailable", inference: "pending" },
				},
			},
			now().toISOString(),
		),
	);
	if (persisted.state === "cancelled" || persisted.state === "superseded") {
		return { runKey: params.runKey, status: "cancelled" };
	}
	return {
		runKey: params.runKey,
		status: "prepared",
		moderationFingerprint,
		mediaCount: media.length,
		run: persisted,
		canonicalInput: preparedInput,
		checkedLinks,
		media,
		failedMediaRefs: mediaAcquisition.failedMediaRefs,
	};
}

async function acquireMedia(
	subject: { uri: string; cid: string; kind: "profile" | "release" },
	canonical: CanonicalAssessmentInput,
	step: DurableAssessmentStep,
	acquirer: DisplayMediaAcquirer | undefined,
): Promise<{ media: VerifiedDisplayMedia[]; failedMediaRefs: string[] }> {
	if (canonical.media.length === 0) return { media: [], failedMediaRefs: [] };
	const failedMediaRefs = canonical.media.map(
		(descriptor) => `release.media.${descriptor.kind}:${descriptor.index}`,
	);
	if (!acquirer) return { media: [], failedMediaRefs };
	try {
		return {
			media: await step.do("acquire guarded display media", async () =>
				acquireDisplayMediaSet(subject, canonical.media, acquirer, {}, canonical.neverFetchUrls),
			),
			failedMediaRefs: [],
		};
	} catch {
		return { media: [], failedMediaRefs };
	}
}

function attachVerifiedMedia(
	canonical: CanonicalAssessmentInput,
	media: readonly VerifiedDisplayMedia[],
): CanonicalAssessmentInput {
	if (canonical.kind === "profile") return canonical;
	const verifiedByKey = new Map(media.map((item) => [`${item.kind}:${item.index}`, item]));
	const descriptors = canonical.input.media.map((descriptor) => {
		const verified = verifiedByKey.get(`${descriptor.kind}:${descriptor.index}`);
		if (!verified) throw new Error("display media acquisition did not cover every descriptor");
		return {
			...descriptor,
			verified: {
				sha256: verified.sha256,
				mimeType: verified.mimeType,
				byteLength: verified.byteLength,
				width: verified.width,
				height: verified.height,
				contentRef: verified.contentRef,
			},
		};
	});
	return {
		...canonical,
		input: { ...canonical.input, media: descriptors },
		media: descriptors,
	};
}

function preparationCoverage(count: number): {
	acquisition: "collected" | "not-present" | "unavailable";
	inference: "pending" | "not-required";
} {
	return count === 0
		? { acquisition: "not-present", inference: "not-required" }
		: { acquisition: "collected", inference: "pending" };
}
