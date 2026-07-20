import { createLabelSigner, type LabelDidDocument } from "@emdash-cms/registry-moderation";
import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { computeRunKey, initialTriggerId } from "../src/assessment-lifecycle.js";
import {
	createAssessmentRun,
	createSubject,
	getActiveLabelState,
	getLabelsForAssessment,
	getLabelsForAssessments,
} from "../src/assessment-store.js";
import {
	issueAutomatedAssessmentLabel,
	issueManualLabel,
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
const CID_A = "bafkreif4oaymum54i5qefbwoblrt5zasfjhpyhyvacpseqtehi3queew5m";
const CID_B = "bafkreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
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

function releaseUri(): string {
	releaseCounter++;
	return `at://${PUBLISHER_DID}/com.emdashcms.experimental.package.release/label-state-${releaseCounter}:1.0.0`;
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

/** Seeds an `issued_labels` row directly, bypassing `issueManualLabel`'s
 * `ManualLabelValue`/subject-rule restrictions — mirrors the raw-insert
 * pattern in automated-issuance.test.ts for stream states no proposal type
 * can produce (here: an arbitrary `val` at a CID other than none). */
async function insertRawLabel(input: {
	uri: string;
	cid?: string;
	val: string;
	neg?: boolean;
}): Promise<number> {
	await testEnv.DB.prepare(
		`INSERT INTO issuance_actions (actor, type, reason, idempotency_key, created_at)
		 VALUES (?, 'manual-label', 'test seed', ?, ?)`,
	)
		.bind("did:example:moderator", `raw-label-seed-${Math.random()}`, new Date().toISOString())
		.run();
	const action = await testEnv.DB.prepare(
		`SELECT id FROM issuance_actions ORDER BY id DESC LIMIT 1`,
	).first<{ id: number }>();
	await testEnv.DB.prepare(
		`INSERT INTO issued_labels (action_id, ver, src, uri, cid, val, neg, cts, sig, signing_key_id)
		 VALUES (?, 1, ?, ?, ?, ?, ?, ?, X'00', ?)`,
	)
		.bind(
			action!.id,
			LABELER_DID,
			input.uri,
			input.cid ?? null,
			input.val,
			input.neg === true ? 1 : 0,
			new Date().toISOString(),
			`${LABELER_DID}#atproto_label`,
		)
		.run();
	const label = await testEnv.DB.prepare(`SELECT sequence FROM issued_labels WHERE action_id = ?`)
		.bind(action!.id)
		.first<{ sequence: number }>();
	return label!.sequence;
}

/** A fresh assessment tied to (uri, CID_A) — one per call, since the store's
 * (uri, cid) pair is what `getActiveLabelState`/`getLabelsForAssessment` key
 * off of. */
async function assessment(uri: string, cid = CID_A): Promise<string> {
	await createSubject(testEnv.DB, {
		uri,
		cid,
		did: PUBLISHER_DID,
		collection: "com.emdashcms.experimental.package.release",
		rkey: uri.split("/").at(-1)!,
	});
	const runKey = await computeRunKey({
		uri,
		cid,
		policyVersion: "v1",
		modelId: "m",
		promptHash: "p",
		scannerSetVersion: "v1",
		triggerId: initialTriggerId(`${cid}-${Math.random()}`),
	});
	const { assessment: created } = await createAssessmentRun(testEnv.DB, {
		runKey,
		uri,
		cid,
		trigger: "initial",
		triggerId: initialTriggerId(`${cid}-${Math.random()}`),
		policyVersion: "v1",
		coverageJson: "{}",
	});
	return created.id;
}

/** Every call gets a fresh random idempotency key (unlike the deterministic
 * `automatedIdempotencyKey`), so repeated calls for the same assessment
 * build up a multi-event stream instead of colliding as a replay. */
async function issue(
	uri: string,
	assessmentId: string,
	proposal: Partial<AutomatedLabelProposal> & { val: string },
	now = new Date(),
): ReturnType<typeof issueAutomatedAssessmentLabel> {
	return await issueAutomatedAssessmentLabel(
		testEnv.DB,
		config,
		await signer(),
		{
			actor: LABELER_DID,
			type: "automated-assessment",
			assessmentId,
			reason: "test issuance",
			idempotencyKey: `label-state-${Math.random()}`,
		},
		{ uri, cid: CID_A, ...proposal },
		now,
	);
}

describe("getActiveLabelState", () => {
	it("flips active false on a same-val negation and back true on a later positive re-issue", async () => {
		const uri = releaseUri();
		const id = await assessment(uri);
		const positive = await issue(uri, id, {
			val: "malware",
			findingCategory: "malware",
			severity: "critical",
		});
		let winners = await getActiveLabelState(testEnv.DB, { src: LABELER_DID, uri, cid: CID_A });
		expect(winners.get("malware")).toMatchObject({ sequence: positive.sequence, active: true });

		const negation = await issue(uri, id, { val: "malware", neg: true });
		winners = await getActiveLabelState(testEnv.DB, { src: LABELER_DID, uri, cid: CID_A });
		expect(winners.get("malware")).toMatchObject({ sequence: negation.sequence, active: false });

		const reissued = await issue(uri, id, {
			val: "malware",
			findingCategory: "malware",
			severity: "critical",
		});
		winners = await getActiveLabelState(testEnv.DB, { src: LABELER_DID, uri, cid: CID_A });
		expect(winners.get("malware")).toMatchObject({ sequence: reissued.sequence, active: true });
	});

	it("treats an expired label as inactive", async () => {
		const uri = releaseUri();
		const id = await assessment(uri);
		await issue(uri, id, {
			val: "low-quality",
			exp: "2020-01-01T00:00:00.000Z",
		});
		const winners = await getActiveLabelState(testEnv.DB, { src: LABELER_DID, uri, cid: CID_A });
		expect(winners.get("low-quality")?.active).toBe(false);
	});

	it("never active-treats a label without an expiry as expired", async () => {
		const uri = releaseUri();
		const id = await assessment(uri);
		await issue(uri, id, { val: "low-quality" });
		const winners = await getActiveLabelState(testEnv.DB, { src: LABELER_DID, uri, cid: CID_A });
		expect(winners.get("low-quality")?.active).toBe(true);
	});

	it("a higher-sequence CID-mismatched event still wins the reduction, but reports inactive for a different queried cid", async () => {
		const uri = releaseUri();
		const idA = await assessment(uri, CID_A);
		const idB = await assessment(uri, CID_B);
		const winnerA = await issue(uri, idA, { val: "assessment-passed", cid: CID_A });
		const laterB = await issue(uri, idB, { val: "assessment-passed", cid: CID_B });
		expect(laterB.sequence).toBeGreaterThan(winnerA.sequence);

		const winners = await getActiveLabelState(testEnv.DB, { src: LABELER_DID, uri, cid: CID_A });
		expect(winners.get("assessment-passed")).toMatchObject({
			sequence: laterB.sequence,
			cid: CID_B,
			active: false,
		});
	});

	it("a newer CID-bound negation retracts an older URI-wide positive for the same val, inactive for any queried cid", async () => {
		const uri = releaseUri();
		const positiveSeq = await insertRawLabel({ uri, val: "low-quality" });
		const negationSeq = await insertRawLabel({ uri, cid: CID_A, val: "low-quality", neg: true });
		expect(negationSeq).toBeGreaterThan(positiveSeq);

		// Querying the negation's own cid: inactive because the winner is a negation.
		const forA = await getActiveLabelState(testEnv.DB, { src: LABELER_DID, uri, cid: CID_A });
		expect(forA.get("low-quality")).toMatchObject({
			sequence: negationSeq,
			cid: CID_A,
			active: false,
		});

		// Querying a different cid: still the same winner (reduction is per val,
		// not per cid), inactive because it isn't applicable to CID_B either.
		const forB = await getActiveLabelState(testEnv.DB, { src: LABELER_DID, uri, cid: CID_B });
		expect(forB.get("low-quality")).toMatchObject({
			sequence: negationSeq,
			cid: CID_A,
			active: false,
		});
	});

	it("a URI-wide (null-cid) event applies regardless of the queried cid", async () => {
		// The automated path always requires a CID (contracts §20.2); a
		// URI-wide event is a manual issuance (e.g. a reviewer's security
		// yank), independent of any assessment.
		const uri = releaseUri();
		const issued = await issueManualLabel(
			testEnv.DB,
			config,
			await signer(),
			{
				actor: "did:example:moderator",
				type: "manual-label",
				reason: "uri-wide test",
				idempotencyKey: `label-state-manual-${Math.random()}`,
			},
			{ uri, val: "security-yanked" },
		);
		expect(issued.label.cid).toBeUndefined();
		const winners = await getActiveLabelState(testEnv.DB, { src: LABELER_DID, uri, cid: CID_A });
		expect(winners.get("security-yanked")).toMatchObject({ cid: null, active: true });
	});

	it("breaks a cts collision by sequence, not insertion-independent ordering", async () => {
		const uri = releaseUri();
		const id = await assessment(uri);
		const now = new Date("2026-07-11T00:00:00.000Z");
		const positive = await issue(uri, id, { val: "low-quality" }, now);
		const negation = await issue(uri, id, { val: "low-quality", neg: true }, now);
		expect(negation.sequence).toBeGreaterThan(positive.sequence);
		expect(negation.label.cts).toBe(positive.label.cts);

		const winners = await getActiveLabelState(testEnv.DB, { src: LABELER_DID, uri, cid: CID_A });
		expect(winners.get("low-quality")).toMatchObject({
			sequence: negation.sequence,
			active: false,
		});
	});
});

describe("getLabelsForAssessment", () => {
	it("returns only this assessment's positive ops, ordered by sequence, excluding its own negations and other assessments' labels", async () => {
		const uri = releaseUri();
		const id = await assessment(uri);
		const other = await assessment(releaseUri());

		const first = await issue(uri, id, { val: "assessment-passed" });
		const second = await issue(uri, id, {
			val: "malware",
			findingCategory: "malware",
			severity: "critical",
		});
		await issue(uri, id, { val: "malware", neg: true });
		await issue(releaseUri(), other, { val: "assessment-passed" });

		const ops = await getLabelsForAssessment(testEnv.DB, id);
		expect(ops.map((op) => op.val)).toEqual(["assessment-passed", "malware"]);
		expect(ops.map((op) => op.sequence)).toEqual([first.sequence, second.sequence]);
	});

	it("returns an empty list for an assessment that issued nothing", async () => {
		const uri = releaseUri();
		const id = await assessment(uri);
		expect(await getLabelsForAssessment(testEnv.DB, id)).toEqual([]);
	});
});

describe("getLabelsForAssessments", () => {
	it("groups each assessment's own positive ops by id in one batched call, without mixing between assessments", async () => {
		const uriA = releaseUri();
		const idA = await assessment(uriA);
		const uriB = releaseUri();
		const idB = await assessment(uriB);
		const idC = await assessment(releaseUri());

		const firstA = await issue(uriA, idA, { val: "assessment-passed" });
		const secondA = await issue(uriA, idA, {
			val: "malware",
			findingCategory: "malware",
			severity: "critical",
		});
		await issue(uriA, idA, { val: "malware", neg: true });
		const onlyB = await issue(uriB, idB, { val: "low-quality" });

		const byAssessment = await getLabelsForAssessments(testEnv.DB, [idA, idB, idC]);
		expect(byAssessment.get(idA)?.map((op) => op.val)).toEqual(["assessment-passed", "malware"]);
		expect(byAssessment.get(idA)?.map((op) => op.sequence)).toEqual([
			firstA.sequence,
			secondA.sequence,
		]);
		expect(byAssessment.get(idB)?.map((op) => op.val)).toEqual(["low-quality"]);
		expect(byAssessment.get(idB)?.map((op) => op.sequence)).toEqual([onlyB.sequence]);
		expect(byAssessment.has(idC)).toBe(false);
	});

	it("issues exactly one query for a page of assessments within a single batch, independent of page size", async () => {
		const vals = [
			"malware",
			"data-exfiltration",
			"credential-harvesting",
			"supply-chain-compromise",
			"critical-vulnerability",
		];
		const ids: string[] = [];
		for (const val of vals) {
			const uri = releaseUri();
			const id = await assessment(uri);
			await issue(uri, id, { val, findingCategory: val, severity: "critical" });
			ids.push(id);
		}
		const prepareSpy = vi.spyOn(testEnv.DB, "prepare");
		await getLabelsForAssessments(testEnv.DB, ids);
		expect(prepareSpy).toHaveBeenCalledTimes(1);
		prepareSpy.mockRestore();
	});

	it("returns an empty map for an empty id list", async () => {
		expect(await getLabelsForAssessments(testEnv.DB, [])).toEqual(new Map());
	});
});
