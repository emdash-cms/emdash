import { CODEC_RAW, create as createCid, toString as cidToString } from "@atcute/cid";
import {
	createLabelSigner,
	type LabelDidDocument,
	type LabelSigner,
} from "@emdash-cms/registry-moderation";
import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import {
	createAcquireStage,
	type AcquisitionHolder,
	type AcquisitionTarget,
} from "../src/artifact-acquisition.js";
import {
	automatedIdempotencyKey,
	computeRunKey,
	initialTriggerId,
	operatorTriggerId,
} from "../src/assessment-lifecycle.js";
import {
	AssessmentFinalizationConflictError,
	AssessmentOrchestrator,
	StageTransientError,
	stubStages,
	type OrchestratorStages,
	type StageAdapter,
	type StageFinding,
} from "../src/assessment-orchestrator.js";
import {
	createAssessmentRun,
	createSubject,
	deleteSubject,
	getActiveLabelState,
	getAssessment,
	getCurrentAssessment,
	transitionAssessmentState,
} from "../src/assessment-store.js";
import { FindingValidationError, HISTORY_FINDING_CATEGORIES } from "../src/findings.js";
import { analyzeHistory } from "../src/history-context.js";
import { MODERATION_POLICY } from "../src/policy.js";
import {
	issueAutomatedAssessmentLabel,
	issueManualLabel,
	readIssuedLabelByActionKey,
	type IssuedLabel,
} from "../src/service.js";
import {
	abortRoutineKeyRotation,
	beginRoutineKeyRotation,
	initializeSigningState,
} from "../src/signing-rotation.js";
import type { LabelPublisher } from "../src/subscribe-labels.js";
import { canonicalBundle, checksumOf, file } from "./bundle-fixture.js";

interface TestEnv {
	DB: D1Database;
	TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
}

const testEnv = env as unknown as TestEnv;
const LABELER_DID = "did:web:labels.emdashcms.com";
const PUBLISHER_DID = "did:plc:publisher000000000000000000";
const PRIVATE_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAE";
const MULTIKEY = "zDnaepsL7AXenJkVYdkh5KuKsSU7Ykh7kyXaLLU7auN9FWSiZ";
const ROTATED_MULTIKEY = "zDnaer52RTwabaBeMkKYYwZmEFqPabLW78cRK62iovMUQhFif";
const config = { labelerDid: LABELER_DID, signingKeyVersion: "v1" };

/** Records every label handed to `publish`, mimicking the console/DO publisher. */
function recordingPublisher(managesPublicationState: boolean): {
	publisher: LabelPublisher;
	published: IssuedLabel[];
} {
	const published: IssuedLabel[] = [];
	return {
		published,
		publisher: {
			managesPublicationState,
			async publish(issued) {
				published.push(issued);
			},
		},
	};
}

/** A D1 wrapper that runs `onFirstBatch` immediately before the first
 * `db.batch` call — the seam between finalization prep and commit. Everything
 * else delegates to the real database. */
function pauseBeforeFirstBatch(db: D1Database, onFirstBatch: () => Promise<void>): D1Database {
	let triggered = false;
	return new Proxy(db, {
		get(target, prop, receiver) {
			if (prop === "batch") {
				return async (statements: D1PreparedStatement[]) => {
					if (!triggered) {
						triggered = true;
						await onFirstBatch();
					}
					return target.batch(statements);
				};
			}
			const value = Reflect.get(target, prop, receiver) as unknown;
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}

beforeAll(async () => {
	await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
	await initializeSigningState(testEnv.DB, {
		issuerDid: LABELER_DID,
		keyVersion: "v1",
		publicKeyMultibase: MULTIKEY,
	});
});

function document(): LabelDidDocument {
	return {
		id: LABELER_DID,
		verificationMethod: [
			{
				id: "#atproto_label",
				type: "Multikey",
				controller: LABELER_DID,
				publicKeyMultibase: MULTIKEY,
			},
		],
	};
}

async function signer(): Promise<LabelSigner> {
	return createLabelSigner({
		issuerDid: LABELER_DID,
		privateKey: PRIVATE_KEY,
		resolveDid: async () => document(),
	});
}

async function cid(seed: string): Promise<string> {
	const bytes = new TextEncoder().encode(seed);
	const buffer = new ArrayBuffer(bytes.byteLength);
	new Uint8Array(buffer).set(bytes);
	const value = await createCid(CODEC_RAW, new Uint8Array(buffer));
	return cidToString(value);
}

function releaseUri(name: string): string {
	return `at://${PUBLISHER_DID}/com.emdashcms.experimental.package.release/${name}:1.0.0`;
}

/** Creates a verified subject and a `pending` assessment run, ready for
 * `AssessmentOrchestrator.runAssessment`. */
async function pendingRun(opts: {
	name: string;
	cidValue: string;
	triggerId?: string;
}): Promise<{ id: string; uri: string; cid: string; runKey: string }> {
	const uri = releaseUri(opts.name);
	await createSubject(testEnv.DB, {
		uri,
		cid: opts.cidValue,
		did: PUBLISHER_DID,
		collection: "com.emdashcms.experimental.package.release",
		rkey: `${opts.name}:1.0.0`,
	});
	const triggerId = opts.triggerId ?? initialTriggerId(opts.cidValue);
	const runKey = await computeRunKey({
		uri,
		cid: opts.cidValue,
		policyVersion: MODERATION_POLICY.policyVersion,
		modelId: "unassigned",
		promptHash: "unassigned",
		scannerSetVersion: "unassigned",
		triggerId,
	});
	const { assessment } = await createAssessmentRun(testEnv.DB, {
		runKey,
		uri,
		cid: opts.cidValue,
		trigger: triggerId.startsWith("operator:") ? "operator" : "initial",
		triggerId,
		policyVersion: MODERATION_POLICY.policyVersion,
		coverageJson: "{}",
	});
	await transitionAssessmentState(testEnv.DB, {
		id: assessment.id,
		from: "observed",
		to: "verifying",
	});
	await transitionAssessmentState(testEnv.DB, {
		id: assessment.id,
		from: "verifying",
		to: "pending",
	});
	return { id: assessment.id, uri, cid: opts.cidValue, runKey };
}

async function buildOrchestrator(
	stages: OrchestratorStages = stubStages,
	overrides: Partial<{ maxStageRetries: number; config: typeof config }> = {},
): Promise<AssessmentOrchestrator> {
	return new AssessmentOrchestrator({
		db: testEnv.DB,
		config: overrides.config ?? config,
		signer: await signer(),
		policy: MODERATION_POLICY,
		stages,
		sleep: () => Promise.resolve(),
		...(overrides.maxStageRetries !== undefined
			? { maxStageRetries: overrides.maxStageRetries }
			: {}),
	});
}

function finding(overrides: Partial<StageFinding> & { category: string }): StageFinding {
	return {
		source: "deterministic",
		severity: "medium",
		title: "test finding",
		publicSummary: "test finding",
		privateDetail: "test finding detail",
		evidenceRefs: [],
		...overrides,
	};
}

describe("AssessmentOrchestrator: happy path", () => {
	it("finalizes passed, negates pending, issues assessment-passed, moves the pointer — one batch", async () => {
		const run = await pendingRun({ name: "happy", cidValue: await cid("happy") });
		const orchestrator = await buildOrchestrator();

		const result = await orchestrator.runAssessment(run.id);

		expect(result.state).toBe("passed");
		expect(result.completedAt).not.toBeNull();

		const pending = await testEnv.DB.prepare(
			`SELECT l.neg FROM issued_labels l JOIN issuance_actions a ON a.id = l.action_id
			 WHERE l.uri = ? AND l.cid = ? AND l.val = 'assessment-pending'`,
		)
			.bind(run.uri, run.cid)
			.first<{ neg: number }>();
		expect(pending?.neg).toBe(1);

		const passed = await testEnv.DB.prepare(
			`SELECT neg FROM issued_labels WHERE uri = ? AND cid = ? AND val = 'assessment-passed'`,
		)
			.bind(run.uri, run.cid)
			.first<{ neg: number }>();
		expect(passed?.neg).toBe(0);

		const pointer = await getCurrentAssessment(testEnv.DB, {
			src: LABELER_DID,
			uri: run.uri,
			cid: run.cid,
		});
		expect(pointer?.assessmentId).toBe(run.id);
	});

	it("atomicity: a failure while building finalization statements leaves the DB untouched", async () => {
		const run = await pendingRun({ name: "atomic", cidValue: await cid("atomic") });
		// A stale signingKeyVersion makes the very first `buildIssuanceStatements`
		// call inside `finalize` throw, before `db.batch` is ever reached.
		const orchestrator = await buildOrchestrator(stubStages, {
			config: { labelerDid: LABELER_DID, signingKeyVersion: "stale-version" },
		});

		await expect(orchestrator.runAssessment(run.id)).rejects.toThrow();

		const assessment = await getAssessment(testEnv.DB, run.id);
		expect(assessment?.state).toBe("running");
		expect(assessment?.completedAt).toBeNull();

		const labels = await testEnv.DB.prepare(`SELECT COUNT(*) AS n FROM issued_labels WHERE uri = ?`)
			.bind(run.uri)
			.first<{ n: number }>();
		expect(labels?.n).toBe(0);

		const pointer = await getCurrentAssessment(testEnv.DB, {
			src: LABELER_DID,
			uri: run.uri,
			cid: run.cid,
		});
		expect(pointer).toBeNull();
	});
});

describe("AssessmentOrchestrator: warning findings", () => {
	it("finalizes warned and issues the warning label alongside assessment-passed", async () => {
		const run = await pendingRun({ name: "warn", cidValue: await cid("warn") });
		const stages: OrchestratorStages = {
			...stubStages,
			codeAi: () => Promise.resolve([finding({ category: "obfuscated-code", severity: "medium" })]),
		};
		const orchestrator = await buildOrchestrator(stages);

		const result = await orchestrator.runAssessment(run.id);

		expect(result.state).toBe("warned");
		const label = await testEnv.DB.prepare(
			`SELECT neg FROM issued_labels WHERE uri = ? AND cid = ? AND val = 'obfuscated-code'`,
		)
			.bind(run.uri, run.cid)
			.first<{ neg: number }>();
		expect(label?.neg).toBe(0);
		const passed = await testEnv.DB.prepare(
			`SELECT neg FROM issued_labels WHERE uri = ? AND cid = ? AND val = 'assessment-passed'`,
		)
			.bind(run.uri, run.cid)
			.first<{ neg: number }>();
		expect(passed?.neg).toBe(0);
	});

	it("negates a superseded warning label while keeping assessment-passed active across the new run", async () => {
		const name = "warn-then-clean";
		const cidValue = await cid(name);
		const uri = releaseUri(name);
		await createSubject(testEnv.DB, {
			uri,
			cid: cidValue,
			did: PUBLISHER_DID,
			collection: "com.emdashcms.experimental.package.release",
			rkey: `${name}:1.0.0`,
		});

		const firstRunKey = await computeRunKey({
			uri,
			cid: cidValue,
			policyVersion: MODERATION_POLICY.policyVersion,
			modelId: "unassigned",
			promptHash: "unassigned",
			scannerSetVersion: "unassigned",
			triggerId: initialTriggerId(cidValue),
		});
		const { assessment: first } = await createAssessmentRun(testEnv.DB, {
			runKey: firstRunKey,
			uri,
			cid: cidValue,
			trigger: "initial",
			triggerId: initialTriggerId(cidValue),
			policyVersion: MODERATION_POLICY.policyVersion,
			coverageJson: "{}",
		});
		await transitionAssessmentState(testEnv.DB, {
			id: first.id,
			from: "observed",
			to: "verifying",
		});
		await transitionAssessmentState(testEnv.DB, { id: first.id, from: "verifying", to: "pending" });
		const warningStages: OrchestratorStages = {
			...stubStages,
			codeAi: () => Promise.resolve([finding({ category: "obfuscated-code", severity: "medium" })]),
		};
		const firstResult = await (await buildOrchestrator(warningStages)).runAssessment(first.id);
		expect(firstResult.state).toBe("warned");

		const secondRunKey = await computeRunKey({
			uri,
			cid: cidValue,
			policyVersion: MODERATION_POLICY.policyVersion,
			modelId: "unassigned",
			promptHash: "unassigned",
			scannerSetVersion: "unassigned",
			triggerId: operatorTriggerId("op-rerun-1"),
		});
		const { assessment: second } = await createAssessmentRun(testEnv.DB, {
			runKey: secondRunKey,
			uri,
			cid: cidValue,
			trigger: "operator",
			triggerId: operatorTriggerId("op-rerun-1"),
			policyVersion: MODERATION_POLICY.policyVersion,
			coverageJson: "{}",
		});
		await transitionAssessmentState(testEnv.DB, {
			id: second.id,
			from: "observed",
			to: "verifying",
		});
		await transitionAssessmentState(testEnv.DB, {
			id: second.id,
			from: "verifying",
			to: "pending",
		});
		const secondResult = await (await buildOrchestrator(stubStages)).runAssessment(second.id);
		expect(secondResult.state).toBe("passed");

		const obfuscated = await testEnv.DB.prepare(
			`SELECT neg FROM issued_labels WHERE uri = ? AND cid = ? AND val = 'obfuscated-code'
			 ORDER BY sequence DESC LIMIT 1`,
		)
			.bind(uri, cidValue)
			.first<{ neg: number }>();
		expect(obfuscated?.neg).toBe(1);

		const passed = await testEnv.DB.prepare(
			`SELECT neg FROM issued_labels WHERE uri = ? AND cid = ? AND val = 'assessment-passed'
			 ORDER BY sequence DESC LIMIT 1`,
		)
			.bind(uri, cidValue)
			.first<{ neg: number }>();
		expect(passed?.neg).toBe(0);
	});

	it("negates a superseded assessment-passed when a blocking run supersedes a warned run", async () => {
		const name = "warn-then-block";
		const cidValue = await cid(name);
		const uri = releaseUri(name);
		await createSubject(testEnv.DB, {
			uri,
			cid: cidValue,
			did: PUBLISHER_DID,
			collection: "com.emdashcms.experimental.package.release",
			rkey: `${name}:1.0.0`,
		});

		const firstRunKey = await computeRunKey({
			uri,
			cid: cidValue,
			policyVersion: MODERATION_POLICY.policyVersion,
			modelId: "unassigned",
			promptHash: "unassigned",
			scannerSetVersion: "unassigned",
			triggerId: initialTriggerId(cidValue),
		});
		const { assessment: first } = await createAssessmentRun(testEnv.DB, {
			runKey: firstRunKey,
			uri,
			cid: cidValue,
			trigger: "initial",
			triggerId: initialTriggerId(cidValue),
			policyVersion: MODERATION_POLICY.policyVersion,
			coverageJson: "{}",
		});
		await transitionAssessmentState(testEnv.DB, {
			id: first.id,
			from: "observed",
			to: "verifying",
		});
		await transitionAssessmentState(testEnv.DB, { id: first.id, from: "verifying", to: "pending" });
		const warningStages: OrchestratorStages = {
			...stubStages,
			codeAi: () => Promise.resolve([finding({ category: "obfuscated-code", severity: "medium" })]),
		};
		const firstResult = await (await buildOrchestrator(warningStages)).runAssessment(first.id);
		expect(firstResult.state).toBe("warned");

		const secondRunKey = await computeRunKey({
			uri,
			cid: cidValue,
			policyVersion: MODERATION_POLICY.policyVersion,
			modelId: "unassigned",
			promptHash: "unassigned",
			scannerSetVersion: "unassigned",
			triggerId: operatorTriggerId("op-rerun-2"),
		});
		const { assessment: second } = await createAssessmentRun(testEnv.DB, {
			runKey: secondRunKey,
			uri,
			cid: cidValue,
			trigger: "operator",
			triggerId: operatorTriggerId("op-rerun-2"),
			policyVersion: MODERATION_POLICY.policyVersion,
			coverageJson: "{}",
		});
		await transitionAssessmentState(testEnv.DB, {
			id: second.id,
			from: "observed",
			to: "verifying",
		});
		await transitionAssessmentState(testEnv.DB, {
			id: second.id,
			from: "verifying",
			to: "pending",
		});
		const blockingStages: OrchestratorStages = {
			...stubStages,
			codeAi: () => Promise.resolve([finding({ category: "malware", severity: "critical" })]),
		};
		const secondResult = await (await buildOrchestrator(blockingStages)).runAssessment(second.id);
		expect(secondResult.state).toBe("blocked");

		// The stale assessment-passed from the warned run must be negated: a
		// blocked release satisfying clients' install-eligibility gate through
		// a leftover pass would be a critical bypass.
		const passedAfterBlock = await testEnv.DB.prepare(
			`SELECT neg FROM issued_labels WHERE uri = ? AND cid = ? AND val = 'assessment-passed'
			 ORDER BY sequence DESC LIMIT 1`,
		)
			.bind(uri, cidValue)
			.first<{ neg: number }>();
		expect(passedAfterBlock?.neg).toBe(1);

		const blocked = await testEnv.DB.prepare(
			`SELECT neg FROM issued_labels WHERE uri = ? AND cid = ? AND val = 'malware'
			 ORDER BY sequence DESC LIMIT 1`,
		)
			.bind(uri, cidValue)
			.first<{ neg: number }>();
		expect(blocked?.neg).toBe(0);

		const staleWarning = await testEnv.DB.prepare(
			`SELECT neg FROM issued_labels WHERE uri = ? AND cid = ? AND val = 'obfuscated-code'
			 ORDER BY sequence DESC LIMIT 1`,
		)
			.bind(uri, cidValue)
			.first<{ neg: number }>();
		expect(staleWarning?.neg).toBe(1);
	});
});

describe("AssessmentOrchestrator: permanent blocking finding", () => {
	it("finalizes blocked with the mapped automated-block label", async () => {
		const run = await pendingRun({ name: "blocked", cidValue: await cid("blocked") });
		const stages: OrchestratorStages = {
			...stubStages,
			codeAi: () =>
				Promise.resolve([
					finding({ category: "artifact-integrity-failure", severity: "critical" }),
				]),
		};
		const orchestrator = await buildOrchestrator(stages);

		const result = await orchestrator.runAssessment(run.id);

		expect(result.state).toBe("blocked");
		const label = await testEnv.DB.prepare(
			`SELECT neg FROM issued_labels WHERE uri = ? AND cid = ? AND val = 'artifact-integrity-failure'`,
		)
			.bind(run.uri, run.cid)
			.first<{ neg: number }>();
		expect(label?.neg).toBe(0);
	});

	it("issues every distinct blocking label when a run has multiple critical findings", async () => {
		const run = await pendingRun({ name: "multi-block", cidValue: await cid("multi-block") });
		const stages: OrchestratorStages = {
			...stubStages,
			codeAi: () =>
				Promise.resolve([
					finding({ category: "malware", severity: "critical" }),
					finding({ category: "supply-chain-compromise", severity: "critical" }),
				]),
		};
		const orchestrator = await buildOrchestrator(stages);

		const result = await orchestrator.runAssessment(run.id);

		expect(result.state).toBe("blocked");
		const vals = await testEnv.DB.prepare(
			`SELECT val FROM issued_labels WHERE uri = ? AND cid = ? AND neg = 0 ORDER BY val`,
		)
			.bind(run.uri, run.cid)
			.all<{ val: string }>();
		const blockVals = (vals.results ?? [])
			.map((r) => r.val)
			.filter((v) => !v.startsWith("assessment-"));
		expect(blockVals).toContain("malware");
		expect(blockVals).toContain("supply-chain-compromise");
	});

	it("issues warning labels alongside a blocking label, and no assessment-passed", async () => {
		const run = await pendingRun({ name: "block-and-warn", cidValue: await cid("block-and-warn") });
		const stages: OrchestratorStages = {
			...stubStages,
			codeAi: () =>
				Promise.resolve([
					finding({ category: "malware", severity: "critical" }),
					finding({ category: "obfuscated-code", severity: "medium" }),
				]),
		};
		const orchestrator = await buildOrchestrator(stages);

		const result = await orchestrator.runAssessment(run.id);

		expect(result.state).toBe("blocked");
		const vals = await testEnv.DB.prepare(
			`SELECT val FROM issued_labels WHERE uri = ? AND cid = ? AND neg = 0 ORDER BY val`,
		)
			.bind(run.uri, run.cid)
			.all<{ val: string }>();
		const issued = (vals.results ?? []).map((r) => r.val);
		expect(issued).toContain("malware");
		expect(issued).toContain("obfuscated-code");
		expect(issued).not.toContain("assessment-passed");
	});
});

describe("AssessmentOrchestrator: transient exhaustion", () => {
	it("finalizes as error and issues assessment-error after exhausting stage retries", async () => {
		const run = await pendingRun({ name: "flaky", cidValue: await cid("flaky") });
		const stages: OrchestratorStages = {
			...stubStages,
			codeAi: () => Promise.reject(new StageTransientError("model unavailable")),
		};
		const orchestrator = await buildOrchestrator(stages, { maxStageRetries: 1 });

		const result = await orchestrator.runAssessment(run.id);

		expect(result.state).toBe("error");
		const errorLabel = await testEnv.DB.prepare(
			`SELECT neg FROM issued_labels WHERE uri = ? AND cid = ? AND val = 'assessment-error'`,
		)
			.bind(run.uri, run.cid)
			.first<{ neg: number }>();
		expect(errorLabel?.neg).toBe(0);
		const pendingNeg = await testEnv.DB.prepare(
			`SELECT neg FROM issued_labels WHERE uri = ? AND cid = ? AND val = 'assessment-pending'`,
		)
			.bind(run.uri, run.cid)
			.first<{ neg: number }>();
		expect(pendingNeg?.neg).toBe(1);
	});

	it("preserves an already-confirmed block when a later stage transient-exhausts", async () => {
		const run = await pendingRun({
			name: "block-preserved",
			cidValue: await cid("block-preserved"),
		});
		const stages: OrchestratorStages = {
			...stubStages,
			codeAi: () => Promise.resolve([finding({ category: "malware", severity: "critical" })]),
			imageAi: () => Promise.reject(new StageTransientError("vision model unavailable")),
		};

		const result = await (
			await buildOrchestrator(stages, { maxStageRetries: 1 })
		).runAssessment(run.id);

		expect(result.state).toBe("blocked");
		const block = await testEnv.DB.prepare(
			`SELECT neg FROM issued_labels WHERE uri = ? AND cid = ? AND val = 'malware'`,
		)
			.bind(run.uri, run.cid)
			.first<{ neg: number }>();
		expect(block?.neg).toBe(0);
		// A confirmed block is monotonic: the run finalizes blocked, never error or a
		// spurious pass, even though a later stage never completed.
		const error = await testEnv.DB.prepare(
			`SELECT neg FROM issued_labels WHERE uri = ? AND cid = ? AND val = 'assessment-error'`,
		)
			.bind(run.uri, run.cid)
			.first<{ neg: number }>();
		expect(error).toBeNull();
		const passed = await testEnv.DB.prepare(
			`SELECT neg FROM issued_labels WHERE uri = ? AND cid = ? AND val = 'assessment-passed'`,
		)
			.bind(run.uri, run.cid)
			.first<{ neg: number }>();
		expect(passed).toBeNull();
	});

	it("finalizes error, not warned, when only a warning preceded a later stage's exhaustion", async () => {
		const run = await pendingRun({
			name: "warn-then-exhaust",
			cidValue: await cid("warn-then-exhaust"),
		});
		const stages: OrchestratorStages = {
			...stubStages,
			codeAi: () => Promise.resolve([finding({ category: "obfuscated-code", severity: "medium" })]),
			imageAi: () => Promise.reject(new StageTransientError("vision model unavailable")),
		};

		const result = await (
			await buildOrchestrator(stages, { maxStageRetries: 1 })
		).runAssessment(run.id);

		// A warning is not monotonic — an unrun stage might have found a block — so
		// an incomplete run with only a warning must retry as error, never warned.
		expect(result.state).toBe("error");
		const errorLabel = await testEnv.DB.prepare(
			`SELECT neg FROM issued_labels WHERE uri = ? AND cid = ? AND val = 'assessment-error'`,
		)
			.bind(run.uri, run.cid)
			.first<{ neg: number }>();
		expect(errorLabel?.neg).toBe(0);
		const warnLabel = await testEnv.DB.prepare(
			`SELECT neg FROM issued_labels WHERE uri = ? AND cid = ? AND val = 'obfuscated-code'`,
		)
			.bind(run.uri, run.cid)
			.first<{ neg: number }>();
		expect(warnLabel).toBeNull();
	});

	it("a second error run for the same subject leaves assessment-error active, not self-negated", async () => {
		const cidValue = await cid("double-error");
		const flaky: OrchestratorStages = {
			...stubStages,
			codeAi: () => Promise.reject(new StageTransientError("model unavailable")),
		};
		const first = await pendingRun({ name: "double-error", cidValue });
		expect(
			(await (await buildOrchestrator(flaky, { maxStageRetries: 1 })).runAssessment(first.id))
				.state,
		).toBe("error");

		const second = await pendingRun({
			name: "double-error",
			cidValue,
			triggerId: operatorTriggerId("rerun-1"),
		});
		expect(
			(await (await buildOrchestrator(flaky, { maxStageRetries: 1 })).runAssessment(second.id))
				.state,
		).toBe("error");

		// The second error run must not negate the assessment-error it (and the
		// first run) issued: the current stream head stays active.
		const head = await testEnv.DB.prepare(
			`SELECT neg FROM issued_labels WHERE uri = ? AND cid = ? AND val = 'assessment-error'
			 ORDER BY sequence DESC LIMIT 1`,
		)
			.bind(first.uri, cidValue)
			.first<{ neg: number }>();
		expect(head?.neg).toBe(0);
	});
});

describe("AssessmentOrchestrator: deleted or superseded subject", () => {
	it("finalizes stale, issues nothing, and leaves the pointer untouched when the subject is deleted mid-run", async () => {
		const run = await pendingRun({
			name: "deleted-during-run",
			cidValue: await cid("deleted-during-run"),
		});
		await deleteSubject(testEnv.DB, { uri: run.uri, cid: run.cid });
		const orchestrator = await buildOrchestrator();

		const result = await orchestrator.runAssessment(run.id);

		expect(result.state).toBe("stale");
		const labels = await testEnv.DB.prepare(`SELECT COUNT(*) AS n FROM issued_labels WHERE uri = ?`)
			.bind(run.uri)
			.first<{ n: number }>();
		expect(labels?.n).toBe(0);
		const pointer = await getCurrentAssessment(testEnv.DB, {
			src: LABELER_DID,
			uri: run.uri,
			cid: run.cid,
		});
		expect(pointer).toBeNull();
	});

	it("finalizes stale when the subject is deleted mid-run, after the first currency check", async () => {
		const run = await pendingRun({
			name: "deleted-mid-run",
			cidValue: await cid("deleted-mid-run"),
		});
		// A stage deletes the subject during the run — after runAssessment's
		// entry currency check passed, before finalize's re-check.
		const stages: OrchestratorStages = {
			...stubStages,
			codeAi: async () => {
				await deleteSubject(testEnv.DB, { uri: run.uri, cid: run.cid });
				return [];
			},
		};
		const orchestrator = await buildOrchestrator(stages);

		const result = await orchestrator.runAssessment(run.id);

		expect(result.state).toBe("stale");
		const labels = await testEnv.DB.prepare(`SELECT COUNT(*) AS n FROM issued_labels WHERE uri = ?`)
			.bind(run.uri)
			.first<{ n: number }>();
		expect(labels?.n).toBe(0);
	});

	it("finalizes stale when a newer CID has superseded this run's subject", async () => {
		const name = "superseded-cid";
		const cidV1 = await cid(`${name}-v1`);
		const cidV2 = await cid(`${name}-v2`);
		const run = await pendingRun({ name, cidValue: cidV1 });
		// A newer observation for the same URI, different CID.
		await createSubject(testEnv.DB, {
			uri: run.uri,
			cid: cidV2,
			did: PUBLISHER_DID,
			collection: "com.emdashcms.experimental.package.release",
			rkey: `${name}:1.0.0`,
			now: new Date(Date.now() + 1000),
		});
		const orchestrator = await buildOrchestrator();

		const result = await orchestrator.runAssessment(run.id);

		expect(result.state).toBe("stale");
	});
});

describe("AssessmentOrchestrator: invalid findings", () => {
	it("aborts the run, leaving it running, when a stage returns a finding outside the allowed category set", async () => {
		const run = await pendingRun({
			name: "invalid-category",
			cidValue: await cid("invalid-category"),
		});
		const stages: OrchestratorStages = {
			...stubStages,
			codeAi: () =>
				Promise.resolve([finding({ category: "not-a-real-label", severity: "critical" })]),
		};
		const orchestrator = await buildOrchestrator(stages);

		await expect(orchestrator.runAssessment(run.id)).rejects.toThrow(FindingValidationError);

		const assessment = await getAssessment(testEnv.DB, run.id);
		expect(assessment?.state).toBe("running");
		expect(assessment?.completedAt).toBeNull();
	});

	it("aborts the run when a finding cites an evidence reference this run never recorded", async () => {
		const run = await pendingRun({
			name: "unresolved-evidence",
			cidValue: await cid("unresolved-evidence"),
		});
		const stages: OrchestratorStages = {
			...stubStages,
			codeAi: () =>
				Promise.resolve([
					finding({
						category: "obfuscated-code",
						severity: "medium",
						evidenceRefs: ["evid_never_recorded"],
					}),
				]),
		};
		const orchestrator = await buildOrchestrator(stages);

		await expect(orchestrator.runAssessment(run.id)).rejects.toThrow(FindingValidationError);

		const assessment = await getAssessment(testEnv.DB, run.id);
		expect(assessment?.state).toBe("running");
	});
});

describe("AssessmentOrchestrator: resume from running", () => {
	it("resumes a run left `running` by a crashed attempt and finalizes on the next call", async () => {
		const run = await pendingRun({ name: "resume-running", cidValue: await cid("resume-running") });
		let attempts = 0;
		const flaky: StageAdapter = () => {
			attempts += 1;
			// Attempt 1: a non-transient failure after the pending→running CAS
			// (models a crash in a later stage or in finalize). Later attempts pass.
			if (attempts === 1) throw new Error("stage crashed post-transition");
			return Promise.resolve([]);
		};
		const orchestrator = await buildOrchestrator({ ...stubStages, codeAi: flaky });

		await expect(orchestrator.runAssessment(run.id)).rejects.toThrow(
			"stage crashed post-transition",
		);
		expect((await getAssessment(testEnv.DB, run.id))?.state).toBe("running");

		// Re-invoking (as the durable step retry does) resumes the `running` row
		// and finalizes passed — no pending-guard rejection, no duplicate labels.
		const finalized = await orchestrator.runAssessment(run.id);
		expect(finalized.state).toBe("passed");

		const pending = await testEnv.DB.prepare(
			`SELECT l.neg FROM issued_labels l JOIN issuance_actions a ON a.id = l.action_id
			 WHERE l.uri = ? AND l.cid = ? AND l.val = 'assessment-pending'`,
		)
			.bind(run.uri, run.cid)
			.first<{ neg: number }>();
		expect(pending?.neg).toBe(1);
	});
});

describe("AssessmentOrchestrator: cancel racing finalization", () => {
	it("issues no labels and throws when a cancel moves the run out of running before commit", async () => {
		const run = await pendingRun({ name: "cancel-race", cidValue: await cid("cancel-race") });
		// A stage that cancels the run mid-flight simulates a delete/operator cancel
		// landing after the currency check but before the finalization batch commits.
		const cancelDuringStage: StageAdapter = async () => {
			await transitionAssessmentState(testEnv.DB, {
				id: run.id,
				from: "running",
				to: "cancelled",
			});
			return [];
		};
		const orchestrator = await buildOrchestrator({
			...stubStages,
			codeAi: cancelDuringStage,
		});

		await expect(orchestrator.runAssessment(run.id)).rejects.toBeInstanceOf(
			AssessmentFinalizationConflictError,
		);

		// The run stays cancelled and NO label was issued — not the positive
		// outcome label, not even the assessment-pending negation.
		expect((await getAssessment(testEnv.DB, run.id))?.state).toBe("cancelled");
		const labels = await testEnv.DB.prepare(
			`SELECT COUNT(*) AS n FROM issued_labels l
			 JOIN issuance_actions a ON a.id = l.action_id
			 WHERE a.assessment_id = ?`,
		)
			.bind(run.id)
			.first<{ n: number }>();
		expect(labels?.n).toBe(0);
	});
});

describe("AssessmentOrchestrator: history stage never auto-labels (W8.4)", () => {
	it("runs the history stage, whose finding surfaces but is never turned into an issued label", async () => {
		const run = await pendingRun({
			name: "history-invariant",
			cidValue: await cid("history-invariant"),
		});

		// Seed an explicit prior release under the same DID so the stage genuinely
		// produces a publisher-history finding without relying on other tests'
		// state — keeps the non-vacuousness assertion below self-contained.
		await createSubject(testEnv.DB, {
			uri: releaseUri("history-invariant-prior"),
			cid: await cid("history-invariant-prior"),
			did: PUBLISHER_DID,
			collection: "com.emdashcms.experimental.package.release",
			rkey: "history-invariant-prior:1.0.0",
		});
		const assessment = await getAssessment(testEnv.DB, run.id);
		const produced = await analyzeHistory(testEnv.DB, assessment!, { src: LABELER_DID });
		// Assert the specific finding the seeded prior release produces, not just
		// "any history category" — so a regression in the prior-release path can't
		// pass on the back of an unrelated history finding.
		expect(produced.some((f) => f.category === "publisher-history")).toBe(true);

		const stages: OrchestratorStages = {
			...stubStages,
			history: (ctx) => analyzeHistory(testEnv.DB, ctx.assessment, { src: LABELER_DID }),
		};
		const result = await (await buildOrchestrator(stages)).runAssessment(run.id);

		// The history finding flowed through validation (it did not abort the run)
		// and resolution, yet produced no blocking or warning outcome.
		expect(result.state).toBe("passed");

		// No history-category value is ever issued as a label — the resolver drops
		// every history-source finding before any category→label mapping.
		const labels = await testEnv.DB.prepare(`SELECT val FROM issued_labels WHERE uri = ?`)
			.bind(run.uri)
			.all<{ val: string }>();
		const issued = (labels.results ?? []).map((row) => row.val);
		for (const category of HISTORY_FINDING_CATEGORIES) expect(issued).not.toContain(category);
	});
});

describe("AssessmentOrchestrator: supersession negation provenance (decision 6)", () => {
	it("negates the prior run's automated block label but never a manually-issued label", async () => {
		const name = "supersede-manual-survives";
		const cidValue = await cid(name);
		const uri = releaseUri(name);
		await createSubject(testEnv.DB, {
			uri,
			cid: cidValue,
			did: PUBLISHER_DID,
			collection: "com.emdashcms.experimental.package.release",
			rkey: `${name}:1.0.0`,
		});

		// First automated run: blocks on a critical finding.
		const firstRunKey = await computeRunKey({
			uri,
			cid: cidValue,
			policyVersion: MODERATION_POLICY.policyVersion,
			modelId: "unassigned",
			promptHash: "unassigned",
			scannerSetVersion: "unassigned",
			triggerId: initialTriggerId(cidValue),
		});
		const { assessment: first } = await createAssessmentRun(testEnv.DB, {
			runKey: firstRunKey,
			uri,
			cid: cidValue,
			trigger: "initial",
			triggerId: initialTriggerId(cidValue),
			policyVersion: MODERATION_POLICY.policyVersion,
			coverageJson: "{}",
		});
		await transitionAssessmentState(testEnv.DB, {
			id: first.id,
			from: "observed",
			to: "verifying",
		});
		await transitionAssessmentState(testEnv.DB, { id: first.id, from: "verifying", to: "pending" });
		const blockingStages: OrchestratorStages = {
			...stubStages,
			codeAi: () => Promise.resolve([finding({ category: "malware", severity: "critical" })]),
		};
		const firstResult = await (await buildOrchestrator(blockingStages)).runAssessment(first.id);
		expect(firstResult.state).toBe("blocked");

		// A reviewer manually yanks the release for security reasons — a
		// human action, never a candidate for automated negation. Per the
		// policy fixture, security-yanked forbids a CID.
		await issueManualLabel(
			testEnv.DB,
			config,
			await signer(),
			{
				actor: LABELER_DID,
				type: "manual-label",
				reason: "reviewer: confirmed security issue",
				idempotencyKey: `manual-${name}`,
			},
			{ uri, val: "security-yanked" },
		);

		// Second automated run supersedes the first: the malware finding is
		// gone, so this run passes.
		const secondRunKey = await computeRunKey({
			uri,
			cid: cidValue,
			policyVersion: MODERATION_POLICY.policyVersion,
			modelId: "unassigned",
			promptHash: "unassigned",
			scannerSetVersion: "unassigned",
			triggerId: operatorTriggerId("op-rerun-1"),
		});
		const { assessment: second } = await createAssessmentRun(testEnv.DB, {
			runKey: secondRunKey,
			uri,
			cid: cidValue,
			trigger: "operator",
			triggerId: operatorTriggerId("op-rerun-1"),
			policyVersion: MODERATION_POLICY.policyVersion,
			coverageJson: "{}",
		});
		await transitionAssessmentState(testEnv.DB, {
			id: second.id,
			from: "observed",
			to: "verifying",
		});
		await transitionAssessmentState(testEnv.DB, {
			id: second.id,
			from: "verifying",
			to: "pending",
		});
		const secondResult = await (await buildOrchestrator(stubStages)).runAssessment(second.id);
		expect(secondResult.state).toBe("passed");

		// The prior automated "malware" label is negated...
		const malware = await testEnv.DB.prepare(
			`SELECT l.neg FROM issued_labels l
			 JOIN issuance_actions a ON a.id = l.action_id
			 WHERE l.uri = ? AND l.cid = ? AND l.val = 'malware'
			 ORDER BY l.sequence DESC LIMIT 1`,
		)
			.bind(uri, cidValue)
			.first<{ neg: number }>();
		expect(malware?.neg).toBe(1);

		// ...but the manually-issued security-yanked label survives untouched:
		// exactly one row, never negated.
		const manual = await testEnv.DB.prepare(
			`SELECT COUNT(*) AS n FROM issued_labels WHERE uri = ? AND val = 'security-yanked'`,
		)
			.bind(uri)
			.first<{ n: number }>();
		expect(manual?.n).toBe(1);
		const manualRow = await testEnv.DB.prepare(
			`SELECT neg FROM issued_labels WHERE uri = ? AND val = 'security-yanked'`,
		)
			.bind(uri)
			.first<{ neg: number }>();
		expect(manualRow?.neg).toBe(0);

		// The pointer moved to the superseding run.
		const pointer = await getCurrentAssessment(testEnv.DB, {
			src: LABELER_DID,
			uri,
			cid: cidValue,
		});
		expect(pointer?.assessmentId).toBe(second.id);
	});
});

describe("AssessmentOrchestrator: real acquire stage (W7.2)", () => {
	const resolveHostname = async () => ["203.0.113.5"];

	function targetFor(
		checksum: string,
	): (assessment: { uri: string }) => Promise<AcquisitionTarget> {
		return async () => ({
			url: "https://cdn.example.test/plugin.tgz",
			checksum,
			slug: "test-plugin",
			version: "1.0.0",
		});
	}

	it("acquires the bundle, feeds its file set to a downstream stage, and finalizes passed", async () => {
		const run = await pendingRun({ name: "acquire-ok", cidValue: await cid("acquire-ok") });
		const bytes = await canonicalBundle();
		const holder: AcquisitionHolder = {};
		let downstreamFiles: readonly string[] = [];

		const acquire = createAcquireStage({
			deps: { fetch: async () => new Response(bytes), resolveHostname },
			resolveTarget: targetFor(await checksumOf(bytes)),
			holder,
		});
		// Stand-in for the code stage: reads the acquired file set the way the
		// real codeAi wiring will.
		const codeAi: StageAdapter = () => {
			downstreamFiles = (holder.result?.files ?? []).map((f) => f.path);
			return Promise.resolve([]);
		};
		const orchestrator = await buildOrchestrator({ ...stubStages, acquire, codeAi });

		const result = await orchestrator.runAssessment(run.id);

		expect(result.state).toBe("passed");
		expect(holder.result?.source).toBe("declared-url");
		expect(downstreamFiles).toEqual(["manifest.json", "backend.js"]);
	});

	it("blocks with artifact-integrity-failure when the fetched bytes miss the signed checksum", async () => {
		const run = await pendingRun({
			name: "acquire-integrity",
			cidValue: await cid("acquire-integrity"),
		});
		const served = await canonicalBundle([file("tampered.js", "steal();")]);
		const pinned = await checksumOf(await canonicalBundle());
		const acquire = createAcquireStage({
			deps: { fetch: async () => new Response(served), resolveHostname },
			resolveTarget: targetFor(pinned),
			holder: {},
		});
		const orchestrator = await buildOrchestrator({ ...stubStages, acquire });

		const result = await orchestrator.runAssessment(run.id);

		expect(result.state).toBe("blocked");
		const label = await testEnv.DB.prepare(
			`SELECT neg FROM issued_labels WHERE uri = ? AND cid = ? AND val = 'artifact-integrity-failure'`,
		)
			.bind(run.uri, run.cid)
			.first<{ neg: number }>();
		expect(label?.neg).toBe(0);
	});

	it("retries then finalizes error when the declared URL is unfetchable", async () => {
		const run = await pendingRun({
			name: "acquire-transient",
			cidValue: await cid("acquire-transient"),
		});
		let attempts = 0;
		const acquire = createAcquireStage({
			deps: {
				fetch: async () => {
					attempts += 1;
					await Promise.resolve();
					throw new TypeError("origin unreachable");
				},
				resolveHostname,
			},
			resolveTarget: targetFor(await checksumOf(await canonicalBundle())),
			holder: {},
		});
		const orchestrator = await buildOrchestrator(
			{ ...stubStages, acquire },
			{ maxStageRetries: 1 },
		);

		const result = await orchestrator.runAssessment(run.id);

		expect(result.state).toBe("error");
		expect(attempts).toBe(2);
		const error = await testEnv.DB.prepare(
			`SELECT neg FROM issued_labels WHERE uri = ? AND cid = ? AND val = 'assessment-error'`,
		)
			.bind(run.uri, run.cid)
			.first<{ neg: number }>();
		expect(error?.neg).toBe(0);
	});
});

describe("AssessmentOrchestrator: live publication (Finding 4)", () => {
	it("issues finalization labels publication_pending and broadcasts each to the publisher", async () => {
		const run = await pendingRun({ name: "publish-live", cidValue: await cid("publish-live") });
		const { publisher, published } = recordingPublisher(true);
		const orchestrator = new AssessmentOrchestrator({
			db: testEnv.DB,
			config,
			signer: await signer(),
			policy: MODERATION_POLICY,
			stages: stubStages,
			sleep: () => Promise.resolve(),
			publisher,
		});

		const result = await orchestrator.runAssessment(run.id);
		expect(result.state).toBe("passed");

		// Every label this run committed was broadcast: the assessment-pending
		// negation and the assessment-passed positive.
		const publishedVals = published.map((p) => p.label.val).toSorted();
		expect(publishedVals).toEqual(["assessment-passed", "assessment-pending"]);

		// A publisher that manages publication state (the real DO clears the flag on
		// /notify) leaves the rows pending here — the fake never cleared them.
		const pending = await testEnv.DB.prepare(
			`SELECT COUNT(*) AS n FROM issued_labels WHERE uri = ? AND cid = ? AND publication_pending = 1`,
		)
			.bind(run.uri, run.cid)
			.first<{ n: number }>();
		expect(pending?.n).toBe(2);
	});

	it("clears publication_pending via markPublicationAccepted for a non-managing publisher", async () => {
		const run = await pendingRun({ name: "publish-accept", cidValue: await cid("publish-accept") });
		const { publisher, published } = recordingPublisher(false);
		const orchestrator = new AssessmentOrchestrator({
			db: testEnv.DB,
			config,
			signer: await signer(),
			policy: MODERATION_POLICY,
			stages: stubStages,
			sleep: () => Promise.resolve(),
			publisher,
		});

		await orchestrator.runAssessment(run.id);
		expect(published.length).toBe(2);

		const pending = await testEnv.DB.prepare(
			`SELECT COUNT(*) AS n FROM issued_labels WHERE uri = ? AND cid = ? AND publication_pending = 1`,
		)
			.bind(run.uri, run.cid)
			.first<{ n: number }>();
		expect(pending?.n).toBe(0);
	});

	it("finalizes and leaves rows publication_pending when the notify fails — the sweep backstops", async () => {
		const run = await pendingRun({ name: "publish-fail", cidValue: await cid("publish-fail") });
		const failing: LabelPublisher = {
			managesPublicationState: true,
			publish: () => Promise.reject(new Error("subscription DO unreachable")),
		};
		const orchestrator = new AssessmentOrchestrator({
			db: testEnv.DB,
			config,
			signer: await signer(),
			policy: MODERATION_POLICY,
			stages: stubStages,
			sleep: () => Promise.resolve(),
			publisher: failing,
		});

		// A dropped notify never fails the run: the batch already committed.
		const result = await orchestrator.runAssessment(run.id);
		expect(result.state).toBe("passed");

		const pending = await testEnv.DB.prepare(
			`SELECT COUNT(*) AS n FROM issued_labels WHERE uri = ? AND cid = ? AND publication_pending = 1`,
		)
			.bind(run.uri, run.cid)
			.first<{ n: number }>();
		expect(pending?.n).toBe(2);
	});

	it("issues finalization labels already-published (publication_pending = 0) when no publisher is wired", async () => {
		const run = await pendingRun({ name: "publish-none", cidValue: await cid("publish-none") });
		const orchestrator = await buildOrchestrator();

		await orchestrator.runAssessment(run.id);

		const pending = await testEnv.DB.prepare(
			`SELECT COUNT(*) AS n FROM issued_labels WHERE uri = ? AND cid = ? AND publication_pending = 1`,
		)
			.bind(run.uri, run.cid)
			.first<{ n: number }>();
		expect(pending?.n).toBe(0);
	});
});

describe("AssessmentOrchestrator: signing pause between prep and commit (Finding 6)", () => {
	it("leaves the run running and issues no labels when signing pauses before the batch commits", async () => {
		const run = await pendingRun({ name: "pause-race", cidValue: await cid("pause-race") });
		const rotationId = "finding6-pause";
		// Pause signing in the seam between finalization prep (statements built while
		// active) and the batch commit.
		const db = pauseBeforeFirstBatch(testEnv.DB, async () => {
			await beginRoutineKeyRotation(testEnv.DB, {
				rotationId,
				expectedActiveKeyVersion: "v1",
				nextKeyVersion: "v2-finding6",
				nextPublicKeyMultibase: ROTATED_MULTIKEY,
			});
		});
		const orchestrator = new AssessmentOrchestrator({
			db,
			config,
			signer: await signer(),
			policy: MODERATION_POLICY,
			stages: stubStages,
			sleep: () => Promise.resolve(),
		});

		// The CAS shares the issuance signing guard, so the whole batch no-ops: the
		// finalization conflict is raised rather than a suppressed-label signing error.
		await expect(orchestrator.runAssessment(run.id)).rejects.toBeInstanceOf(
			AssessmentFinalizationConflictError,
		);

		// The run is still running (not stranded terminal) and NO label leaked.
		expect((await getAssessment(testEnv.DB, run.id))?.state).toBe("running");
		const labels = await testEnv.DB.prepare(
			`SELECT COUNT(*) AS n FROM issued_labels l JOIN issuance_actions a ON a.id = l.action_id
			 WHERE a.assessment_id = ?`,
		)
			.bind(run.id)
			.first<{ n: number }>();
		expect(labels?.n).toBe(0);

		// Resume signing and re-run (as the Workflow retry does): finalization now
		// completes and issues the labels the paused attempt withheld.
		await abortRoutineKeyRotation(testEnv.DB, {
			rotationId,
			expectedPendingKeyVersion: "v2-finding6",
		});
		const resumed = new AssessmentOrchestrator({
			db: testEnv.DB,
			config,
			signer: await signer(),
			policy: MODERATION_POLICY,
			stages: stubStages,
			sleep: () => Promise.resolve(),
		});
		const finalized = await resumed.runAssessment(run.id);
		expect(finalized.state).toBe("passed");
		const pendingNeg = await testEnv.DB.prepare(
			`SELECT neg FROM issued_labels WHERE uri = ? AND cid = ? AND val = 'assessment-pending'`,
		)
			.bind(run.uri, run.cid)
			.first<{ neg: number }>();
		expect(pendingNeg?.neg).toBe(1);
	});
});

describe("AssessmentOrchestrator: delete racing finalization (Blocker 1)", () => {
	it("commits no outcome/block labels when the subject is tombstoned between the currency re-check and the batch", async () => {
		const run = await pendingRun({ name: "delete-toctou", cidValue: await cid("delete-toctou") });
		const blockingStages: OrchestratorStages = {
			...stubStages,
			codeAi: () => Promise.resolve([finding({ category: "malware", severity: "critical" })]),
		};
		// Tombstone the subject in the seam between finalize's currency re-check and
		// the batch commit — the exact TOCTOU window the CAS subject-guard closes.
		const db = pauseBeforeFirstBatch(testEnv.DB, async () => {
			await deleteSubject(testEnv.DB, { uri: run.uri, cid: run.cid });
		});
		const orchestrator = new AssessmentOrchestrator({
			db,
			config,
			signer: await signer(),
			policy: MODERATION_POLICY,
			stages: blockingStages,
			sleep: () => Promise.resolve(),
		});

		// The guarded CAS no-ops against the tombstone, so the whole batch commits
		// nothing and the finalization conflict is raised.
		await expect(orchestrator.runAssessment(run.id)).rejects.toBeInstanceOf(
			AssessmentFinalizationConflictError,
		);

		// The run is still running and NO label — not the block, not even the pending
		// negation — was committed for the now-deleted subject.
		expect((await getAssessment(testEnv.DB, run.id))?.state).toBe("running");
		const labels = await testEnv.DB.prepare(
			`SELECT COUNT(*) AS n FROM issued_labels l JOIN issuance_actions a ON a.id = l.action_id
			 WHERE a.assessment_id = ?`,
		)
			.bind(run.id)
			.first<{ n: number }>();
		expect(labels?.n).toBe(0);

		// The Workflow retry re-runs finalization, sees the deleted subject, and
		// stales the run out — still never labelling a deleted release.
		const resumed = new AssessmentOrchestrator({
			db: testEnv.DB,
			config,
			signer: await signer(),
			policy: MODERATION_POLICY,
			stages: blockingStages,
			sleep: () => Promise.resolve(),
		});
		const finalized = await resumed.runAssessment(run.id);
		expect(finalized.state).toBe("stale");
		const labelsAfter = await testEnv.DB.prepare(
			`SELECT COUNT(*) AS n FROM issued_labels l JOIN issuance_actions a ON a.id = l.action_id
			 WHERE a.assessment_id = ?`,
		)
			.bind(run.id)
			.first<{ n: number }>();
		expect(labelsAfter?.n).toBe(0);
	});
});

/** Issues a run's initial positive `assessment-pending`, the way the discovery
 * consumer does, so the subject carries a live pending gate before a run finalizes. */
async function issuePendingPositive(run: {
	id: string;
	uri: string;
	cid: string;
	runKey: string;
}): Promise<void> {
	await issueAutomatedAssessmentLabel(
		testEnv.DB,
		config,
		await signer(),
		{
			actor: LABELER_DID,
			type: "automated-assessment",
			assessmentId: run.id,
			reason: "initial discovery",
			idempotencyKey: automatedIdempotencyKey(run.runKey, "assessment-pending", false),
		},
		{ uri: run.uri, cid: run.cid, val: "assessment-pending" },
	);
}

describe("AssessmentOrchestrator: concurrent runs share one pending gate", () => {
	it("keeps assessment-pending live while a sibling run for the same subject is in flight, clearing it only when the last run finalizes", async () => {
		const cidValue = await cid("shared-pending");
		const runA = await pendingRun({
			name: "shared-pending",
			cidValue,
			triggerId: initialTriggerId(cidValue),
		});
		const runB = await pendingRun({
			name: "shared-pending",
			cidValue,
			triggerId: operatorTriggerId("op-shared-pending"),
		});
		await issuePendingPositive(runA);
		await issuePendingPositive(runB);

		const orchestrator = await buildOrchestrator();

		// A finalizes while B is still `pending`. Its own pending-negation is
		// suppressed, so the gate B also depends on stays live.
		const a = await orchestrator.runAssessment(runA.id);
		expect(a.state).toBe("passed");

		const aNegation = await readIssuedLabelByActionKey(
			testEnv.DB,
			automatedIdempotencyKey(runA.runKey, "assessment-pending", true),
		);
		expect(aNegation).toBeNull();

		const gateWhileBActive = await getActiveLabelState(testEnv.DB, {
			src: LABELER_DID,
			uri: runA.uri,
			cid: cidValue,
		});
		expect(gateWhileBActive.get("assessment-pending")?.active).toBe(true);

		// B is the last run in flight; finalizing it clears the shared gate.
		const b = await orchestrator.runAssessment(runB.id);
		expect(b.state).toBe("passed");

		const bNegation = await readIssuedLabelByActionKey(
			testEnv.DB,
			automatedIdempotencyKey(runB.runKey, "assessment-pending", true),
		);
		expect(bNegation).not.toBeNull();

		const gateAfterLast = await getActiveLabelState(testEnv.DB, {
			src: LABELER_DID,
			uri: runB.uri,
			cid: cidValue,
		});
		expect(gateAfterLast.get("assessment-pending")?.active).toBe(false);
	});
});

describe("AssessmentOrchestrator: automation pause between prep and commit", () => {
	it("leaves the run running and issues no labels when automation pauses before the batch commits", async () => {
		const run = await pendingRun({
			name: "automation-pause",
			cidValue: await cid("automation-pause"),
		});
		// Pause automation in the seam between finalization prep (statements built
		// while unpaused) and the batch commit.
		const db = pauseBeforeFirstBatch(testEnv.DB, async () => {
			await testEnv.DB.prepare(`UPDATE automation_state SET paused = 1 WHERE id = 1`).run();
		});
		const orchestrator = new AssessmentOrchestrator({
			db,
			config,
			signer: await signer(),
			policy: MODERATION_POLICY,
			stages: stubStages,
			sleep: () => Promise.resolve(),
		});

		// The CAS carries the automation guard, so the whole batch no-ops and the
		// finalization conflict is raised rather than terminal state with labels.
		await expect(orchestrator.runAssessment(run.id)).rejects.toBeInstanceOf(
			AssessmentFinalizationConflictError,
		);

		expect((await getAssessment(testEnv.DB, run.id))?.state).toBe("running");
		const labels = await testEnv.DB.prepare(
			`SELECT COUNT(*) AS n FROM issued_labels l JOIN issuance_actions a ON a.id = l.action_id
			 WHERE a.assessment_id = ?`,
		)
			.bind(run.id)
			.first<{ n: number }>();
		expect(labels?.n).toBe(0);

		// Resume automation and re-run (as the Workflow retry does): finalization now
		// completes and issues the labels the paused attempt withheld.
		await testEnv.DB.prepare(`UPDATE automation_state SET paused = 0 WHERE id = 1`).run();
		const resumed = new AssessmentOrchestrator({
			db: testEnv.DB,
			config,
			signer: await signer(),
			policy: MODERATION_POLICY,
			stages: stubStages,
			sleep: () => Promise.resolve(),
		});
		const finalized = await resumed.runAssessment(run.id);
		expect(finalized.state).toBe("passed");
		const pendingNeg = await testEnv.DB.prepare(
			`SELECT neg FROM issued_labels WHERE uri = ? AND cid = ? AND val = 'assessment-pending'`,
		)
			.bind(run.uri, run.cid)
			.first<{ neg: number }>();
		expect(pendingNeg?.neg).toBe(1);
	});
});
