/**
 * Calibration sweep orchestration (plan W8.6). Drives the REAL production
 * adapters (`analyzeCode` / `analyzeImages`) over the ported fixture corpus
 * against every model in the matrix, resolves each adapter's findings through
 * the REAL policy resolver, and records the outcome per fixture x lane x model.
 * The model + prompt + schema + policy combination is the unit under
 * evaluation; nothing here re-implements the eval prompt.
 *
 * Model/validation errors are recorded as data and the sweep continues — a
 * flaky or unavailable model is a calibration observation, not a crash.
 */

import { analyzeCode } from "../src/code-ai-adapter.js";
import { analyzeImages, type ImageAnalysisInput } from "../src/image-ai-adapter.js";
import { resolvePolicyOutcome } from "../src/policy-resolver.js";
import { MODERATION_POLICY } from "../src/policy.js";
import {
	buildCodeAnalysisInput,
	buildImageAnalysisImage,
	manifestMetadata,
	type LaneExpectation,
} from "./fixture-loader.js";
import {
	createRunDir,
	loadFixtures,
	writeManifest,
	writeRecord,
	type LoadedFixture,
} from "./io.js";
import { modelsForLane } from "./models.js";
import { RestAiBinding, type CallDiagnostics } from "./rest-ai-binding.js";
import type { CallRecord, Lane, LoadedRun, RecordedFinding, RunManifest } from "./types.js";

export const CALIBRATION_PROMPT_VERSION = "w8.6-calibration";

interface Credentials {
	readonly accountId: string;
	readonly apiToken: string;
}

function readCredentials(): Credentials {
	const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
	const apiToken = process.env.CLOUDFLARE_API_TOKEN?.trim();
	if (!accountId || !apiToken)
		throw new Error(
			"calibration requires CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN. Run:\n" +
				"  CLOUDFLARE_API_TOKEN=$(pnpm --filter @emdash-cms/labeler exec wrangler auth token | tail -1) \\\n" +
				"  CLOUDFLARE_ACCOUNT_ID=<account-id> pnpm --filter @emdash-cms/labeler calibrate",
		);
	return { accountId, apiToken };
}

function recordFindings(
	findings: readonly {
		source: string;
		category: string;
		severity: string;
		confidence?: number;
		title: string;
		publicSummary: string;
		privateDetail: string;
	}[],
): RecordedFinding[] {
	return findings.map((finding) => ({
		source: finding.source,
		category: finding.category,
		severity: finding.severity,
		...(finding.confidence !== undefined ? { confidence: finding.confidence } : {}),
		title: finding.title,
		publicSummary: finding.publicSummary,
		privateDetail: finding.privateDetail,
	}));
}

function licenseHint(modelId: string, message: string): void {
	if (!/licen[cs]e|agree|consent/i.test(message)) return;
	console.warn(
		`\n[calibration] ${modelId} appears to require a one-time license acceptance.\n` +
			`Accept it once (this is a deliberate human action, not auto-agreed by the harness):\n` +
			`  curl -X POST https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/ai/run/${modelId} \\\n` +
			`    -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -d '{"prompt":"agree"}'\n`,
	);
}

async function runOneCall(
	fixture: LoadedFixture,
	lane: Lane,
	modelId: string,
	expected: LaneExpectation | null,
	credentials: Credentials,
	invoke: (binding: RestAiBinding) => Promise<{
		outcome: {
			toState: "passed" | "warned" | "blocked";
			labels: readonly {
				val: string;
				findingCategory?: string;
				severity?: import("../src/evidence.js").FindingSeverity;
			}[];
		};
		findings: RecordedFinding[];
		coverage: "complete" | "partial";
		dropped: readonly string[];
		call: { modelId: string; promptVersion: string; promptHash: string } | null;
	}>,
): Promise<CallRecord> {
	let diagnostics: CallDiagnostics | null = null;
	const binding = new RestAiBinding({
		accountId: credentials.accountId,
		apiToken: credentials.apiToken,
		onCall: (value) => {
			diagnostics = value;
		},
	});

	const started = Date.now();
	const base = {
		fixture: fixture.name,
		lane,
		modelId,
		promptVersion: CALIBRATION_PROMPT_VERSION,
		expected,
	} as const;
	try {
		const result = await invoke(binding);
		return {
			...base,
			ok: true,
			outcome: {
				toState: result.outcome.toState,
				labels: result.outcome.labels.map((label) => ({
					val: label.val,
					...(label.findingCategory !== undefined
						? { findingCategory: label.findingCategory }
						: {}),
					...(label.severity !== undefined ? { severity: label.severity } : {}),
				})),
			},
			findings: result.findings,
			coverage: result.coverage,
			dropped: result.dropped,
			call: result.call,
			diagnostics,
			error: null,
			latencyMs: Date.now() - started,
		};
	} catch (error) {
		const name = error instanceof Error ? error.name : "Error";
		const message = error instanceof Error ? error.message : String(error);
		licenseHint(modelId, message);
		return {
			...base,
			ok: false,
			outcome: null,
			findings: [],
			coverage: null,
			dropped: [],
			call: null,
			diagnostics,
			error: { name, message },
			latencyMs: Date.now() - started,
		};
	}
}

export async function runCalibration(label: string): Promise<LoadedRun> {
	const credentials = readCredentials();
	const fixtures = loadFixtures();
	const codeModels = modelsForLane("code");
	const imageModels = modelsForLane("image");

	// Precompute the per-fixture adapter inputs once so the sweep can iterate
	// model-outer (slowest model first): a wall-clock kill then loses the tail's
	// cheap, fast-to-redo calls rather than the expensive reasoning-model data.
	const codeCases = fixtures.map((fixture) => ({
		fixture,
		input: buildCodeAnalysisInput(fixture.manifest, fixture.manifestRaw, fixture.files),
	}));
	const imageCases: { fixture: LoadedFixture; input: ImageAnalysisInput }[] = [];
	for (const fixture of fixtures) {
		if (fixture.imageBytes === null) continue;
		const image = await buildImageAnalysisImage("icon.png", fixture.imageBytes, "icon");
		imageCases.push({
			fixture,
			input: { images: [image], metadata: manifestMetadata(fixture.manifest) },
		});
	}

	const records: CallRecord[] = [];
	const timestamp = new Date().toISOString().replace(/\.\d+Z$/, "Z");
	const runDir = createRunDir(timestamp, label);
	const baseManifest = {
		label,
		timestamp,
		promptVersion: CALIBRATION_PROMPT_VERSION,
		policyVersion: MODERATION_POLICY.policyVersion,
		models: [...codeModels, ...imageModels]
			.filter((model, index, all) => all.findIndex((m) => m.modelId === model.modelId) === index)
			.map((model) => ({ modelId: model.modelId, lanes: model.lanes })),
		fixtures: fixtures.map((fixture) => fixture.name),
		codeModels: codeModels.map((model) => model.modelId),
		imageModels: imageModels.map((model) => model.modelId),
	} as const;
	// Rewrite the manifest after every record so an interrupted sweep still has a
	// manifest whose recordCount matches the records on disk — the run stays
	// loadable and the report shows the missing cells as gaps.
	const record = (value: CallRecord): void => {
		records.push(value);
		writeRecord(runDir, value);
		writeManifest(runDir, { ...baseManifest, recordCount: records.length });
	};

	for (const model of codeModels) {
		for (const { fixture, input } of codeCases) {
			console.info(`[calibration] code ${fixture.name} ${model.modelId}`);
			record(
				await runOneCall(
					fixture,
					"code",
					model.modelId,
					fixture.expected.code ?? null,
					credentials,
					async (binding) => {
						const result = await analyzeCode(input, {
							ai: binding,
							policy: MODERATION_POLICY,
							modelId: model.modelId,
							promptVersion: CALIBRATION_PROMPT_VERSION,
						});
						const outcome = resolvePolicyOutcome(result.findings, MODERATION_POLICY);
						return {
							outcome,
							findings: recordFindings(result.findings),
							coverage: result.coverage,
							dropped: result.droppedFiles,
							call: result.call,
						};
					},
				),
			);
		}
	}

	for (const model of imageModels) {
		for (const { fixture, input } of imageCases) {
			console.info(`[calibration] image ${fixture.name} ${model.modelId}`);
			record(
				await runOneCall(
					fixture,
					"image",
					model.modelId,
					fixture.expected.image ?? null,
					credentials,
					async (binding) => {
						const result = await analyzeImages(input, {
							ai: binding,
							policy: MODERATION_POLICY,
							modelId: model.modelId,
							promptVersion: CALIBRATION_PROMPT_VERSION,
						});
						const outcome = resolvePolicyOutcome(result.findings, MODERATION_POLICY);
						return {
							outcome,
							findings: recordFindings(result.findings),
							coverage: result.coverage,
							dropped: result.droppedImages,
							call: result.call,
						};
					},
				),
			);
		}
	}

	const manifest: RunManifest = { ...baseManifest, recordCount: records.length };
	writeManifest(runDir, manifest);
	console.info(`[calibration] wrote ${records.length} records to ${runDir}`);
	return { manifest, records };
}
