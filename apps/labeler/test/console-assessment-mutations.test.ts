import {
	createLabelSigner,
	evaluateHydratedReleaseModeration,
	type LabelDidDocument,
	type ModerationLabel,
} from "@emdash-cms/registry-moderation";
import { applyD1Migrations, env } from "cloudflare:test";
import { generateKeyPair, SignJWT } from "jose";
import { beforeAll, describe, expect, it } from "vitest";

import type { AccessKeyResolver } from "../src/access-auth.js";
import { computeRunKey, initialTriggerId } from "../src/assessment-lifecycle.js";
import {
	createAssessmentRun,
	createSubject,
	getActiveLabelState,
	getAssessment,
	getCurrentAssessment,
} from "../src/assessment-store.js";
import { handleConsoleApi, type ConsoleApiDeps } from "../src/console-api.js";
import { handleConsoleMutation, type ConsoleMutationDeps } from "../src/console-mutation-api.js";
import { OPERATOR_REQUEST_HEADER } from "../src/mutation-guard.js";
import { issueAutomatedAssessmentLabel, issueManualLabel } from "../src/service.js";

const TEAM_DOMAIN = "https://example-team.cloudflareaccess.com";
const AUDIENCE = "test-audience";
const ORIGIN = "https://labeler.example.com";
const LABELER_DID = "did:web:labels.emdashcms.com";
const LABELER_SERVICE_URL = "https://labels.emdashcms.com";
const PUBLISHER_DID = "did:plc:publisher000000000000000000";
const PRIVATE_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAE";
const MULTIKEY = "zDnaepsL7AXenJkVYdkh5KuKsSU7Ykh7kyXaLLU7auN9FWSiZ";
const CID = "bafkreif4oaymum54i5qefbwoblrt5zasfjhpyhyvacpseqtehi3queew5m";

const CONFIG = {
	labelerDid: LABELER_DID,
	signingKeyVersion: "v1",
	serviceUrl: LABELER_SERVICE_URL,
	signingPublicKeyMultibase: MULTIKEY,
};

interface TestEnv {
	DB: D1Database;
	TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
}
const testEnv = env as unknown as TestEnv;

let resolver: AccessKeyResolver;
let signKey: CryptoKey;
let reviewerToken: string;
let keySeq = 0;

beforeAll(async () => {
	await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
	const pair = await generateKeyPair("RS256");
	signKey = pair.privateKey;
	resolver = (async () => pair.publicKey) as AccessKeyResolver;
	reviewerToken = await mintToken({ email: "reviewer@example.com" });
});

async function mintToken(claims: Record<string, unknown>): Promise<string> {
	const now = Math.floor(Date.now() / 1000);
	return new SignJWT({ sub: "user-sub-1", ...claims })
		.setProtectedHeader({ alg: "RS256" })
		.setIssuer(TEAM_DOMAIN)
		.setAudience(AUDIENCE)
		.setIssuedAt(now)
		.setExpirationTime(now + 3600)
		.sign(signKey);
}

function labelerDidDocument(): LabelDidDocument {
	return {
		id: LABELER_DID,
		verificationMethod: [
			{
				id: `${LABELER_DID}#atproto_label`,
				type: "Multikey",
				controller: LABELER_DID,
				publicKeyMultibase: MULTIKEY,
			},
		],
	};
}

function testSigner() {
	return createLabelSigner({
		issuerDid: LABELER_DID,
		privateKey: PRIVATE_KEY,
		resolveDid: async () => labelerDidDocument(),
	});
}

function mutationDeps(overrides: Partial<ConsoleMutationDeps> = {}): ConsoleMutationDeps {
	return {
		db: testEnv.DB,
		accessConfig: {
			teamDomain: TEAM_DOMAIN,
			audience: AUDIENCE,
			admins: ["admin@example.com"],
			reviewers: ["reviewer@example.com"],
		},
		keys: resolver,
		config: CONFIG,
		createSigner: () => testSigner(),
		now: () => new Date(),
		afterCommit: async () => {},
		defer: (work) => {
			void work;
		},
		sendDiscoveryJob: async () => {},
		...overrides,
	};
}

function readDeps(overrides: Partial<ConsoleApiDeps> = {}): ConsoleApiDeps {
	return {
		db: testEnv.DB,
		config: {
			teamDomain: TEAM_DOMAIN,
			audience: AUDIENCE,
			admins: ["admin@example.com"],
			reviewers: ["reviewer@example.com"],
		},
		keys: resolver,
		expectedOrigin: ORIGIN,
		labelerDid: LABELER_DID,
		jetstreamConnected: async () => true,
		...overrides,
	};
}

function post(path: string, body: unknown): Request {
	const headers = new Headers();
	headers.set(OPERATOR_REQUEST_HEADER, "1");
	headers.set("Content-Type", "application/json");
	headers.set("Cf-Access-Jwt-Assertion", reviewerToken);
	return new Request(`${ORIGIN}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
}

function getReq(path: string): Request {
	const headers = new Headers();
	headers.set(OPERATOR_REQUEST_HEADER, "1");
	headers.set("Cf-Access-Jwt-Assertion", reviewerToken);
	return new Request(`${ORIGIN}${path}`, { method: "GET", headers });
}

/** A POST carrying an optional operator token — omit it for an unauthenticated
 * request, or pass a non-reviewer token for an under-privileged one. */
function postWithToken(path: string, body: unknown, token: string | null): Request {
	const headers = new Headers();
	headers.set(OPERATOR_REQUEST_HEADER, "1");
	headers.set("Content-Type", "application/json");
	if (token !== null) headers.set("Cf-Access-Jwt-Assertion", token);
	return new Request(`${ORIGIN}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
}

function releaseUri(rkey: string): string {
	return `at://${PUBLISHER_DID}/com.emdashcms.experimental.package.release/${rkey}`;
}

function nextKey(): string {
	keySeq += 1;
	return `idem-key-${keySeq.toString().padStart(6, "0")}`;
}

/** Seeds a verified release subject and an initial assessment run for it,
 * returning the run id + subject URI. */
async function seedRun(rkey: string, cid = CID): Promise<{ id: string; uri: string }> {
	const uri = releaseUri(rkey);
	await createSubject(testEnv.DB, {
		uri,
		cid,
		did: PUBLISHER_DID,
		collection: "com.emdashcms.experimental.package.release",
		rkey,
		now: new Date("2026-07-08T08:00:00.000Z"),
	});
	const triggerId = initialTriggerId(cid);
	const runKey = await computeRunKey({
		uri,
		cid,
		policyVersion: "v1",
		modelId: "m",
		promptHash: "p",
		scannerSetVersion: "v1",
		triggerId,
	});
	const { assessment } = await createAssessmentRun(testEnv.DB, {
		runKey,
		uri,
		cid,
		trigger: "initial",
		triggerId,
		policyVersion: "v1",
		coverageJson: "{}",
		now: new Date("2026-07-08T08:05:00.000Z"),
	});
	return { id: assessment.id, uri };
}

/** Issues a positive automated blocking label from a run, so the release is
 * blocked and the val becomes a negatable automated block. */
async function seedAutomatedBlock(uri: string, assessmentId: string, val: string): Promise<void> {
	await issueAutomatedAssessmentLabel(
		testEnv.DB,
		CONFIG,
		await testSigner(),
		{
			actor: LABELER_DID,
			type: "automated-assessment",
			assessmentId,
			reason: `seed ${val}`,
			idempotencyKey: `auto-${val}-${Math.random()}`,
		},
		{ uri, cid: CID, val, findingCategory: val, severity: "critical" },
	);
}

async function countRows(sql: string, ...binds: unknown[]): Promise<number> {
	const row = await testEnv.DB.prepare(sql)
		.bind(...binds)
		.first<{ n: number }>();
	return row?.n ?? 0;
}

async function bodyData<T>(response: Response): Promise<T> {
	const parsed = (await response.json()) as { data: T };
	return parsed.data;
}

async function bodyError(response: Response): Promise<{ code: string; message: string }> {
	const parsed = (await response.json()) as { error: { code: string; message: string } };
	return parsed.error;
}

/** Reduces the subject's active label state through the release evaluator, the
 * same grounding the effect preview uses. */
async function evaluateSubject(uri: string, cid = CID) {
	const winners = await getActiveLabelState(testEnv.DB, { src: LABELER_DID, uri, cid });
	const labels: ModerationLabel[] = [];
	for (const winner of winners.values()) {
		if (!winner.active) continue;
		labels.push({
			ver: 1,
			src: LABELER_DID,
			uri,
			...(winner.cid === null ? {} : { cid: winner.cid }),
			val: winner.val,
			cts: winner.cts,
			...(winner.exp === null ? {} : { exp: winner.exp }),
		});
	}
	return evaluateHydratedReleaseModeration({
		acceptedLabelers: [{ did: LABELER_DID, redact: false }],
		context: { publisherDid: PUBLISHER_DID, package: { uri, cid }, release: { uri, cid } },
		evaluatedAt: new Date(),
		labels,
	});
}

async function override(
	id: string,
	uri: string,
	negate: string[],
	deps = mutationDeps(),
): Promise<Response> {
	return handleConsoleMutation(
		post(`/admin/api/assessments/${id}/override`, {
			confirmation: CID,
			reason: "false positives, unblocking",
			idempotencyKey: nextKey(),
			negate,
		}),
		deps,
	);
}

describe("rerun", () => {
	it("mints the operator trigger, a fresh run, and re-pends without moving the current pointer", async () => {
		const { id, uri } = await seedRun("rerun-basic");
		const response = await handleConsoleMutation(
			post(`/admin/api/assessments/${id}/rerun`, {
				confirmation: CID,
				reason: "re-assess this release",
				idempotencyKey: nextKey(),
			}),
			mutationDeps(),
		);
		expect(response.status).toBe(200);
		const descriptor = await bodyData<{ runId: string; triggerId: string; uri: string }>(response);
		expect(descriptor.runId).toMatch(/^asmt_/);
		expect(descriptor.runId).not.toBe(id);

		const run = await getAssessment(testEnv.DB, descriptor.runId);
		expect(run?.trigger).toBe("operator");
		expect(run?.triggerId).toBe(descriptor.triggerId);
		expect(descriptor.triggerId.startsWith("operator:")).toBe(true);
		// run_key deterministically binds to the operator trigger.
		expect(run?.runKey).toBe(
			await computeRunKey({
				uri,
				cid: CID,
				policyVersion: run!.policyVersion,
				modelId: "unassigned",
				promptHash: "unassigned",
				scannerSetVersion: "unassigned",
				triggerId: descriptor.triggerId,
			}),
		);

		// An active assessment-pending re-gates the release.
		const winners = await getActiveLabelState(testEnv.DB, { src: LABELER_DID, uri, cid: CID });
		expect(winners.get("assessment-pending")?.active).toBe(true);

		// One audit row, one distinct run, current pointer never moved (none set).
		expect(
			await countRows(`SELECT COUNT(*) n FROM operator_actions WHERE action = 'assessment-rerun'`),
		).toBe(1);
		expect(await getCurrentAssessment(testEnv.DB, { src: LABELER_DID, uri, cid: CID })).toBeNull();
	});

	it("a second rerun creates another distinct run", async () => {
		const { id } = await seedRun("rerun-twice");
		const first = await bodyData<{ runId: string }>(
			await handleConsoleMutation(
				post(`/admin/api/assessments/${id}/rerun`, {
					confirmation: CID,
					reason: "first",
					idempotencyKey: nextKey(),
				}),
				mutationDeps(),
			),
		);
		const second = await bodyData<{ runId: string }>(
			await handleConsoleMutation(
				post(`/admin/api/assessments/${id}/rerun`, {
					confirmation: CID,
					reason: "second",
					idempotencyKey: nextKey(),
				}),
				mutationDeps(),
			),
		);
		expect(second.runId).not.toBe(first.runId);
	});

	it("re-drives the idempotent tail on replay and returns the stored descriptor", async () => {
		const { id } = await seedRun("rerun-replay");
		const key = nextKey();
		const body = { confirmation: CID, reason: "replay me", idempotencyKey: key };
		const first = await handleConsoleMutation(
			post(`/admin/api/assessments/${id}/rerun`, body),
			mutationDeps(),
		);
		const firstText = await first.text();
		const second = await handleConsoleMutation(
			post(`/admin/api/assessments/${id}/rerun`, body),
			mutationDeps(),
		);
		expect(second.status).toBe(200);
		expect(await second.text()).toBe(firstText);
		// No second run created.
		expect(
			await countRows(`SELECT COUNT(*) n FROM operator_actions WHERE idempotency_key = ?`, key),
		).toBe(1);
	});

	it("503s and creates no run when the batch is suppressed mid-commit", async () => {
		const { id, uri } = await seedRun("rerun-phantom");
		const key = nextKey();
		const body = { confirmation: CID, reason: "rotation lands mid-rerun", idempotencyKey: key };
		const suppressed = new Proxy(testEnv.DB, {
			get(target, prop, receiver) {
				if (prop === "batch")
					return (statements: D1PreparedStatement[]) => target.batch([statements[0]!]);
				const value: unknown = Reflect.get(target, prop, receiver);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		const response = await handleConsoleMutation(
			post(`/admin/api/assessments/${id}/rerun`, body),
			mutationDeps({ db: suppressed }),
		);
		expect(response.status).toBe(503);
		expect((await bodyError(response)).code).toBe("LABEL_ISSUANCE_UNAVAILABLE");
		// Audit row committed (unguarded), but no fresh run and no re-pend.
		expect(
			await countRows(`SELECT COUNT(*) n FROM operator_actions WHERE idempotency_key = ?`, key),
		).toBe(1);
		expect(await countRows(`SELECT COUNT(*) n FROM assessments WHERE uri = ?`, uri)).toBe(1);
		const winners = await getActiveLabelState(testEnv.DB, { src: LABELER_DID, uri, cid: CID });
		expect(winners.get("assessment-pending")?.active ?? false).toBe(false);

		// Replay reconstructs the pending key and re-runs the persistence check.
		const retry = await handleConsoleMutation(
			post(`/admin/api/assessments/${id}/rerun`, body),
			mutationDeps(),
		);
		expect(retry.status).toBe(503);
	});

	it("rejects a confirmation that is not the release CID", async () => {
		const { id } = await seedRun("rerun-conf");
		const response = await handleConsoleMutation(
			post(`/admin/api/assessments/${id}/rerun`, {
				confirmation: "not-the-cid",
				reason: "bad confirm",
				idempotencyKey: nextKey(),
			}),
			mutationDeps(),
		);
		expect(response.status).toBe(400);
		expect((await bodyError(response)).code).toBe("CONFIRMATION_MISMATCH");
	});

	it("404s an unknown assessment id", async () => {
		const response = await handleConsoleMutation(
			post(`/admin/api/assessments/asmt_00000000000000000000000000/rerun`, {
				confirmation: CID,
				reason: "no such run",
				idempotencyKey: nextKey(),
			}),
			mutationDeps(),
		);
		expect(response.status).toBe(404);
	});
});

describe("override", () => {
	it("commits N negations + the eligibility pair + one audit row atomically", async () => {
		const { id, uri } = await seedRun("override-atomic");
		await seedAutomatedBlock(uri, id, "malware");
		await seedAutomatedBlock(uri, id, "data-exfiltration");
		expect((await evaluateSubject(uri)).eligibility).toBe("blocked");

		const response = await override(id, uri, ["malware", "data-exfiltration"]);
		expect(response.status).toBe(200);
		const descriptor = await bodyData<{ negated: string[]; issued: string[] }>(response);
		expect(descriptor.negated.toSorted()).toEqual(["data-exfiltration", "malware"]);
		expect(descriptor.issued).toEqual(["assessment-passed", "assessment-overridden"]);

		expect(
			await countRows(`SELECT COUNT(*) n FROM operator_actions WHERE action = 'unblock-override'`),
		).toBe(1);
		expect(
			await countRows(
				`SELECT COUNT(*) n FROM issued_labels WHERE uri = ? AND neg = 1 AND val IN ('malware','data-exfiltration')`,
				uri,
			),
		).toBe(2);

		const winners = await getActiveLabelState(testEnv.DB, { src: LABELER_DID, uri, cid: CID });
		expect(winners.get("malware")?.active).toBe(false);
		expect(winners.get("data-exfiltration")?.active).toBe(false);
		expect(winners.get("assessment-passed")?.active).toBe(true);
		expect(winners.get("assessment-overridden")?.active).toBe(true);

		const evaluated = await evaluateSubject(uri);
		expect(evaluated.eligibility).toBe("eligible");
		expect(evaluated.reasonCodes).toContain("eligible-manual-override");
	});

	it("503s and commits no eligibility labels when the batch is suppressed mid-commit", async () => {
		const { id, uri } = await seedRun("override-phantom");
		await seedAutomatedBlock(uri, id, "malware");
		const key = nextKey();
		const body = {
			confirmation: CID,
			reason: "rotation lands mid-override",
			idempotencyKey: key,
			negate: ["malware"],
		};
		const suppressed = new Proxy(testEnv.DB, {
			get(target, prop, receiver) {
				if (prop === "batch")
					return (statements: D1PreparedStatement[]) => target.batch([statements[0]!]);
				const value: unknown = Reflect.get(target, prop, receiver);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		const response = await handleConsoleMutation(
			post(`/admin/api/assessments/${id}/override`, body),
			mutationDeps({ db: suppressed }),
		);
		expect(response.status).toBe(503);
		expect((await bodyError(response)).code).toBe("LABEL_ISSUANCE_UNAVAILABLE");
		// Audit row committed (unguarded), but no eligibility labels persisted.
		expect(
			await countRows(`SELECT COUNT(*) n FROM operator_actions WHERE idempotency_key = ?`, key),
		).toBe(1);
		expect(
			await countRows(
				`SELECT COUNT(*) n FROM issued_labels WHERE uri = ? AND val = 'assessment-overridden'`,
				uri,
			),
		).toBe(0);

		// Replay re-runs the multi-label persistence check and also 503s.
		const retry = await handleConsoleMutation(
			post(`/admin/api/assessments/${id}/override`, body),
			mutationDeps(),
		);
		expect(retry.status).toBe(503);
	});

	it("rejects a negate set that is not exactly the live automated-block set", async () => {
		const { id, uri } = await seedRun("override-staleset");
		await seedAutomatedBlock(uri, id, "malware");
		await seedAutomatedBlock(uri, id, "data-exfiltration");

		// Omits an active block.
		expect((await override(id, uri, ["malware"])).status).toBe(400);
		// Includes a warning.
		expect((await override(id, uri, ["malware", "data-exfiltration", "low-quality"])).status).toBe(
			400,
		);
		// Includes a non-active val.
		expect(
			(await override(id, uri, ["malware", "data-exfiltration", "impersonation"])).status,
		).toBe(400);
		// The exact live set proceeds.
		expect((await override(id, uri, ["data-exfiltration", "malware"])).status).toBe(200);
	});

	it("returns the byte-identical descriptor on replay without a second effect", async () => {
		const { id, uri } = await seedRun("override-replay");
		await seedAutomatedBlock(uri, id, "malware");
		const key = nextKey();
		const body = {
			confirmation: CID,
			reason: "once",
			idempotencyKey: key,
			negate: ["malware"],
		};
		const first = await handleConsoleMutation(
			post(`/admin/api/assessments/${id}/override`, body),
			mutationDeps(),
		);
		const firstText = await first.text();
		const second = await handleConsoleMutation(
			post(`/admin/api/assessments/${id}/override`, body),
			mutationDeps(),
		);
		expect(await second.text()).toBe(firstText);
		expect(
			await countRows(
				`SELECT COUNT(*) n FROM issued_labels WHERE uri = ? AND val = 'assessment-overridden'`,
				uri,
			),
		).toBe(1);
	});

	it("409s the same key with a different negate set", async () => {
		const { id, uri } = await seedRun("override-conflict");
		await seedAutomatedBlock(uri, id, "malware");
		await seedAutomatedBlock(uri, id, "data-exfiltration");
		const key = nextKey();
		const first = await handleConsoleMutation(
			post(`/admin/api/assessments/${id}/override`, {
				confirmation: CID,
				reason: "first",
				idempotencyKey: key,
				negate: ["malware", "data-exfiltration"],
			}),
			mutationDeps(),
		);
		expect(first.status).toBe(200);
		const second = await handleConsoleMutation(
			post(`/admin/api/assessments/${id}/override`, {
				confirmation: CID,
				reason: "first",
				idempotencyKey: key,
				negate: ["malware"],
			}),
			mutationDeps(),
		);
		expect(second.status).toBe(409);
		expect((await bodyError(second)).code).toBe("IDEMPOTENCY_KEY_CONFLICT");
	});
});

describe("override authorization", () => {
	it("rejects an unauthenticated or under-privileged override before any signing", async () => {
		const { id, uri } = await seedRun("override-authz");
		await seedAutomatedBlock(uri, id, "malware");
		const outsiderToken = await mintToken({ email: "outsider@example.com" });

		const unauth = await handleConsoleMutation(
			postWithToken(
				`/admin/api/assessments/${id}/override`,
				{ confirmation: CID, reason: "no creds", idempotencyKey: nextKey(), negate: ["malware"] },
				null,
			),
			mutationDeps(),
		);
		expect(unauth.status).toBe(401);

		const forbidden = await handleConsoleMutation(
			postWithToken(
				`/admin/api/assessments/${id}/override`,
				{ confirmation: CID, reason: "wrong role", idempotencyKey: nextKey(), negate: ["malware"] },
				outsiderToken,
			),
			mutationDeps(),
		);
		expect(forbidden.status).toBe(403);

		// Neither attempt reached the signer: no audit row, no eligibility pair, and
		// the block is untouched.
		expect(
			await countRows(
				`SELECT COUNT(*) n FROM operator_actions WHERE action = 'unblock-override' AND subject_uri = ?`,
				uri,
			),
		).toBe(0);
		expect(
			await countRows(
				`SELECT COUNT(*) n FROM issued_labels WHERE uri = ? AND val = 'assessment-overridden'`,
				uri,
			),
		).toBe(0);
		const winners = await getActiveLabelState(testEnv.DB, { src: LABELER_DID, uri, cid: CID });
		expect(winners.get("malware")?.active).toBe(true);
	});
});

describe("override permanence (§10)", () => {
	it("keeps a later automated block visible but inert, and refuses automation negating the pass", async () => {
		const { id, uri } = await seedRun("override-permanence");
		await seedAutomatedBlock(uri, id, "malware");
		expect((await override(id, uri, ["malware"])).status).toBe(200);

		// A fresh automated malware positive (a rerun re-detect) after the override.
		await issueAutomatedAssessmentLabel(
			testEnv.DB,
			CONFIG,
			await testSigner(),
			{
				actor: LABELER_DID,
				type: "automated-assessment",
				assessmentId: id,
				reason: "re-detected",
				idempotencyKey: `redetect-${Math.random()}`,
			},
			{ uri, cid: CID, val: "malware", findingCategory: "malware", severity: "critical" },
		);
		const winners = await getActiveLabelState(testEnv.DB, { src: LABELER_DID, uri, cid: CID });
		expect(winners.get("malware")?.active).toBe(true);

		const evaluated = await evaluateSubject(uri);
		expect(evaluated.eligibility).toBe("eligible");
		expect(evaluated.suppressedLabels).toContain("malware");

		// Automation cannot negate the manual override pair.
		await expect(
			issueAutomatedAssessmentLabel(
				testEnv.DB,
				CONFIG,
				await testSigner(),
				{
					actor: LABELER_DID,
					type: "automated-assessment",
					assessmentId: id,
					reason: "try to undo",
					idempotencyKey: `undo-${Math.random()}`,
				},
				{ uri, cid: CID, val: "assessment-passed", neg: true },
			),
		).rejects.toThrow("cannot negate the manually-issued label");
	});

	it("lets a manual security-yanked block despite the override", async () => {
		const { id, uri } = await seedRun("override-manualblock");
		await seedAutomatedBlock(uri, id, "malware");
		expect((await override(id, uri, ["malware"])).status).toBe(200);

		await issueManualLabel(
			testEnv.DB,
			CONFIG,
			await testSigner(),
			{ actor: LABELER_DID, type: "manual-label", reason: "yank", idempotencyKey: nextKey() },
			{ uri, val: "security-yanked" },
		);
		const evaluated = await evaluateSubject(uri);
		expect(evaluated.eligibility).toBe("blocked");
		expect(evaluated.blockingLabels).toContain("security-yanked");
	});
});

describe("override-retract", () => {
	it("negates only the pair, leaves the blocks negated, and returns blocked/missing-pass", async () => {
		const { id, uri } = await seedRun("retract-flow");
		await seedAutomatedBlock(uri, id, "malware");
		expect((await override(id, uri, ["malware"])).status).toBe(200);

		const retract = await handleConsoleMutation(
			post(`/admin/api/assessments/${id}/override-retract`, {
				confirmation: CID,
				reason: "override was wrong",
				idempotencyKey: nextKey(),
			}),
			mutationDeps(),
		);
		expect(retract.status).toBe(200);

		const winners = await getActiveLabelState(testEnv.DB, { src: LABELER_DID, uri, cid: CID });
		expect(winners.get("assessment-passed")?.active).toBe(false);
		expect(winners.get("assessment-overridden")?.active).toBe(false);
		// The original block stays negated — retraction does not re-issue it.
		expect(winners.get("malware")?.active).toBe(false);

		const evaluated = await evaluateSubject(uri);
		expect(evaluated.eligibility).toBe("blocked");
		expect(evaluated.reasonCodes).toContain("missing-assessment-pass");

		// A rerun then re-pends.
		const rerun = await handleConsoleMutation(
			post(`/admin/api/assessments/${id}/rerun`, {
				confirmation: CID,
				reason: "reassess after retract",
				idempotencyKey: nextKey(),
			}),
			mutationDeps(),
		);
		expect(rerun.status).toBe(200);
		const after = await getActiveLabelState(testEnv.DB, { src: LABELER_DID, uri, cid: CID });
		expect(after.get("assessment-pending")?.active).toBe(true);
	});

	it("rejects a confirmation that is not the release CID", async () => {
		const { id, uri } = await seedRun("retract-conf");
		await seedAutomatedBlock(uri, id, "malware");
		expect((await override(id, uri, ["malware"])).status).toBe(200);

		const response = await handleConsoleMutation(
			post(`/admin/api/assessments/${id}/override-retract`, {
				confirmation: "not-the-cid",
				reason: "bad confirm",
				idempotencyKey: nextKey(),
			}),
			mutationDeps(),
		);
		expect(response.status).toBe(400);
		expect((await bodyError(response)).code).toBe("CONFIRMATION_MISMATCH");
		// The pair is untouched.
		const winners = await getActiveLabelState(testEnv.DB, { src: LABELER_DID, uri, cid: CID });
		expect(winners.get("assessment-overridden")?.active).toBe(true);
	});

	it("409s the same key with a different fingerprint", async () => {
		const { id, uri } = await seedRun("retract-conflict");
		await seedAutomatedBlock(uri, id, "malware");
		expect((await override(id, uri, ["malware"])).status).toBe(200);

		const key = nextKey();
		const first = await handleConsoleMutation(
			post(`/admin/api/assessments/${id}/override-retract`, {
				confirmation: CID,
				reason: "first",
				idempotencyKey: key,
			}),
			mutationDeps(),
		);
		expect(first.status).toBe(200);
		const second = await handleConsoleMutation(
			post(`/admin/api/assessments/${id}/override-retract`, {
				confirmation: CID,
				reason: "different reason",
				idempotencyKey: key,
			}),
			mutationDeps(),
		);
		expect(second.status).toBe(409);
		expect((await bodyError(second)).code).toBe("IDEMPOTENCY_KEY_CONFLICT");
	});
});

describe("subject-label read + override effect preview", () => {
	it("returns the active winners including the manual override labels", async () => {
		const { id, uri } = await seedRun("subject-labels");
		await seedAutomatedBlock(uri, id, "malware");
		expect((await override(id, uri, ["malware"])).status).toBe(200);

		const response = await handleConsoleApi(
			getReq(`/admin/api/subjects/${encodeURIComponent(uri)}/labels?cid=${CID}`),
			readDeps(),
		);
		expect(response.status).toBe(200);
		const labels = await bodyData<{ val: string; active: boolean; neg: boolean }[]>(response);
		const byVal = new Map(labels.map((label) => [label.val, label]));
		expect(byVal.get("assessment-passed")?.active).toBe(true);
		expect(byVal.get("assessment-overridden")?.active).toBe(true);
		expect(byVal.get("malware")?.active).toBe(false);
		expect(byVal.get("malware")?.neg).toBe(true);
	});

	it("reports head provenance so a manually-headed block is not offered for override", async () => {
		const { id, uri } = await seedRun("subject-provenance");
		await seedAutomatedBlock(uri, id, "malware");
		const manual = await handleConsoleMutation(
			post("/admin/api/labels/issue", {
				uri,
				val: "impersonation",
				cid: CID,
				confirmation: CID,
				reason: "manually flagged impersonation",
				idempotencyKey: nextKey(),
			}),
			mutationDeps(),
		);
		expect(manual.status).toBe(200);

		const response = await handleConsoleApi(
			getReq(`/admin/api/subjects/${encodeURIComponent(uri)}/labels?cid=${CID}`),
			readDeps(),
		);
		const labels = await bodyData<{ val: string; active: boolean; automated: boolean }[]>(
			response,
		);
		const byVal = new Map(labels.map((label) => [label.val, label]));
		expect(byVal.get("malware")).toMatchObject({ active: true, automated: true });
		expect(byVal.get("impersonation")).toMatchObject({ active: true, automated: false });

		// The provenance flag keeps the console's offer aligned with the server's
		// negatable set: the manual head is rejected, the automated-only set proceeds.
		expect((await override(id, uri, ["malware", "impersonation"])).status).toBe(400);
		expect((await override(id, uri, ["malware"])).status).toBe(200);
	});

	it("grounds the override preview before→after in the evaluator", async () => {
		const { id, uri } = await seedRun("override-preview");
		await seedAutomatedBlock(uri, id, "malware");

		const response = await handleConsoleApi(
			getReq(
				`/admin/api/labels/override-effect-preview?uri=${encodeURIComponent(uri)}&cid=${CID}&negate=malware`,
			),
			readDeps(),
		);
		expect(response.status).toBe(200);
		const preview = await bodyData<{
			supersedes: { val: string }[];
			before: { eligibility: string; blockingLabels: string[] } | null;
			after: { eligibility: string; reasonCodes: string[]; blockingLabels: string[] } | null;
		}>(response);
		expect(preview.before?.eligibility).toBe("blocked");
		expect(preview.before?.blockingLabels).toContain("malware");
		// The override negates the block, so `after` no longer blocks on it — the
		// negated block shows as a superseded label, not a suppressed one.
		expect(preview.supersedes.map((s) => s.val)).toContain("malware");
		expect(preview.after?.eligibility).toBe("eligible");
		expect(preview.after?.reasonCodes).toContain("eligible-manual-override");
		expect(preview.after?.blockingLabels).not.toContain("malware");
	});

	it("rejects a preview whose negate set the submit endpoint would reject", async () => {
		const { id, uri } = await seedRun("preview-mismatch");
		await seedAutomatedBlock(uri, id, "malware");
		const manual = await handleConsoleMutation(
			post("/admin/api/labels/issue", {
				uri,
				val: "impersonation",
				cid: CID,
				confirmation: CID,
				reason: "manually flagged",
				idempotencyKey: nextKey(),
			}),
			mutationDeps(),
		);
		expect(manual.status).toBe(200);

		// A manually-headed block and an incomplete set both fail the same
		// live-set check the submit runs, so the preview cannot over-promise.
		const withManualHead = await handleConsoleApi(
			getReq(
				`/admin/api/labels/override-effect-preview?uri=${encodeURIComponent(uri)}&cid=${CID}&negate=malware&negate=impersonation`,
			),
			readDeps(),
		);
		expect(withManualHead.status).toBe(400);

		const liveSet = await handleConsoleApi(
			getReq(
				`/admin/api/labels/override-effect-preview?uri=${encodeURIComponent(uri)}&cid=${CID}&negate=malware`,
			),
			readDeps(),
		);
		expect(liveSet.status).toBe(200);
	});
});
