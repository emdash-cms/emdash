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

	it("rejects a missing CID for a label that requires one", async () => {
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
		).rejects.toThrow("requires a CID");
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
