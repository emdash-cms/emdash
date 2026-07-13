import { createLabelSigner, type LabelDidDocument } from "@emdash-cms/registry-moderation";
import { applyD1Migrations, env, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import { computeFilterHash } from "../src/assessment-cursor.js";
import { computeRunKey, initialTriggerId, operatorTriggerId } from "../src/assessment-lifecycle.js";
import {
	buildFinalizationStatements,
	createAssessmentRun,
	createSubject,
	transitionAssessmentState,
} from "../src/assessment-store.js";
import { issueAutomatedAssessmentLabel, type AutomatedLabelProposal } from "../src/service.js";
import { initializeSigningState } from "../src/signing-rotation.js";
import { handleAssessmentXrpc } from "../src/xrpc-router.js";

interface TestEnv {
	DB: D1Database;
	TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
}

const testEnv = env as unknown as TestEnv;
const LABELER_DID = "did:web:labels.emdashcms.com";
const PUBLISHER_DID = "did:plc:publisher000000000000000000";
const PRIVATE_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAE";
const MULTIKEY = "zDnaepsL7AXenJkVYdkh5KuKsSU7Ykh7kyXaLLU7auN9FWSiZ";
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

// `cid` params are validated against `^baf[ky]rei[a-z2-7]{52}$` at the
// router (see @atcute/lexicons' DASL_CID_RE) and, for anything actually
// signed, decoded as a real CID by @atcute/cid — an arbitrary string (even
// one that merely "looks like" a CID) fails both, and base32's bit-packing
// means even flipping trailing characters of a known-good CID breaks
// decoding. These are real CIDv1s (`fromDigest(CODEC_RAW, digest)` then
// `toString`, computed offline), distinct only in their digest bytes.
const FAKE_CIDS = [
	"bafkreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa74",
	"bafkreiaba4aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa7y",
	"bafkreiacbyaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa7u",
	"bafkreiadcuaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa7q",
	"bafkreiaedqaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa7m",
	"bafkreiafemaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa7i",
	"bafkreiagfiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa7e",
	"bafkreiahgeaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa7a",
	"bafkreiaihaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa64",
	"bafkreiajh4aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa6y",
	"bafkreiakiyaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa6u",
	"bafkreialjuaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa6q",
	"bafkreiamkqaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa6m",
	"bafkreianlmaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa6i",
	"bafkreiaomiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa6e",
	"bafkreiapneaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa6a",
	"bafkreiaqoaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa54",
	"bafkreiaro4aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa5y",
	"bafkreiaspyaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa5u",
	"bafkreiatquaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa5q",
	"bafkreiaurqaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa5m",
	"bafkreiavsmaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa5i",
	"bafkreiawtiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa5e",
	"bafkreiaxueaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa5a",
	"bafkreiayvaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa44",
	"bafkreiazv4aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa4y",
	"bafkreia2wyaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa4u",
	"bafkreia3xuaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa4q",
	"bafkreia4yqaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa4m",
	"bafkreia5zmaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa4i",
	"bafkreia62iaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa4e",
	"bafkreia73eaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa4a",
	"bafkreiba4aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa34",
	"bafkreibb44aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa3y",
	"bafkreibc5yaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa3u",
	"bafkreibd6uaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa3q",
	"bafkreibe7qaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa3m",
	"bafkreibfamaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa3i",
	"bafkreibgbiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa3e",
	"bafkreibhceaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa3a",
	"bafkreibidaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa24",
	"bafkreibjd4aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa2y",
	"bafkreibkeyaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa2u",
	"bafkreiblfuaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa2q",
	"bafkreibmgqaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa2m",
	"bafkreibnhmaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa2i",
	"bafkreiboiiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa2e",
	"bafkreibpjeaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa2a",
	"bafkreibqkaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaz4",
	"bafkreibrk4aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaazy",
] as const;

function fakeCid(counter: number): string {
	const cid = FAKE_CIDS[counter % FAKE_CIDS.length];
	if (!cid) throw new Error("ran out of fake CIDs");
	return cid;
}

function subject(): { uri: string; cid: string } {
	releaseCounter++;
	return {
		uri: `at://${PUBLISHER_DID}/com.emdashcms.experimental.package.release/router-${releaseCounter}:1.0.0`,
		cid: fakeCid(releaseCounter),
	};
}

async function observedSubject(): Promise<{ uri: string; cid: string }> {
	const target = subject();
	await createSubject(testEnv.DB, {
		uri: target.uri,
		cid: target.cid,
		did: PUBLISHER_DID,
		collection: "com.emdashcms.experimental.package.release",
		rkey: target.uri.split("/").at(-1)!,
	});
	return target;
}

let runCounter = 0;

/** Creates a run in the `running` state for a subject. A distinct trigger
 * per call is required even for the same subject — the default trigger is
 * deterministic per (uri, cid), so reusing it collides with an existing
 * run's idempotent run key instead of starting a second one. */
async function runningRun(
	target: { uri: string; cid: string },
	now?: Date,
): Promise<{ id: string }> {
	const triggerId = operatorTriggerId(`router-run-${runCounter++}`);
	const runKey = await computeRunKey({
		uri: target.uri,
		cid: target.cid,
		policyVersion: "v1",
		modelId: "m",
		promptHash: "p",
		scannerSetVersion: "v1",
		triggerId,
	});
	const { assessment } = await createAssessmentRun(testEnv.DB, {
		runKey,
		uri: target.uri,
		cid: target.cid,
		trigger: "operator",
		triggerId,
		policyVersion: "v1",
		coverageJson: '{"code":"complete","images":"not-present","metadata":"complete"}',
		now,
	});
	for (const [from, to] of [
		["observed", "verifying"],
		["verifying", "pending"],
		["pending", "running"],
	] as const) {
		await transitionAssessmentState(testEnv.DB, { id: assessment.id, from, to });
	}
	return { id: assessment.id };
}

async function finalize(
	assessmentId: string,
	target: { uri: string; cid: string },
	toState: "passed" | "warned" | "blocked" | "error",
	options: { supersedesAssessmentId?: string; publicSummary?: string } = {},
): Promise<void> {
	await testEnv.DB.batch(
		buildFinalizationStatements(testEnv.DB, {
			assessmentId,
			fromState: "running",
			toState,
			src: LABELER_DID,
			uri: target.uri,
			cid: target.cid,
			supersedesAssessmentId: options.supersedesAssessmentId,
			publicSummary: options.publicSummary,
		}).statements,
	);
}

/** A full run + decision outcome in one call — the common case for router
 * tests that just need a public assessment on the books. */
async function decidedRun(
	target: { uri: string; cid: string },
	toState: "passed" | "warned" | "blocked" | "error",
	options: { supersedesAssessmentId?: string; publicSummary?: string } = {},
): Promise<string> {
	const { id } = await runningRun(target);
	await finalize(id, target, toState, options);
	return id;
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

async function issueLabel(
	target: { uri: string; cid: string },
	assessmentId: string,
	proposal: Partial<AutomatedLabelProposal> & { val: string },
	now?: Date,
): ReturnType<typeof issueAutomatedAssessmentLabel> {
	return await issueAutomatedAssessmentLabel(
		testEnv.DB,
		config,
		await signer(),
		{
			actor: LABELER_DID,
			type: "automated-assessment",
			assessmentId,
			reason: "router test issuance",
			idempotencyKey: `router-label-${Math.random()}`,
		},
		{ uri: target.uri, cid: target.cid, ...proposal },
		now,
	);
}

async function xrpc(path: string): Promise<Response> {
	return SELF.fetch(`https://test${path}`);
}

interface PublicAssessmentPayload {
	id: string;
	src: string;
	state: string;
	summary: string;
	labels: Array<{ val: string; active: boolean }>;
	coverage: Record<string, string>;
	artifact?: { id?: string; checksum: string };
	model?: { provider: string; modelId: string; promptVersion: string };
	completedAt?: string;
	supersedesAssessmentId?: string;
}

describe("getAssessment", () => {
	it("returns the full public view for a passed assessment", async () => {
		const target = await observedSubject();
		const id = await decidedRun(target, "passed", { publicSummary: "no blocking condition found" });
		await issueLabel(target, id, { val: "assessment-passed" });

		const response = await xrpc(`/xrpc/com.emdashcms.experimental.labeler.getAssessment?id=${id}`);
		expect(response.status).toBe(200);
		expect(response.headers.get("cache-control")).toBe("public, max-age=60");
		const body = (await response.json()) as PublicAssessmentPayload;
		expect(body).toMatchObject({
			id,
			src: LABELER_DID,
			subject: { uri: target.uri, cid: target.cid },
			state: "passed",
			summary: "no blocking condition found",
			policyVersion: "v1",
			assessmentSchemaVersion: 1,
			coverage: {
				code: "complete",
				images: "not-present",
				metadata: "complete",
			},
		});
		expect(body.labels).toEqual([
			{ val: "assessment-passed", active: true, issuedAt: expect.any(String) },
		]);
		expect(body.artifact).toBeUndefined();
		expect(body.model).toBeUndefined();
		expect(body.completedAt).toEqual(expect.any(String));
	});

	it("returns NotFound for observed, verifying, stale, and cancelled states", async () => {
		const observed = await observedSubject();
		const { id: runningId } = await runningRun(observed);
		await transitionAssessmentState(testEnv.DB, {
			id: runningId,
			from: "running",
			to: "stale",
		});
		const staleResponse = await xrpc(
			`/xrpc/com.emdashcms.experimental.labeler.getAssessment?id=${runningId}`,
		);
		expect(staleResponse.status).toBe(404);
		expect(await staleResponse.json()).toMatchObject({ error: "NotFound" });

		const cancelledSubject = await observedSubject();
		const cancelledRunKey = await computeRunKey({
			uri: cancelledSubject.uri,
			cid: cancelledSubject.cid,
			policyVersion: "v1",
			modelId: "m",
			promptHash: "p",
			scannerSetVersion: "v1",
			triggerId: initialTriggerId(cancelledSubject.cid),
		});
		const { assessment: observedRow } = await createAssessmentRun(testEnv.DB, {
			runKey: cancelledRunKey,
			uri: cancelledSubject.uri,
			cid: cancelledSubject.cid,
			trigger: "initial",
			triggerId: initialTriggerId(cancelledSubject.cid),
			policyVersion: "v1",
			coverageJson: "{}",
		});
		const observedResponse = await xrpc(
			`/xrpc/com.emdashcms.experimental.labeler.getAssessment?id=${observedRow.id}`,
		);
		expect(observedResponse.status).toBe(404);

		const cancelled = await transitionAssessmentState(testEnv.DB, {
			id: observedRow.id,
			from: "observed",
			to: "cancelled",
		});
		const cancelledResponse = await xrpc(
			`/xrpc/com.emdashcms.experimental.labeler.getAssessment?id=${cancelled.id}`,
		);
		expect(cancelledResponse.status).toBe(404);
	});

	it("returns NotFound for an unknown id", async () => {
		const response = await xrpc(
			"/xrpc/com.emdashcms.experimental.labeler.getAssessment?id=asmt_00000000000000000000000000",
		);
		expect(response.status).toBe(404);
	});

	it("presents a superseded row as state: superseded, and a non-superseded non-current row keeps its own state", async () => {
		const target = await observedSubject();
		const first = await decidedRun(target, "passed");
		const second = await decidedRun(target, "blocked", { supersedesAssessmentId: first });

		const firstResponse = await xrpc(
			`/xrpc/com.emdashcms.experimental.labeler.getAssessment?id=${first}`,
		);
		expect(await firstResponse.json()).toMatchObject({ state: "superseded" });

		const secondResponse = await xrpc(
			`/xrpc/com.emdashcms.experimental.labeler.getAssessment?id=${second}`,
		);
		expect(await secondResponse.json()).toMatchObject({ state: "blocked" });

		// A separately-decided run for a different subject is never named by
		// any successor's supersedesAssessmentId — it must keep its own state.
		const other = await observedSubject();
		const unrelated = await decidedRun(other, "passed");
		const unrelatedResponse = await xrpc(
			`/xrpc/com.emdashcms.experimental.labeler.getAssessment?id=${unrelated}`,
		);
		expect(await unrelatedResponse.json()).toMatchObject({ state: "passed" });
	});
});

describe("listAssessments", () => {
	it("orders newest first and pages disjointly, with a cursor only while more rows exist", async () => {
		const target = await observedSubject();
		const ids: string[] = [];
		for (let index = 0; index < 3; index++) ids.push(await decidedRun(target, "passed"));

		const first = await xrpc(
			`/xrpc/com.emdashcms.experimental.labeler.listAssessments?uri=${encodeURIComponent(target.uri)}&cid=${target.cid}&limit=2`,
		);
		const firstBody = (await first.json()) as {
			assessments: PublicAssessmentPayload[];
			cursor?: string;
		};
		expect(firstBody.assessments).toHaveLength(2);
		expect(firstBody.cursor).toBeTruthy();

		const second = await xrpc(
			`/xrpc/com.emdashcms.experimental.labeler.listAssessments?uri=${encodeURIComponent(target.uri)}&cid=${target.cid}&limit=2&cursor=${firstBody.cursor}`,
		);
		const secondBody = (await second.json()) as {
			assessments: PublicAssessmentPayload[];
			cursor?: string;
		};
		expect(secondBody.assessments).toHaveLength(1);
		expect(secondBody.cursor).toBeUndefined();

		const reassembled = [...firstBody.assessments, ...secondBody.assessments].map((row) => row.id);
		expect(reassembled).toEqual(ids.toReversed());
	});

	it("filters by state, excluding superseded rows from a decision state and isolating them under 'superseded'", async () => {
		const target = await observedSubject();
		const first = await decidedRun(target, "passed");
		const second = await decidedRun(target, "blocked", { supersedesAssessmentId: first });
		const baseUrl = `/xrpc/com.emdashcms.experimental.labeler.listAssessments?uri=${encodeURIComponent(target.uri)}&cid=${target.cid}`;

		const passed = await xrpc(`${baseUrl}&state=passed`);
		const passedIds = (
			(await passed.json()) as { assessments: PublicAssessmentPayload[] }
		).assessments.map((row) => row.id);
		expect(passedIds).not.toContain(first);

		const superseded = await xrpc(`${baseUrl}&state=superseded`);
		const supersededIds = (
			(await superseded.json()) as { assessments: PublicAssessmentPayload[] }
		).assessments.map((row) => row.id);
		expect(supersededIds).toEqual([first]);
		expect(supersededIds).not.toContain(second);
	});

	it("rejects an unknown state value", async () => {
		const response = await xrpc(
			"/xrpc/com.emdashcms.experimental.labeler.listAssessments?state=bogus",
		);
		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({ error: "InvalidRequest" });
	});

	it("rejects cid without uri", async () => {
		const response = await xrpc(
			`/xrpc/com.emdashcms.experimental.labeler.listAssessments?cid=${fakeCid(1)}`,
		);
		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({ error: "InvalidRequest" });
	});

	it("rejects a src other than this deployment's own DID", async () => {
		const response = await xrpc(
			"/xrpc/com.emdashcms.experimental.labeler.listAssessments?src=did:web:other.example",
		);
		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({ error: "UnsupportedSource" });
	});

	it("rejects a cursor whose filters changed, rather than silently repaging", async () => {
		const target = await observedSubject();
		await decidedRun(target, "passed");
		await decidedRun(target, "passed");
		const first = await xrpc(
			`/xrpc/com.emdashcms.experimental.labeler.listAssessments?uri=${encodeURIComponent(target.uri)}&cid=${target.cid}&limit=1`,
		);
		const cursor = ((await first.json()) as { cursor: string }).cursor;
		const changedFilters = await xrpc(
			`/xrpc/com.emdashcms.experimental.labeler.listAssessments?uri=${encodeURIComponent(target.uri)}&limit=1&cursor=${cursor}`,
		);
		expect(changedFilters.status).toBe(400);
		expect(await changedFilters.json()).toMatchObject({ error: "InvalidCursor" });
	});

	it("rejects a malformed cursor and an unknown cursor version", async () => {
		const malformed = await xrpc(
			"/xrpc/com.emdashcms.experimental.labeler.listAssessments?cursor=not-base64url-json",
		);
		expect(malformed.status).toBe(400);
		expect(await malformed.json()).toMatchObject({ error: "InvalidCursor" });

		const futureVersion = base64Url(
			JSON.stringify({ v: 99, createdAt: "x", id: "y", filterHash: "z" }),
		);
		const badVersion = await xrpc(
			`/xrpc/com.emdashcms.experimental.labeler.listAssessments?cursor=${futureVersion}`,
		);
		expect(badVersion.status).toBe(400);
		expect(await badVersion.json()).toMatchObject({ error: "InvalidCursor" });
	});

	it("rejects a structurally valid cursor whose createdAt is not a parseable timestamp", async () => {
		const filterHash = await computeFilterHash({});
		const badTimestamp = base64Url(
			JSON.stringify({
				v: 1,
				createdAt: "not-a-date",
				id: "asmt_00000000000000000000000000",
				filterHash,
			}),
		);
		const response = await xrpc(
			`/xrpc/com.emdashcms.experimental.labeler.listAssessments?cursor=${badTimestamp}`,
		);
		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({ error: "InvalidCursor" });
	});

	it("never returns a non-public stored state", async () => {
		const target = await observedSubject();
		const { id } = await runningRun(target);
		await transitionAssessmentState(testEnv.DB, { id, from: "running", to: "stale" });
		const response = await xrpc(
			`/xrpc/com.emdashcms.experimental.labeler.listAssessments?uri=${encodeURIComponent(target.uri)}&cid=${target.cid}`,
		);
		const body = (await response.json()) as { assessments: PublicAssessmentPayload[] };
		expect(body.assessments.map((row) => row.state)).not.toContain("stale");
	});

	it("attributes each row's own labels correctly on a multi-row page (batched lookup, no cross-assessment mixing)", async () => {
		const target = await observedSubject();
		const first = await decidedRun(target, "passed");
		await issueLabel(target, first, { val: "assessment-passed" });
		const second = await decidedRun(target, "blocked", { supersedesAssessmentId: first });
		await issueLabel(target, second, {
			val: "malware",
			findingCategory: "malware",
			severity: "critical",
		});
		const third = await decidedRun(target, "warned", { supersedesAssessmentId: second });
		await issueLabel(target, third, { val: "low-quality" });

		const response = await xrpc(
			`/xrpc/com.emdashcms.experimental.labeler.listAssessments?uri=${encodeURIComponent(target.uri)}&cid=${target.cid}&limit=10`,
		);
		const body = (await response.json()) as { assessments: PublicAssessmentPayload[] };
		const byId = new Map(body.assessments.map((row) => [row.id, row]));
		expect(byId.get(first)?.labels).toEqual([
			{ val: "assessment-passed", active: true, issuedAt: expect.any(String) },
		]);
		expect(byId.get(second)?.labels).toEqual([
			{ val: "malware", active: true, issuedAt: expect.any(String) },
		]);
		expect(byId.get(third)?.labels).toEqual([
			{ val: "low-quality", active: true, issuedAt: expect.any(String) },
		]);
	});
});

describe("getCurrentAssessment", () => {
	it("returns current and a newer pending run as distinct fields, with active labels only", async () => {
		const target = await observedSubject();
		const currentId = await decidedRun(target, "passed");
		await issueLabel(target, currentId, { val: "assessment-passed" });
		// Expired.
		await issueLabel(target, currentId, { val: "low-quality", exp: "2020-01-01T00:00:00.000Z" });
		// Negated.
		await issueLabel(target, currentId, { val: "obfuscated-code" });
		await issueLabel(target, currentId, { val: "obfuscated-code", neg: true });
		// CID-inapplicable: issued against a different CID at the same URI.
		await issueLabel(
			{ uri: target.uri, cid: FAKE_CIDS.find((candidate) => candidate !== target.cid)! },
			currentId,
			{ val: "privacy-risk" },
		);

		const { id: pendingId } = await runningRun(target);

		const response = await xrpc(
			`/xrpc/com.emdashcms.experimental.labeler.getCurrentAssessment?uri=${encodeURIComponent(target.uri)}&cid=${target.cid}`,
		);
		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			current?: PublicAssessmentPayload;
			pending?: PublicAssessmentPayload;
			activeLabels: Array<{ val: string; cid?: string }>;
		};
		expect(body.current?.id).toBe(currentId);
		expect(body.pending?.id).toBe(pendingId);
		expect(body.current?.id).not.toBe(body.pending?.id);
		const activeVals = body.activeLabels.map((label) => label.val).toSorted();
		expect(activeVals).toEqual(["assessment-passed"]);
		expect(activeVals).not.toContain("low-quality");
		expect(activeVals).not.toContain("obfuscated-code");
		expect(activeVals).not.toContain("privacy-risk");
	});

	it("returns NotFound for a subject that was never observed", async () => {
		const uri = `at://${PUBLISHER_DID}/com.emdashcms.experimental.package.release/never-seen:1.0.0`;
		const response = await xrpc(
			`/xrpc/com.emdashcms.experimental.labeler.getCurrentAssessment?uri=${encodeURIComponent(uri)}&cid=${fakeCid(46)}`,
		);
		expect(response.status).toBe(404);
		expect(await response.json()).toMatchObject({ error: "NotFound" });
	});

	it("rejects a src other than this deployment's own DID", async () => {
		const target = await observedSubject();
		const response = await xrpc(
			`/xrpc/com.emdashcms.experimental.labeler.getCurrentAssessment?uri=${encodeURIComponent(target.uri)}&cid=${target.cid}&src=did:web:other.example`,
		);
		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({ error: "UnsupportedSource" });
	});
});

describe("getPolicy", () => {
	it("returns the policy fixture shape with a long cache lifetime", async () => {
		const response = await xrpc("/xrpc/com.emdashcms.experimental.labeler.getPolicy");
		expect(response.status).toBe(200);
		expect(response.headers.get("cache-control")).toBe("public, max-age=300");
		expect(await response.json()).toMatchObject({
			schemaVersion: 1,
			policyVersion: "2026-07-10.experimental.3",
			labelerDid: LABELER_DID,
			assessmentSchemaVersion: 1,
		});
	});

	it("500s when the deployment's labelerDid doesn't match the policy fixture's", async () => {
		// A distinct `env` object (not `testEnv` itself, which is the same
		// binding SELF.fetch requests use) so the per-isolate router cache
		// (keyed on `env` identity) can't serve the router already built for
		// the matching config from the test above.
		const response = await handleAssessmentXrpc(
			{ ...testEnv } as unknown as Env,
			new Request("https://test/xrpc/com.emdashcms.experimental.labeler.getPolicy"),
			{ labelerDid: "did:web:other.example", signingKeyVersion: "v1" },
		);
		expect(response.status).toBe(500);
		expect(await response.json()).toMatchObject({ error: "InternalServerError" });
	});
});

describe("router regressions and CORS", () => {
	it("404s an unknown com.emdashcms NSID", async () => {
		const response = await xrpc("/xrpc/com.emdashcms.experimental.labeler.bogus");
		expect(response.status).toBe(404);
	});

	it("answers an OPTIONS preflight with CORS headers", async () => {
		const response = await SELF.fetch(
			"https://test/xrpc/com.emdashcms.experimental.labeler.getPolicy",
			{ method: "OPTIONS" },
		);
		expect(response.status).toBe(204);
		expect(response.headers.get("access-control-allow-origin")).toBe("*");
		expect(response.headers.get("access-control-allow-methods")).toContain("GET");
	});

	it("still routes the atproto label NSIDs to their existing handlers", async () => {
		const target = await observedSubject();
		const response = await xrpc(
			`/xrpc/com.atproto.label.queryLabels?uriPatterns=${encodeURIComponent(target.uri)}`,
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ labels: [] });

		const subscribeResponse = await SELF.fetch(
			"https://test/xrpc/com.atproto.label.subscribeLabels",
			{ headers: { upgrade: "websocket" } },
		);
		expect(subscribeResponse.status).toBe(101);
		subscribeResponse.webSocket?.accept();
		subscribeResponse.webSocket?.close();
	});
});

function base64Url(value: string): string {
	const bytes = new TextEncoder().encode(value);
	let str = "";
	for (const byte of bytes) str += String.fromCharCode(byte);
	return btoa(str).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
