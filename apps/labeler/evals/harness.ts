import {
	MODERATION_FINDING_CATEGORIES,
	type ListingModerationPolicy,
	type ModerationFindingCategory,
} from "@emdash-cms/registry-moderation";
import { INITIAL_LISTING_POLICY_FIXTURE } from "@emdash-cms/registry-moderation/fixtures";
import { computeMultihash } from "@emdash-cms/registry-verification/checksum";

import { createRecordedImageAdapter, createRecordedTextAdapter } from "../src/ai/recorded.js";
import { ModelOutputError } from "../src/ai/types.js";
import type {
	ImageModerationAdapter,
	ModerationInferenceResult,
	ModerationModelIdentity,
	TextModerationAdapter,
} from "../src/ai/types.js";
import { buildCanonicalAssessmentInput } from "../src/assessment/canonical.js";
import { checkModerationLinks } from "../src/assessment/links.js";
import { createGuardedMediaAcquirer } from "../src/assessment/media.js";
import {
	resolveAssessmentPolicy,
	type AssessmentPolicyResolution,
} from "../src/assessment/policy.js";
import { verifyExactRegistryRecord } from "../src/assessment/records.js";
import { assertSealedEvalDataset, readSealedEvalAsset } from "./dataset.js";
import type {
	EvalBudgetEvaluation,
	EvalBudgets,
	EvalCaseResult,
	EvalCaseRun,
	EvalFixture,
	EvalMetrics,
	EvalRecording,
	EvalResultBundle,
	ImageEvalFixture,
	SealedEvalDataset,
	TextEvalFixture,
} from "./types.js";

export const EVAL_RUNNER_VERSION = "listing-ai-eval-runner-v2";
const PROFILE_SUBJECT = {
	uri: "at://did:plc:evaluationfixture/com.emdashcms.experimental.package.profile/eval",
	cid: "bafyreiabaeaqcaibaeaqcaibaeaqcaibaeaqcaibaeaqcaibaeaqcaibae",
	kind: "profile" as const,
};
const RELEASE_SUBJECT = {
	uri: "at://did:plc:evaluationfixture/com.emdashcms.experimental.package.release/eval:1.0.0",
	cid: "bafyreiacaibaeaqcaibaeaqcaibaeaqcaibaeaqcaibaeaqcaibaeaqcai",
	kind: "release" as const,
};
const PROFILE_KEYWORD_REF_RE = /^profile\.keywords\[(\d+)]$/;
const PROFILE_AUTHOR_FIELD_REF_RE = /^profile\.authors\[(\d+)]\.(name|email)$/;
const PROFILE_SECURITY_EMAIL_REF_RE = /^profile\.security\[(\d+)]\.email$/;
const PROFILE_AUTHOR_URL_REF_RE = /^profile\.authors\[(\d+)]\.url$/;
const PROFILE_SECURITY_URL_REF_RE = /^profile\.security\[(\d+)]\.url$/;
const PROFILE_MARKDOWN_LINK_REF_RE = /^profile\.sections\.([^.]+)\.links\[(\d+)]$/;
const RELEASE_MEDIA_REF_RE = /^release\.media\.(icon|banner|screenshot):(\d+)$/;

export interface EvaluationRunOptions {
	dataset: SealedEvalDataset;
	repeatCount: number;
	mode: "recorded" | "live";
	textIdentity: ModerationModelIdentity;
	imageIdentity: ModerationModelIdentity;
	runnerCommit: string;
	executedAt: string;
	caseConcurrency?: number;
	createAdapters(fixture: EvalFixture): {
		text: TextModerationAdapter;
		image: ImageModerationAdapter;
	};
	runCase?(name: string, callback: () => Promise<EvalCaseRun>): Promise<EvalCaseRun>;
}

export async function runEvaluation(options: EvaluationRunOptions): Promise<EvalResultBundle> {
	assertSealedEvalDataset(options.dataset);
	if (
		!Number.isInteger(options.repeatCount) ||
		options.repeatCount < 1 ||
		options.repeatCount > 20
	) {
		throw new TypeError("eval repeatCount must be between 1 and 20");
	}
	const caseConcurrency = options.caseConcurrency ?? 1;
	if (!Number.isInteger(caseConcurrency) || caseConcurrency < 1 || caseConcurrency > 8) {
		throw new TypeError("eval caseConcurrency must be between 1 and 8");
	}
	const cases = await mapConcurrent(
		options.dataset.fixtures,
		caseConcurrency,
		async (fixture, caseIndex): Promise<EvalCaseResult> => {
			const runs: EvalCaseRun[] = [];
			for (let repetition = 0; repetition < options.repeatCount; repetition += 1) {
				const adapters = options.createAdapters(fixture);
				const execute = () => evaluateFixture(fixture, adapters, options.dataset);
				runs.push(
					options.runCase
						? await options.runCase(`case-${caseIndex}-repeat-${repetition}`, execute)
						: await execute(),
				);
			}
			return {
				id: fixture.id,
				kind: fixture.kind,
				partition: fixture.partition,
				expected: fixture.expected,
				runs,
				disagreed: runs.some((run) => runSignature(run) !== runSignature(runs[0]!)),
			};
		},
	);
	const metrics = calculateEvalMetrics(cases);
	return {
		schemaVersion: 1,
		mode: options.mode,
		repeatCount: options.repeatCount,
		reproducibility: {
			datasetVersion: options.dataset.datasetVersion,
			datasetHash: options.dataset.datasetHash,
			policyVersion: INITIAL_LISTING_POLICY_FIXTURE.policyVersion,
			canonicalInputVersion: "canonical-listing-input-v1",
			runnerVersion: EVAL_RUNNER_VERSION,
			runnerCommit: options.runnerCommit,
			executedAt: options.executedAt,
			text: options.textIdentity,
			image: options.imageIdentity,
		},
		cases,
		metrics,
		budgetEvaluation: evaluateBudgets(metrics, options.dataset.budgets, {
			requireCompleteUsage: options.mode === "live",
		}),
	};
}

async function mapConcurrent<Input, Output>(
	items: readonly Input[],
	limit: number,
	callback: (item: Input, index: number) => Promise<Output>,
): Promise<Output[]> {
	const output: Array<Output | undefined> = Array.from({ length: items.length });
	let cursor = 0;
	const worker = async (): Promise<void> => {
		while (cursor < items.length) {
			const index = cursor;
			cursor += 1;
			output[index] = await callback(items[index]!, index);
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
	return output.map((value) => {
		if (value === undefined) throw new Error("evaluation did not produce every case result");
		return value;
	});
}

export function createRecordedEvaluationOptions(input: {
	dataset: SealedEvalDataset;
	recordings: Readonly<Record<string, EvalRecording>>;
	textIdentity: ModerationModelIdentity;
	imageIdentity: ModerationModelIdentity;
	runnerCommit: string;
	executedAt: string;
}): EvaluationRunOptions {
	return {
		...input,
		mode: "recorded",
		repeatCount: 1,
		createAdapters(fixture) {
			const recording = input.recordings[fixture.id];
			if (!recording) throw new Error(`recording is missing for ${fixture.id}`);
			const source = (_kind: "text" | "image", evidenceRefs: readonly string[]) => ({
				response: JSON.stringify(recordedOutputForEvidence(recording.output, evidenceRefs)),
				latencyMs: recording.latencyMs,
				usage: recording.usage,
			});
			return {
				text: createRecordedTextAdapter(input.textIdentity, source),
				image: createRecordedImageAdapter(input.imageIdentity, source),
			};
		},
	};
}

function recordedOutputForEvidence(output: unknown, evidenceRefs: readonly string[]): unknown {
	if (typeof output !== "object" || output === null || Array.isArray(output)) return output;
	return { ...output, coveredEvidenceRefs: evidenceRefs };
}

async function evaluateFixture(
	fixture: EvalFixture,
	adapters: { text: TextModerationAdapter; image: ImageModerationAdapter },
	dataset: SealedEvalDataset,
): Promise<EvalCaseRun> {
	try {
		let result: ModerationInferenceResult;
		let resolution;
		if (fixture.kind === "text") {
			const canonical = await buildCanonicalTextEvalRequest(fixture);
			result = await adapters.text.moderate({
				subject: PROFILE_SUBJECT,
				text: canonical.text,
				links: canonical.links,
			});
			resolution = resolveAssessmentPolicy({
				policy: evalPolicy(),
				expectedTextRefs: canonical.text.map(({ ref }) => ref),
				expectedLinkRefs: canonical.links.map(({ ref }) => ref),
				expectedMediaRefs: [],
				checkedLinks: checkModerationLinks(canonical.links),
				text: { status: "complete", result },
				images: {},
			});
		} else {
			const media = await acquireCanonicalImageFixture(fixture, dataset);
			result = await adapters.image.moderate({
				subject: RELEASE_SUBJECT,
				evidenceRef: fixture.input.evidenceRef,
				mimeType: media.mimeType,
				bytes: media.bytes,
			});
			resolution = resolveAssessmentPolicy({
				policy: evalPolicy(),
				expectedTextRefs: [],
				expectedLinkRefs: [],
				expectedMediaRefs: [fixture.input.evidenceRef],
				checkedLinks: [],
				images: { [fixture.input.evidenceRef]: { status: "complete", result } },
			});
		}
		return {
			status: "complete",
			findings: result.findings,
			actualCategories: uniqueCategories(result.findings.map(({ category }) => category)),
			actualOutcome: evaluationOutcome(resolution),
			coveredEvidenceRefs: result.coveredEvidenceRefs,
			latencyMs: result.latencyMs,
			usage: result.usage,
		};
	} catch (error) {
		const errorCode =
			error instanceof ModelOutputError
				? error.code
				: error instanceof Error
					? `model-error:${error.message}`
					: "model-error";
		return {
			status: error instanceof ModelOutputError ? "invalid-output" : "model-error",
			findings: [],
			actualCategories: [],
			actualOutcome: "error",
			coveredEvidenceRefs: [],
			latencyMs: 0,
			usage: {},
			errorCode,
		};
	}
}

export async function buildCanonicalTextEvalRequest(fixture: TextEvalFixture) {
	const record = materializeProfileRecord(fixture);
	const verified = await verifyExactRegistryRecord(
		{
			async verifyExactRecord() {
				return {
					uri: PROFILE_SUBJECT.uri,
					cid: PROFILE_SUBJECT.cid,
					record,
					verification: "did-mst-signature" as const,
				};
			},
		},
		PROFILE_SUBJECT,
	);
	const canonical = buildCanonicalAssessmentInput(verified);
	if (canonical.kind !== "profile") throw new Error("text eval did not produce a profile");
	const textByRef = new Map(canonical.text.map((field) => [field.ref, field]));
	const linkByRef = new Map(canonical.links.map((field) => [field.ref, field]));
	for (const expected of fixture.input.text) {
		const projected = textByRef.get(expected.ref);
		if (!projected || projected.value !== expected.value || projected.format !== expected.format) {
			throw new Error(`text fixture does not match canonical projection: ${expected.ref}`);
		}
	}
	for (const expected of fixture.input.links) {
		const projected = linkByRef.get(expected.ref);
		if (!projected || projected.url !== expected.url || projected.usage !== expected.usage) {
			throw new Error(`link fixture does not match canonical projection: ${expected.ref}`);
		}
	}
	return { text: canonical.text, links: canonical.links };
}

function materializeProfileRecord(fixture: TextEvalFixture) {
	const authors: Array<{ name: string; url?: string; email?: string }> = [
		{ name: "Evaluation Publisher" },
	];
	const security: Array<{ url?: string; email?: string }> = [{ email: "security@example.test" }];
	const sections: Record<string, string> = {};
	const keywords: string[] = [];
	const record: Record<string, unknown> = {
		$type: "com.emdashcms.experimental.package.profile",
		id: PROFILE_SUBJECT.uri,
		type: "emdash-plugin",
		slug: "eval",
		license: "MIT",
		authors,
		security,
	};
	for (const field of fixture.input.text) {
		if (field.ref === "profile.name") record["name"] = field.value;
		else if (field.ref === "profile.description") record["description"] = field.value;
		else if (field.ref === "profile.license") record["license"] = field.value;
		else if (field.ref === "profile.slug") record["slug"] = field.value;
		else if (field.ref.startsWith("profile.sections.")) {
			sections[field.ref.slice("profile.sections.".length)] = field.value;
		} else {
			const keyword = PROFILE_KEYWORD_REF_RE.exec(field.ref);
			const author = PROFILE_AUTHOR_FIELD_REF_RE.exec(field.ref);
			const contact = PROFILE_SECURITY_EMAIL_REF_RE.exec(field.ref);
			if (keyword) keywords[Number(keyword[1])] = field.value;
			else if (author) {
				const item = ensureAuthor(authors, Number(author[1]));
				if (author[2] === "name") item.name = field.value;
				else item.email = field.value;
			} else if (contact) {
				ensureSecurityContact(security, Number(contact[1])).email = field.value;
			} else throw new TypeError(`unsupported canonical text fixture ref: ${field.ref}`);
		}
	}
	for (const link of fixture.input.links) {
		const author = PROFILE_AUTHOR_URL_REF_RE.exec(link.ref);
		const contact = PROFILE_SECURITY_URL_REF_RE.exec(link.ref);
		const markdown = PROFILE_MARKDOWN_LINK_REF_RE.exec(link.ref);
		if (author && link.usage === "author") {
			ensureAuthor(authors, Number(author[1])).url = link.url;
		} else if (contact && link.usage === "security") {
			ensureSecurityContact(security, Number(contact[1])).url = link.url;
		} else if (markdown && link.usage === "markdown") {
			const section = markdown[1]!;
			const index = Number(markdown[2]);
			const existing = sections[section] ?? "";
			sections[section] = `${existing}\n[eval-link-${index}](${link.url})`;
		} else {
			throw new TypeError(`unsupported canonical link fixture ref: ${link.ref}`);
		}
	}
	if (Object.keys(sections).length > 0) record["sections"] = sections;
	if (keywords.length > 0) record["keywords"] = keywords;
	return record;
}

function ensureAuthor(
	authors: Array<{ name: string; url?: string; email?: string }>,
	index: number,
) {
	while (authors.length <= index) authors.push({ name: "Evaluation Publisher" });
	return authors[index]!;
}

function ensureSecurityContact(contacts: Array<{ url?: string; email?: string }>, index: number) {
	while (contacts.length <= index) contacts.push({ email: "security@example.test" });
	return contacts[index]!;
}

async function acquireCanonicalImageFixture(
	fixture: ImageEvalFixture,
	dataset: SealedEvalDataset,
): Promise<{ mimeType: "image/png"; bytes: Uint8Array }> {
	const assetBytes = readSealedEvalAsset(dataset, fixture.input.assetId);
	const checksum = await computeMultihash(assetBytes);
	if (!checksum.success) throw new Error("evaluation image checksum could not be computed");
	const mediaUrl = `https://eval-media.example/${fixture.input.assetId}.png`;
	const artifact = {
		url: mediaUrl,
		checksum: checksum.value,
		contentType: fixture.input.mimeType,
		width: readPngDimension(assetBytes, 16),
		height: readPngDimension(assetBytes, 20),
	};
	const artifacts: Record<string, unknown> = {
		package: {
			url: "https://never-fetch.invalid/eval-plugin.tgz",
			checksum: "bafyevalpackageneverfetch",
		},
	};
	const match = RELEASE_MEDIA_REF_RE.exec(fixture.input.evidenceRef);
	if (!match) throw new TypeError("evaluation image evidence ref is invalid");
	const [, kind, indexValue] = match;
	const index = Number(indexValue);
	if (kind === "screenshot") {
		const screenshots = Array.from({ length: index + 1 }, () => ({ ...artifact }));
		artifacts["screenshots"] = screenshots;
	} else {
		if (index !== 0) throw new TypeError("icon and banner eval refs must use index zero");
		artifacts[kind!] = artifact;
	}
	const record = {
		$type: "com.emdashcms.experimental.package.release",
		package: "eval",
		version: "1.0.0",
		repo: "https://never-fetch.invalid/source",
		sbom: {
			format: "cyclonedx",
			url: "https://never-fetch.invalid/sbom",
			checksum: "bafyevalsbomneverfetch",
		},
		artifacts,
	};
	const verified = await verifyExactRegistryRecord(
		{
			async verifyExactRecord() {
				return {
					uri: RELEASE_SUBJECT.uri,
					cid: RELEASE_SUBJECT.cid,
					record,
					verification: "did-mst-signature" as const,
				};
			},
		},
		RELEASE_SUBJECT,
	);
	const canonical = buildCanonicalAssessmentInput(verified);
	if (canonical.kind !== "release") throw new Error("image eval did not produce a release");
	const descriptor = canonical.media.find(
		(item) => `release.media.${item.kind}:${item.index}` === fixture.input.evidenceRef,
	);
	if (!descriptor) throw new Error("image fixture is missing from the canonical projection");
	const stored = new Map<string, Uint8Array>();
	const acquirer = createGuardedMediaAcquirer({
		resolver: {
			async resolve(hostname) {
				if (hostname !== "eval-media.example") {
					throw new Error("eval attempted to resolve a non-display resource");
				}
				return ["8.8.8.8"];
			},
		},
		transport: {
			async fetch(input) {
				if (input.url !== mediaUrl) {
					throw new Error("eval attempted to fetch a non-display resource");
				}
				return {
					response: new Response(assetBytes, {
						headers: { "content-type": fixture.input.mimeType },
					}),
					connectedAddress: "8.8.8.8",
				};
			},
		},
		decoder: {
			async decode(bytes) {
				return {
					mimeType: "image/png",
					width: readPngDimension(bytes, 16),
					height: readPngDimension(bytes, 20),
					frames: 1,
				};
			},
		},
		store: {
			async put(input) {
				const contentRef = `eval-quarantine://${input.sha256}`;
				stored.set(contentRef, new Uint8Array(input.bytes));
				return { contentRef, contentAddress: input.contentAddress };
			},
		},
	});
	const acquired = await acquirer.acquire(RELEASE_SUBJECT, descriptor, {
		neverFetchUrls: new Set(canonical.neverFetchUrls),
	});
	const bytes = stored.get(acquired.contentRef);
	if (!bytes || acquired.mimeType !== "image/png") {
		throw new Error("verified evaluation image was not quarantined as PNG bytes");
	}
	return { mimeType: "image/png", bytes: new Uint8Array(bytes) };
}

function readPngDimension(bytes: Uint8Array, offset: number): number {
	if (
		bytes.length < 24 ||
		bytes[0] !== 137 ||
		bytes[1] !== 80 ||
		bytes[2] !== 78 ||
		bytes[3] !== 71
	) {
		throw new TypeError("evaluation image is not a PNG");
	}
	return new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, false);
}

export function calculateEvalMetrics(cases: readonly EvalCaseResult[]): EvalMetrics {
	const categories: EvalMetrics["categories"] = {
		"explicit-sexual-content": categoryMetrics(),
		"hateful-or-dehumanizing-content": categoryMetrics(),
		"graphic-violence": categoryMetrics(),
		"phishing-or-credential-solicitation": categoryMetrics(),
		"material-impersonation": categoryMetrics(),
		"scam-or-spam": categoryMetrics(),
		"malicious-or-deceptive-link": categoryMetrics(),
		"misleading-media-or-claims": categoryMetrics(),
	};
	const partitions = new Map<string, { reviews: number; total: number }>();
	const allRuns = cases.flatMap(({ runs: caseRuns }) => caseRuns);
	for (const item of cases) {
		const run = item.runs[0]!;
		const expected = new Set(item.expected.categories);
		const actual = new Set(run.actualCategories);
		for (const category of MODERATION_FINDING_CATEGORIES) {
			const metric = categories[category];
			if (expected.has(category) && actual.has(category)) metric.truePositive += 1;
			else if (expected.has(category)) metric.falseNegative += 1;
			else if (actual.has(category)) metric.falsePositive += 1;
			else metric.trueNegative += 1;
		}
		const partition = partitions.get(item.partition) ?? { reviews: 0, total: 0 };
		partition.total += 1;
		if (run.actualOutcome === "review") partition.reviews += 1;
		partitions.set(item.partition, partition);
	}
	const latencies = allRuns
		.map(({ latencyMs }) => latencyMs)
		.toSorted((left, right) => left - right);
	const usage = allRuns.reduce(
		(total, run) => ({
			inputTokens: total.inputTokens + validUsageValue(run.usage.inputTokens),
			outputTokens: total.outputTokens + validUsageValue(run.usage.outputTokens),
			totalTokens: total.totalTokens + validUsageValue(run.usage.totalTokens),
			configuredUnits: total.configuredUnits + validUsageValue(run.usage.configuredUnits),
		}),
		{ inputTokens: 0, outputTokens: 0, totalTokens: 0, configuredUnits: 0 },
	);
	const disagreements = cases.filter(({ disagreed }) => disagreed).length;
	const outcomeMismatches = cases.reduce(
		(total, item) =>
			total + item.runs.filter((run) => run.actualOutcome !== item.expected.outcome).length,
		0,
	);
	return {
		categories,
		reviewRateByPartition: Object.fromEntries(
			Array.from(partitions, ([name, value]) => [name, value.reviews / value.total]),
		),
		invalidOutputs: allRuns.filter(({ status }) => status === "invalid-output").length,
		missingEvidence: allRuns.filter(({ errorCode }) => errorCode === "missing-evidence").length,
		contradictoryOutputs: allRuns.filter(({ errorCode }) => errorCode === "contradictory-output")
			.length,
		modelErrors: allRuns.filter(({ status }) => status === "model-error").length,
		coverageFailures: allRuns.filter(({ coveredEvidenceRefs, status }) =>
			status === "complete" ? coveredEvidenceRefs.length === 0 : true,
		).length,
		invalidUsageRuns: allRuns.filter(({ usage: runUsage }) => !isCompleteUsage(runUsage)).length,
		outcomeMismatches,
		repeatedRunDisagreements: disagreements,
		repeatedRunDisagreementRate: cases.length === 0 ? 0 : disagreements / cases.length,
		latencyMs: {
			p50: percentile(latencies, 0.5),
			p95: percentile(latencies, 0.95),
			max: latencies.at(-1) ?? 0,
		},
		usage,
		operatorDisagreements: null,
		operatorOverrides: null,
	};
}

export function evaluateBudgets(
	metrics: EvalMetrics,
	budgets: EvalBudgets,
	options: { requireCompleteUsage?: boolean } = {},
): EvalBudgetEvaluation {
	const failures: string[] = [];
	for (const [category, value] of Object.entries(metrics.categories)) {
		if (value.falseNegative > budgets.maxFalseNegativesPerCategory) {
			failures.push(`${category}: false-negative budget exceeded`);
		}
		if (value.falsePositive > budgets.maxFalsePositivesPerCategory) {
			failures.push(`${category}: false-positive budget exceeded`);
		}
	}
	if (metrics.invalidOutputs > budgets.maxInvalidOutputs)
		failures.push("invalid-output budget exceeded");
	if (metrics.modelErrors > budgets.maxModelErrors) failures.push("model-error budget exceeded");
	if ((metrics.reviewRateByPartition["benign"] ?? 0) > budgets.maxBenignReviewRate) {
		failures.push("benign review-rate budget exceeded");
	}
	if (metrics.outcomeMismatches > budgets.maxOutcomeMismatches) {
		failures.push("expected-outcome budget exceeded");
	}
	if (metrics.repeatedRunDisagreementRate > budgets.maxRepeatedRunDisagreementRate) {
		failures.push("repeated-run disagreement budget exceeded");
	}
	if (metrics.latencyMs.p95 > budgets.maxP95LatencyMs) failures.push("latency budget exceeded");
	if (metrics.usage.configuredUnits > budgets.maxConfiguredUnits)
		failures.push("usage budget exceeded");
	if (options.requireCompleteUsage && metrics.invalidUsageRuns > 0) {
		failures.push("live usage is missing or invalid");
	}
	return { passed: failures.length === 0, failures };
}

function validUsageValue(value: number | undefined): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function isCompleteUsage(usage: EvalCaseRun["usage"]): boolean {
	return [usage.inputTokens, usage.outputTokens, usage.totalTokens, usage.configuredUnits].every(
		(value) => typeof value === "number" && Number.isFinite(value) && value >= 0,
	);
}

function categoryMetrics() {
	return { truePositive: 0, trueNegative: 0, falsePositive: 0, falseNegative: 0 };
}

function evalPolicy(): ListingModerationPolicy {
	return { ...INITIAL_LISTING_POLICY_FIXTURE, autoPass: "assisted" };
}

function evaluationOutcome(resolution: AssessmentPolicyResolution): EvalCaseRun["actualOutcome"] {
	return resolution.reasonCodes.includes("model-promotion-required") ? "pass" : resolution.outcome;
}

function runSignature(run: EvalCaseRun): string {
	return JSON.stringify([run.status, run.actualOutcome, run.actualCategories.toSorted()]);
}

function uniqueCategories(
	values: readonly ModerationFindingCategory[],
): ModerationFindingCategory[] {
	return [...new Set(values)].toSorted();
}

function percentile(values: readonly number[], quantile: number): number {
	if (values.length === 0) return 0;
	return values[Math.min(values.length - 1, Math.ceil(values.length * quantile) - 1)]!;
}
