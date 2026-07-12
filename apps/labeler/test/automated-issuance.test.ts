import { createLabelSigner, type LabelDidDocument } from "@emdash-cms/registry-moderation";
import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import {
	automatedIdempotencyKey,
	computeRunKey,
	initialTriggerId,
} from "../src/assessment-lifecycle.js";
import { createAssessmentRun, createSubject } from "../src/assessment-store.js";
import {
	buildIssuanceStatements,
	issueAutomatedAssessmentLabel,
	type AutomatedIssuanceAction,
	type AutomatedLabelProposal,
} from "../src/service.js";
import { initializeSigningState } from "../src/signing-rotation.js";

interface TestEnv {
	DB: D1Database;
	TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
}

const testEnv = env as unknown as TestEnv;
const LABELER_DID = "did:web:labels.emdashcms.com";
const PUBLISHER_DID = "did:plc:publisher000000000000000000";
const PRIVATE_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAE";
const MULTIKEY = "zDnaepsL7AXenJkVYdkh5KuKsSU7Ykh7kyXaLLU7auN9FWSiZ";
const CID = "bafkreif4oaymum54i5qefbwoblrt5zasfjhpyhyvacpseqtehi3queew5m";
const config = { labelerDid: LABELER_DID, signingKeyVersion: "v1" };
let releaseCounter = 0;

beforeAll(async () => {
	await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
	await initializeSigningState(testEnv.DB, {
		issuerDid: LABELER_DID,
		keyVersion: "v1",
		publicKeyMultibase: MULTIKEY,
	});
});

function releaseUri(name?: string): string {
	releaseCounter++;
	return `at://${PUBLISHER_DID}/com.emdashcms.experimental.package.release/${name ?? `automated-${releaseCounter}`}:1.0.0`;
}

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

async function signer() {
	return createLabelSigner({
		issuerDid: LABELER_DID,
		privateKey: PRIVATE_KEY,
		resolveDid: async () => document(),
	});
}

async function assessmentId(): Promise<string> {
	const uri = releaseUri();
	await createSubject(testEnv.DB, {
		uri,
		cid: CID,
		did: PUBLISHER_DID,
		collection: "com.emdashcms.experimental.package.release",
		rkey: uri.split("/").at(-1)!,
	});
	const runKey = await computeRunKey({
		uri,
		cid: CID,
		policyVersion: "v1",
		modelId: "m",
		promptHash: "p",
		scannerSetVersion: "v1",
		triggerId: initialTriggerId(CID),
	});
	const { assessment } = await createAssessmentRun(testEnv.DB, {
		runKey,
		uri,
		cid: CID,
		trigger: "initial",
		triggerId: initialTriggerId(CID),
		policyVersion: "v1",
		scannerVersionsJson: "[]",
		coverageJson: "{}",
	});
	return assessment.id;
}

async function countLabels(uri: string, val: string): Promise<number> {
	const row = await testEnv.DB.prepare(
		`SELECT COUNT(*) AS n FROM issued_labels WHERE uri = ? AND val = ?`,
	)
		.bind(uri, val)
		.first<{ n: number }>();
	return row?.n ?? 0;
}

function action(
	overrides: Partial<AutomatedIssuanceAction> & { assessmentId: string },
): AutomatedIssuanceAction {
	return {
		actor: LABELER_DID,
		type: "automated-assessment",
		reason: "automated assessment",
		idempotencyKey: `automated-test-${Math.random()}`,
		...overrides,
	};
}

async function issue(
	uri: string,
	assessment: string,
	proposal: Partial<AutomatedLabelProposal> & { val: string },
): ReturnType<typeof issueAutomatedAssessmentLabel> {
	// `return await`, not a bare `return`, so a rejection surfaces within this
	// function's own execution instead of an extra promise-adoption tick that
	// vitest's rejection tracker can flag as unhandled before `.rejects`
	// attaches its handler on the caller's promise.
	return await issueAutomatedAssessmentLabel(
		testEnv.DB,
		config,
		await signer(),
		action({ assessmentId: assessment }),
		{ uri, cid: CID, ...proposal },
	);
}

describe("automated proposal validation", () => {
	it("accepts an eligibility label with a release URI and CID", async () => {
		const uri = releaseUri();
		const id = await assessmentId();
		const issued = await issue(uri, id, { val: "assessment-passed" });
		expect(issued.label).toMatchObject({
			src: LABELER_DID,
			uri,
			cid: CID,
			val: "assessment-passed",
		});
	});

	it("accepts assessment-pending and assessment-error", async () => {
		const uri = releaseUri();
		const id = await assessmentId();
		await expect(issue(uri, id, { val: "assessment-pending" })).resolves.toBeDefined();
		await expect(issue(releaseUri(), id, { val: "assessment-error" })).resolves.toBeDefined();
	});

	it("accepts an automated-block label with a critical finding in an allowed category", async () => {
		const uri = releaseUri();
		const id = await assessmentId();
		const issued = await issue(uri, id, {
			val: "malware",
			findingCategory: "malware",
			severity: "critical",
		});
		expect(issued.label.val).toBe("malware");
	});

	it("accepts a warning label with automated mode", async () => {
		const uri = releaseUri();
		const id = await assessmentId();
		const issued = await issue(uri, id, { val: "low-quality" });
		expect(issued.label.val).toBe("low-quality");
	});

	it("accepts a negation of a previously issued automated label without a finding category", async () => {
		const uri = releaseUri();
		const id = await assessmentId();
		await issue(uri, id, { val: "malware", findingCategory: "malware", severity: "critical" });
		const negated = await issue(uri, id, { val: "malware", neg: true });
		expect(negated.label.neg).toBe(true);
	});

	it("rejects release-scoped manual-only values from the automated path", async () => {
		const uri = releaseUri();
		const id = await assessmentId();
		await expect(issue(uri, id, { val: "assessment-overridden" })).rejects.toThrow(
			"cannot be issued through the automated path",
		);
		await expect(issue(uri, id, { val: "security-yanked" })).rejects.toThrow(
			"cannot be issued through the automated path",
		);
	});

	it("still enforces the release-record and CID checks for a negation", async () => {
		const id = await assessmentId();
		// A negation skips only the finding-category/severity checks — the
		// release-record and mandatory-CID requirements apply unconditionally.
		await expect(
			issueAutomatedAssessmentLabel(
				testEnv.DB,
				config,
				await signer(),
				action({ assessmentId: id }),
				{
					uri: PUBLISHER_DID,
					cid: CID,
					val: "malware",
					neg: true,
				},
			),
		).rejects.toThrow("must target a release record");
		await expect(
			issueAutomatedAssessmentLabel(
				testEnv.DB,
				config,
				await signer(),
				action({ assessmentId: id }),
				{
					uri: releaseUri(),
					val: "malware",
					neg: true,
				},
			),
		).rejects.toThrow("must include a release CID");
	});

	it("rejects a publisher-scoped value because automated labels are release-only", async () => {
		const id = await assessmentId();
		await expect(issue(PUBLISHER_DID, id, { val: "publisher-compromised" })).rejects.toThrow(
			"must target a release record",
		);
	});

	it("rejects a subject that is not a release record", async () => {
		const id = await assessmentId();
		await expect(
			issueAutomatedAssessmentLabel(
				testEnv.DB,
				config,
				await signer(),
				action({ assessmentId: id }),
				{
					uri: PUBLISHER_DID,
					cid: CID,
					val: "assessment-passed",
				},
			),
		).rejects.toThrow("must target a release record");
	});

	it("rejects a missing CID on the automated path unconditionally", async () => {
		const uri = releaseUri();
		const id = await assessmentId();
		await expect(
			issueAutomatedAssessmentLabel(
				testEnv.DB,
				config,
				await signer(),
				action({ assessmentId: id }),
				{
					uri,
					val: "assessment-passed",
				},
			),
		).rejects.toThrow("must include a release CID");
	});

	it("refuses to negate a manually-issued label (§10)", async () => {
		const uri = releaseUri();
		const id = await assessmentId();
		// A reviewer-issued assessment-passed (manual action type) — reviewer
		// override flows land in W9, so seed the exact stream state the guard
		// defends against directly.
		await testEnv.DB.prepare(
			`INSERT INTO issuance_actions (actor, type, reason, idempotency_key, created_at)
			 VALUES (?, 'manual-label', 'reviewer override', ?, ?)`,
		)
			.bind(LABELER_DID, `manual-seed-${Math.random()}`, new Date().toISOString())
			.run();
		const actionRow = await testEnv.DB.prepare(
			`SELECT id FROM issuance_actions ORDER BY id DESC LIMIT 1`,
		).first<{ id: number }>();
		await testEnv.DB.prepare(
			`INSERT INTO issued_labels (action_id, ver, src, uri, cid, val, neg, cts, sig, signing_key_id)
			 VALUES (?, 1, ?, ?, ?, 'assessment-passed', 0, ?, X'00', ?)`,
		)
			.bind(
				actionRow!.id,
				LABELER_DID,
				uri,
				CID,
				new Date().toISOString(),
				`${LABELER_DID}#atproto_label`,
			)
			.run();

		await expect(issue(uri, id, { val: "assessment-passed", neg: true })).rejects.toThrow(
			"cannot negate the manually-issued label",
		);
		expect(await countLabels(uri, "assessment-passed")).toBe(1);
	});

	it("closes the negation race in-batch: a manual label committed after the pre-check still blocks", async () => {
		const uri = releaseUri();
		const id = await assessmentId();
		const idempotencyKey = `race-neg-${Math.random()}`;
		// Build the negation statements while the stream is empty, so the
		// pre-check passes — the exact TOCTOU window the in-batch guard closes.
		const built = await buildIssuanceStatements(
			testEnv.DB,
			config,
			await signer(),
			action({ assessmentId: id, idempotencyKey }),
			{ uri, cid: CID, val: "assessment-passed", neg: true },
			new Date(),
			false,
		);
		// The racing manual issuance lands between build and batch execution.
		await testEnv.DB.prepare(
			`INSERT INTO issuance_actions (actor, type, reason, idempotency_key, created_at)
			 VALUES (?, 'manual-label', 'reviewer override', ?, ?)`,
		)
			.bind(LABELER_DID, `manual-seed-${Math.random()}`, new Date().toISOString())
			.run();
		const actionRow = await testEnv.DB.prepare(
			`SELECT id FROM issuance_actions ORDER BY id DESC LIMIT 1`,
		).first<{ id: number }>();
		await testEnv.DB.prepare(
			`INSERT INTO issued_labels (action_id, ver, src, uri, cid, val, neg, cts, sig, signing_key_id)
			 VALUES (?, 1, ?, ?, ?, 'assessment-passed', 0, ?, X'00', ?)`,
		)
			.bind(
				actionRow!.id,
				LABELER_DID,
				uri,
				CID,
				new Date().toISOString(),
				`${LABELER_DID}#atproto_label`,
			)
			.run();

		await testEnv.DB.batch(built.statements);

		// The in-batch guard suppressed the action insert, so nothing negated
		// the manual label and no orphan action was written.
		expect(await countLabels(uri, "assessment-passed")).toBe(1);
		const orphan = await testEnv.DB.prepare(
			`SELECT COUNT(*) AS n FROM issuance_actions WHERE idempotency_key = ?`,
		)
			.bind(idempotencyKey)
			.first<{ n: number }>();
		expect(orphan?.n).toBe(0);

		// postCommit must surface the §10 policy violation, not a misleading
		// signing-state error, when the guard suppressed the insert.
		await expect(built.postCommit()).rejects.toThrow("cannot negate the manually-issued label");
	});

	it("rejects a blocking value from a non-critical severity", async () => {
		const uri = releaseUri();
		const id = await assessmentId();
		await expect(
			issue(uri, id, { val: "malware", findingCategory: "malware", severity: "high" }),
		).rejects.toThrow("requires a critical finding severity");
	});

	it("rejects a blocking value whose finding category is a quality (non-blocking) category", async () => {
		const uri = releaseUri();
		const id = await assessmentId();
		await expect(
			issue(uri, id, { val: "malware", findingCategory: "low-quality", severity: "critical" }),
		).rejects.toThrow("finding category must be an allowed security/impersonation category");
	});

	it("rejects a blocking value with no finding category at all", async () => {
		const uri = releaseUri();
		const id = await assessmentId();
		await expect(issue(uri, id, { val: "malware", severity: "critical" })).rejects.toThrow(
			"requires a finding category",
		);
	});

	it("rejects an unknown label value", async () => {
		const uri = releaseUri();
		const id = await assessmentId();
		await expect(issue(uri, id, { val: "not-a-real-label" })).rejects.toThrow(
			"unknown label value",
		);
	});

	it("rejects an action whose assessmentId is not a valid assessment id", async () => {
		const uri = releaseUri();
		await expect(
			issueAutomatedAssessmentLabel(
				testEnv.DB,
				config,
				await signer(),
				action({ assessmentId: "not-an-assessment-id" }),
				{ uri, cid: CID, val: "assessment-passed" },
			),
		).rejects.toThrow("assessmentId must be a valid assessment id");
	});
});

describe("automated issuance idempotency and batching", () => {
	it("re-issues the same label for a repeated idempotency key", async () => {
		const uri = releaseUri();
		const id = await assessmentId();
		const runKey = await computeRunKey({
			uri,
			cid: CID,
			policyVersion: "v1",
			modelId: "m",
			promptHash: "p",
			scannerSetVersion: "v1",
			triggerId: initialTriggerId(CID),
		});
		const idempotencyKey = automatedIdempotencyKey(runKey, "assessment-passed", false);
		const proposal: AutomatedLabelProposal = { uri, cid: CID, val: "assessment-passed" };
		const first = await issueAutomatedAssessmentLabel(
			testEnv.DB,
			config,
			await signer(),
			action({ assessmentId: id, idempotencyKey }),
			proposal,
		);
		const second = await issueAutomatedAssessmentLabel(
			testEnv.DB,
			config,
			await signer(),
			action({ assessmentId: id, idempotencyKey }),
			proposal,
		);
		expect(second.sequence).toBe(first.sequence);
		expect(second.label).toEqual(first.label);
	});

	it("allocates monotonically increasing sequences for multiple labels issued in one batch", async () => {
		const uri = releaseUri();
		const id = await assessmentId();
		const now = new Date();
		const labelSigner = await signer();
		const first = await buildIssuanceStatements(
			testEnv.DB,
			config,
			labelSigner,
			action({ assessmentId: id, idempotencyKey: `batch-a-${Math.random()}` }),
			{ uri, cid: CID, val: "assessment-passed" },
			now,
			false,
		);
		const second = await buildIssuanceStatements(
			testEnv.DB,
			config,
			labelSigner,
			action({ assessmentId: id, idempotencyKey: `batch-b-${Math.random()}` }),
			{ uri, cid: CID, val: "low-quality" },
			now,
			false,
		);
		await testEnv.DB.batch([...first.statements, ...second.statements]);
		const firstIssued = await first.postCommit();
		const secondIssued = await second.postCommit();
		expect(secondIssued.sequence).toBeGreaterThan(firstIssued.sequence);
	});
});
