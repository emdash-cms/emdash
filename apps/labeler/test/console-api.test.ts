import { applyD1Migrations, env } from "cloudflare:test";
import { generateKeyPair, SignJWT } from "jose";
import { beforeAll, describe, expect, it } from "vitest";

import type { AccessKeyResolver } from "../src/access-auth.js";
import { createSubject, recordFinding } from "../src/assessment-store.js";
import {
	consoleAssetPath,
	handleConsoleApi,
	probeJetstreamConnected,
	type ConsoleApiDeps,
} from "../src/console-api.js";
import { OPERATOR_REQUEST_HEADER } from "../src/mutation-guard.js";
import { buildOperatorActionInsert, type OperatorActionType } from "../src/operator-actions.js";

const TEAM_DOMAIN = "https://example-team.cloudflareaccess.com";
const AUDIENCE = "test-audience";
const ORIGIN = "https://labeler.example.com";
const LABELER_DID = "did:web:labels.emdashcms.com";

const URI_A =
	"at://did:plc:aaaaaaaaaaaaaaaaaaaaaaaa/com.emdashcms.experimental.package.release/rkA";
const CID_A = "bafyreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const URI_B =
	"at://did:plc:bbbbbbbbbbbbbbbbbbbbbbbb/com.emdashcms.experimental.package.release/rkB";
const CID_B = "bafyreibbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const URI_S =
	"at://did:plc:ssssssssssssssssssssssss/com.emdashcms.experimental.package.release/rkS";
const CID_S_OLD = "bafyreisssssssssssssssssssssssssssssssssssssssssssssssold";
const CID_S_NEW = "bafyreisssssssssssssssssssssssssssssssssssssssssssssssnew";

// Assessment ids must satisfy assessment-lifecycle's ASSESSMENT_ID (ULID) regex,
// which the detail route validates via getAssessment.
const ASMT_PASS_A = "asmt_SQCP5CP1X1RBMM0V0TQP2WR9PD";
const ASMT_BLOCK_B = "asmt_R79G2W700J4F005EAG66HP66JR";
const ASMT_RUN = "asmt_34XM75YB5AJ9Z84B9EJBWM0CV1";
const ASMT_PENDING = "asmt_RT0G62FEF7MAX2R6K0K0P3E3RN";
const ASMT_S_STALE = "asmt_BZ7JNKG1TYRMZMVP0XQEGEC1Y7";
const ASMT_S_PASS = "asmt_K2Y9KK9SSTD43VVT780P6HMT8A";
const ASMT_S_CANCEL = "asmt_7ZH8QK2M4T8V0X2R4W6Y8B1C3D";

interface TestEnv {
	DB: D1Database;
	TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
}
const testEnv = env as unknown as TestEnv;

let signKey: CryptoKey;
let resolver: AccessKeyResolver;
let reviewerToken: string;
let adminToken: string;
let noRoleToken: string;

beforeAll(async () => {
	await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
	const pair = await generateKeyPair("RS256");
	signKey = pair.privateKey;
	resolver = (async () => pair.publicKey) as AccessKeyResolver;
	reviewerToken = await mintToken({ email: "reviewer@example.com" });
	adminToken = await mintToken({ email: "admin@example.com" });
	noRoleToken = await mintToken({ email: "nobody@example.com" });

	await seedSubjects();
	await seedAssessments();
	await seedFindings();
	await seedLabels();
	await seedOperatorActions();
	await seedDeadLetters(3);
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

function deps(overrides: Partial<ConsoleApiDeps> = {}): ConsoleApiDeps {
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

interface ReqOptions {
	method?: string;
	token?: string;
	csrf?: string | null;
	spoofEmail?: string;
}

function req(path: string, opts: ReqOptions = {}): Request {
	const headers = new Headers();
	const csrf = opts.csrf === undefined ? "1" : opts.csrf;
	if (csrf !== null) headers.set(OPERATOR_REQUEST_HEADER, csrf);
	if (opts.token !== undefined) headers.set("Cf-Access-Jwt-Assertion", opts.token);
	if (opts.spoofEmail !== undefined)
		headers.set("Cf-Access-Authenticated-User-Email", opts.spoofEmail);
	return new Request(`${ORIGIN}${path}`, { method: opts.method ?? "GET", headers });
}

async function seedSubjects(): Promise<void> {
	await createSubject(testEnv.DB, {
		uri: URI_A,
		cid: CID_A,
		did: "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa",
		collection: "com.emdashcms.experimental.package.release",
		rkey: "rkA",
		now: new Date("2026-07-08T08:55:00.000Z"),
	});
	await createSubject(testEnv.DB, {
		uri: URI_B,
		cid: CID_B,
		did: "did:plc:bbbbbbbbbbbbbbbbbbbbbbbb",
		collection: "com.emdashcms.experimental.package.release",
		rkey: "rkB",
		now: new Date("2026-07-08T09:55:00.000Z"),
	});
	await createSubject(testEnv.DB, {
		uri: URI_S,
		cid: CID_S_OLD,
		did: "did:plc:ssssssssssssssssssssssss",
		collection: "com.emdashcms.experimental.package.release",
		rkey: "rkS",
		now: new Date("2026-07-01T10:00:00.000Z"),
	});
	await createSubject(testEnv.DB, {
		uri: URI_S,
		cid: CID_S_NEW,
		did: "did:plc:ssssssssssssssssssssssss",
		collection: "com.emdashcms.experimental.package.release",
		rkey: "rkS",
		now: new Date("2026-07-05T10:00:00.000Z"),
	});
}

interface SeedAssessment {
	id: string;
	uri: string;
	cid: string;
	state: string;
	createdAt: string;
	modelId?: string;
	promptHash?: string;
}

async function seedAssessment(a: SeedAssessment): Promise<void> {
	const epoch = Date.parse(a.createdAt);
	await testEnv.DB.prepare(
		`INSERT INTO assessments
		 (id, run_key, uri, cid, artifact_id, artifact_checksum, state, trigger, trigger_id,
		  policy_version, model_id, prompt_hash, public_summary, coverage_json,
		  supersedes_assessment_id, started_at, started_at_epoch_ms, completed_at,
		  completed_at_epoch_ms, created_at, created_at_epoch_ms)
		 VALUES (?, ?, ?, ?, NULL, NULL, ?, 'initial', ?, '2026-07-10.experimental.2', ?, ?, NULL,
		  '{"code":"complete","images":"not-present","metadata":"complete"}',
		  NULL, NULL, NULL, NULL, NULL, ?, ?)`,
	)
		.bind(
			a.id,
			`run-${a.id}`,
			a.uri,
			a.cid,
			a.state,
			`initial:${a.id}`,
			a.modelId ?? null,
			a.promptHash ?? null,
			a.createdAt,
			epoch,
		)
		.run();
}

async function seedAssessments(): Promise<void> {
	await seedAssessment({
		id: ASMT_PASS_A,
		uri: URI_A,
		cid: CID_A,
		state: "passed",
		createdAt: "2026-07-08T09:00:00.000Z",
	});
	await seedAssessment({
		id: ASMT_BLOCK_B,
		uri: URI_B,
		cid: CID_B,
		state: "blocked",
		createdAt: "2026-07-08T10:00:00.000Z",
		modelId: "@cf/meta/llama-3.1-70b-instruct",
		promptHash: "sha256:prompt",
	});
	await seedAssessment({
		id: ASMT_RUN,
		uri: URI_A,
		cid: CID_A,
		state: "running",
		createdAt: "2026-07-09T08:00:00.000Z",
	});
	await seedAssessment({
		id: ASMT_PENDING,
		uri: URI_A,
		cid: CID_A,
		state: "pending",
		createdAt: "2026-07-09T09:00:00.000Z",
	});
	// Subject-history subject: passed + stale + cancelled across two CIDs.
	await seedAssessment({
		id: ASMT_S_STALE,
		uri: URI_S,
		cid: CID_S_OLD,
		state: "stale",
		createdAt: "2026-07-02T10:00:00.000Z",
	});
	await seedAssessment({
		id: ASMT_S_PASS,
		uri: URI_S,
		cid: CID_S_NEW,
		state: "passed",
		createdAt: "2026-07-05T10:00:00.000Z",
	});
	await seedAssessment({
		id: ASMT_S_CANCEL,
		uri: URI_S,
		cid: CID_S_NEW,
		state: "cancelled",
		createdAt: "2026-07-05T11:00:00.000Z",
	});
}

async function seedFindings(): Promise<void> {
	await recordFinding(testEnv.DB, {
		assessmentId: ASMT_BLOCK_B,
		source: "deterministic",
		category: "malware",
		severity: "critical",
		title: "Known malware signature match",
		publicSummary: "This release matches a known malware signature.",
		privateDetail: "YARA rule stealer-generic-v3 matched dist/postinstall.js:1.",
		evidenceRefs: ["evid_01"],
		now: new Date("2026-07-08T10:01:00.000Z"),
	});
	await recordFinding(testEnv.DB, {
		assessmentId: ASMT_BLOCK_B,
		source: "capability",
		category: "obfuscated-code",
		severity: "high",
		confidence: 0.94,
		title: "Heavily obfuscated postinstall script",
		publicSummary: "A postinstall script uses obfuscation techniques.",
		privateDetail: "String-array rotation plus eval-based deobfuscation; entropy 7.91/8.",
		evidenceRefs: ["evid_01"],
		now: new Date("2026-07-08T10:02:00.000Z"),
	});
}

async function seedLabel(input: {
	actionId: number;
	val: string;
	neg: 0 | 1;
	cts: string;
}): Promise<void> {
	await testEnv.DB.prepare(
		`INSERT INTO issuance_actions (id, actor, type, reason, idempotency_key, created_at, assessment_id)
		 VALUES (?, ?, 'automated-assessment', 'r', ?, ?, ?)`,
	)
		.bind(input.actionId, LABELER_DID, `idem-label-${input.actionId}`, input.cts, ASMT_BLOCK_B)
		.run();
	await testEnv.DB.prepare(
		`INSERT INTO issued_labels (action_id, ver, src, uri, cid, val, neg, cts, sig, signing_key_id)
		 VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, 'v1')`,
	)
		.bind(
			input.actionId,
			LABELER_DID,
			URI_B,
			CID_B,
			input.val,
			input.neg,
			input.cts,
			new Uint8Array([0]),
		)
		.run();
}

async function seedLabels(): Promise<void> {
	await seedLabel({ actionId: 1001, val: "malware", neg: 0, cts: "2026-07-08T10:05:00.000Z" });
	await seedLabel({
		actionId: 1002,
		val: "obfuscated-code",
		neg: 0,
		cts: "2026-07-08T10:06:00.000Z",
	});
	await seedLabel({ actionId: 1003, val: "malware", neg: 1, cts: "2026-07-08T10:10:00.000Z" });
}

async function seedOperatorActions(): Promise<void> {
	const rows: { id: string; action: OperatorActionType; createdAt: string }[] = [
		{ id: "oact_1", action: "label-issue", createdAt: "2026-07-10T01:00:00.000Z" },
		{ id: "oact_2", action: "assessment-rerun", createdAt: "2026-07-10T02:00:00.000Z" },
		{ id: "oact_3", action: "label-retract", createdAt: "2026-07-10T03:00:00.000Z" },
	];
	for (const row of rows) {
		await buildOperatorActionInsert(testEnv.DB, {
			id: row.id,
			actorType: "human",
			actorId: "access|sub-1",
			actorEmail: "reviewer@example.com",
			actorCommonName: null,
			role: "reviewer",
			action: row.action,
			subjectUri: URI_B,
			subjectCid: CID_B,
			labelValue: "malware",
			reason: "operator reason",
			idempotencyKey: `idem-${row.id}-abcdefgh`,
			requestFingerprint: "a".repeat(64),
			resultJson: '{"ok":true}',
			metadataJson: "{}",
			createdAt: row.createdAt,
			createdAtEpochMs: Date.parse(row.createdAt),
		}).run();
	}
}

async function seedDeadLetters(count: number): Promise<void> {
	for (let i = 0; i < count; i++) {
		await testEnv.DB.prepare(
			`INSERT INTO dead_letters (did, collection, rkey, reason, payload, received_at)
			 VALUES (?, 'col', ?, 'verify-failed', ?, '2026-07-10 00:00:00')`,
		)
			.bind(`did:plc:dead${i}`, `rk${i}`, new Uint8Array([0]))
			.run();
	}
}

async function body(response: Response): Promise<{ data?: unknown; error?: { code: string } }> {
	return response.json();
}

describe("handleConsoleApi — guard rejections", () => {
	it("rejects a request with no assertion header (401)", async () => {
		const res = await handleConsoleApi(req("/admin/api/assessments"), deps());
		expect(res.status).toBe(401);
		expect((await body(res)).error?.code).toBe("UNAUTHENTICATED");
	});

	it("rejects a spoofed email header without a verified assertion (401)", async () => {
		const res = await handleConsoleApi(
			req("/admin/api/assessments", { spoofEmail: "admin@example.com" }),
			deps(),
		);
		expect(res.status).toBe(401);
	});

	it("rejects an edge-authenticated identity with no role (403)", async () => {
		const res = await handleConsoleApi(
			req("/admin/api/assessments", { token: noRoleToken }),
			deps(),
		);
		expect(res.status).toBe(403);
		expect((await body(res)).error?.code).toBe("FORBIDDEN_ROLE");
	});

	it("rejects a missing CSRF header (403)", async () => {
		const res = await handleConsoleApi(
			req("/admin/api/assessments", { token: reviewerToken, csrf: null }),
			deps(),
		);
		expect(res.status).toBe(403);
		expect((await body(res)).error?.code).toBe("CSRF_HEADER_MISSING");
	});

	it("admits an admin by inheritance", async () => {
		const res = await handleConsoleApi(
			req("/admin/api/assessments", { token: adminToken }),
			deps(),
		);
		expect(res.status).toBe(200);
	});

	// The guard runs before route matching, so every family must reject an
	// unauthenticated caller identically — no route reaches a store read (and so
	// no private evidence) without a verified assertion.
	it.each([
		"/admin/api/assessments",
		`/admin/api/assessments/${ASMT_BLOCK_B}`,
		`/admin/api/assessments/${ASMT_BLOCK_B}/findings`,
		`/admin/api/assessments/${ASMT_BLOCK_B}/labels`,
		`/admin/api/subjects/${encodeURIComponent(URI_S)}`,
		"/admin/api/audit-log",
		"/admin/api/status",
	])("rejects an unauthenticated request to %s (401)", async (path) => {
		const res = await handleConsoleApi(req(path), deps());
		expect(res.status).toBe(401);
		expect((await body(res)).error?.code).toBe("UNAUTHENTICATED");
	});
});

describe("handleConsoleApi — method + routing", () => {
	it("rejects a non-GET method (405)", async () => {
		const res = await handleConsoleApi(
			req("/admin/api/assessments", { method: "POST", token: reviewerToken }),
			deps(),
		);
		expect(res.status).toBe(405);
		expect((await body(res)).error?.code).toBe("METHOD_NOT_ALLOWED");
	});

	it("404s an unknown sub-path", async () => {
		const res = await handleConsoleApi(req("/admin/api/nope", { token: reviewerToken }), deps());
		expect(res.status).toBe(404);
		expect((await body(res)).error?.code).toBe("NOT_FOUND");
	});

	it("never emits a CORS allow-origin header", async () => {
		const res = await handleConsoleApi(
			req("/admin/api/assessments", { token: reviewerToken }),
			deps(),
		);
		expect(res.headers.get("access-control-allow-origin")).toBeNull();
		expect(res.headers.get("cache-control")).toBe("no-store");
	});
});

describe("handleConsoleApi — assessments", () => {
	it("lists decision/pending runs and filters by state", async () => {
		const res = await handleConsoleApi(
			req("/admin/api/assessments?state=blocked", { token: reviewerToken }),
			deps(),
		);
		expect(res.status).toBe(200);
		const data = (await body(res)).data as { items: { id: string; publicState: string }[] };
		expect(data.items.map((a) => a.id)).toContain(ASMT_BLOCK_B);
		expect(data.items.every((a) => a.publicState === "blocked")).toBe(true);
	});

	it("serves modelId/promptHash on the detail view", async () => {
		const res = await handleConsoleApi(
			req(`/admin/api/assessments/${ASMT_BLOCK_B}`, { token: reviewerToken }),
			deps(),
		);
		const run = (await body(res)).data as {
			modelId: string;
			promptHash: string;
			coverageJson?: unknown;
		};
		expect(run.modelId).toBe("@cf/meta/llama-3.1-70b-instruct");
		expect(run).not.toHaveProperty("coverageJson");
	});

	it("404s an absent assessment id (client maps to null)", async () => {
		const res = await handleConsoleApi(
			req("/admin/api/assessments/asmt_ZZZZZZZZZZZZZZZZZZZZZZZZZZ", { token: reviewerToken }),
			deps(),
		);
		expect(res.status).toBe(404);
	});

	it("404s a malformed assessment id (client maps to null)", async () => {
		const res = await handleConsoleApi(
			req("/admin/api/assessments/not-a-valid-id", { token: reviewerToken }),
			deps(),
		);
		expect(res.status).toBe(404);
	});
});

describe("handleConsoleApi — findings and labels", () => {
	it("serves findings with the operator-only privateDetail", async () => {
		const res = await handleConsoleApi(
			req(`/admin/api/assessments/${ASMT_BLOCK_B}/findings`, { token: reviewerToken }),
			deps(),
		);
		const findings = (await body(res)).data as { privateDetail: string; category: string }[];
		expect(findings.length).toBe(2);
		expect(
			findings.every((f) => typeof f.privateDetail === "string" && f.privateDetail.length > 0),
		).toBe(true);
	});

	it("serves the full label history including negations", async () => {
		const res = await handleConsoleApi(
			req(`/admin/api/assessments/${ASMT_BLOCK_B}/labels`, { token: reviewerToken }),
			deps(),
		);
		const labels = (await body(res)).data as { val: string; neg: boolean }[];
		expect(labels.length).toBe(3);
		expect(labels.some((l) => l.neg === true)).toBe(true);
	});

	it("resolves URI-wide labels for a bare-DID publisher subject with no cid", async () => {
		const publisherDid = "did:plc:pppppppppppppppppppppppp";
		await testEnv.DB.prepare(
			`INSERT INTO issuance_actions (id, actor, type, reason, idempotency_key, created_at)
			 VALUES (2001, ?, 'manual-label', 'r', 'idem-pub-2001', '2026-07-09T00:00:00.000Z')`,
		)
			.bind(LABELER_DID)
			.run();
		await testEnv.DB.prepare(
			`INSERT INTO issued_labels (action_id, ver, src, uri, cid, val, neg, cts, sig, signing_key_id)
			 VALUES (2001, 1, ?, ?, NULL, 'publisher-compromised', 0, '2026-07-09T00:00:00.000Z', ?, 'v1')`,
		)
			.bind(LABELER_DID, publisherDid, new Uint8Array([0]))
			.run();

		const res = await handleConsoleApi(
			req(`/admin/api/subjects/${encodeURIComponent(publisherDid)}/labels`, {
				token: reviewerToken,
			}),
			deps(),
		);
		expect(res.status).toBe(200);
		const labels = (await body(res)).data as { val: string; active: boolean }[];
		expect(labels.find((l) => l.val === "publisher-compromised")?.active).toBe(true);
	});
});

describe("handleConsoleApi — subject history", () => {
	it("returns the current CID and full-lifecycle runs (stale/cancelled visible)", async () => {
		const res = await handleConsoleApi(
			req(`/admin/api/subjects/${encodeURIComponent(URI_S)}`, { token: reviewerToken }),
			deps(),
		);
		expect(res.status).toBe(200);
		const view = (await body(res)).data as {
			subject: { cid: string };
			assessments: { state: string }[];
		};
		expect(view.subject.cid).toBe(CID_S_NEW);
		const states = view.assessments.map((a) => a.state);
		expect(states).toContain("stale");
		expect(states).toContain("cancelled");
	});

	it("404s a never-observed subject", async () => {
		const res = await handleConsoleApi(
			req(`/admin/api/subjects/${encodeURIComponent("at://did:plc:missing/col/rk")}`, {
				token: reviewerToken,
			}),
			deps(),
		);
		expect(res.status).toBe(404);
	});
});

describe("handleConsoleApi — audit log", () => {
	it("returns sanitized rows without the internal replay fields", async () => {
		const res = await handleConsoleApi(
			req("/admin/api/audit-log", { token: reviewerToken }),
			deps(),
		);
		const data = (await body(res)).data as { items: Record<string, unknown>[] };
		expect(data.items.length).toBe(3);
		const [newest] = data.items;
		expect(newest!.id).toBe("oact_3");
		for (const item of data.items) {
			expect(item).not.toHaveProperty("idempotencyKey");
			expect(item).not.toHaveProperty("requestFingerprint");
			expect(item).not.toHaveProperty("resultJson");
		}
	});

	it("paginates with a keyset cursor", async () => {
		const p1 = await handleConsoleApi(
			req("/admin/api/audit-log?limit=2", { token: reviewerToken }),
			deps(),
		);
		const d1 = (await body(p1)).data as { items: { id: string }[]; nextCursor?: string };
		expect(d1.items.map((i) => i.id)).toEqual(["oact_3", "oact_2"]);
		expect(d1.nextCursor).toBeDefined();

		const p2 = await handleConsoleApi(
			req(`/admin/api/audit-log?limit=2&cursor=${d1.nextCursor}`, { token: reviewerToken }),
			deps(),
		);
		const d2 = (await body(p2)).data as { items: { id: string }[]; nextCursor?: string };
		expect(d2.items.map((i) => i.id)).toEqual(["oact_1"]);
		expect(d2.nextCursor).toBeUndefined();
	});
});

describe("handleConsoleApi — limit and cursor validation", () => {
	it("clamps an over-max limit to 100", async () => {
		const res = await handleConsoleApi(
			req("/admin/api/assessments?limit=500", { token: reviewerToken }),
			deps(),
		);
		expect(res.status).toBe(200);
	});

	it("400s a non-numeric limit", async () => {
		const res = await handleConsoleApi(
			req("/admin/api/assessments?limit=abc", { token: reviewerToken }),
			deps(),
		);
		expect(res.status).toBe(400);
		expect((await body(res)).error?.code).toBe("INVALID_REQUEST");
	});

	it("400s a cursor whose filter hash no longer matches", async () => {
		const p1 = await handleConsoleApi(
			req("/admin/api/assessments?limit=1", { token: reviewerToken }),
			deps(),
		);
		const d1 = (await body(p1)).data as { nextCursor?: string };
		expect(d1.nextCursor).toBeDefined();
		const res = await handleConsoleApi(
			req(`/admin/api/assessments?state=passed&cursor=${d1.nextCursor}`, { token: reviewerToken }),
			deps(),
		);
		expect(res.status).toBe(400);
		expect((await body(res)).error?.code).toBe("INVALID_CURSOR");
	});
});

describe("handleConsoleApi — system status", () => {
	it("grounds every field: pending count, dead-letter depth, injected jetstream flag", async () => {
		const res = await handleConsoleApi(
			req("/admin/api/status", { token: reviewerToken }),
			deps({ jetstreamConnected: async () => false }),
		);
		const status = (await body(res)).data as {
			labelerDid: string;
			jetstreamConnected: boolean;
			pendingAssessments: number;
			deadLetterDepth: number;
			automationPaused: boolean;
			pausedReason: string | null;
			pausedSince: string | null;
		};
		expect(status.labelerDid).toBe(LABELER_DID);
		expect(status.jetstreamConnected).toBe(false);
		// asmt_run (running) + asmt_pending (pending).
		expect(status.pendingAssessments).toBe(2);
		expect(status.deadLetterDepth).toBe(3);
		// Ingestion runs by default: the seeded kill-switch reads unpaused.
		expect(status.automationPaused).toBe(false);
		expect(status.pausedReason).toBeNull();
		expect(status.pausedSince).toBeNull();
		expect(status).not.toHaveProperty("lastReconciliationAt");
	});

	it("reports the paused state, reason, and since when ingestion is paused", async () => {
		await testEnv.DB.prepare(
			`UPDATE automation_state
			 SET paused = 1, paused_reason = 'incident-77', updated_at = '2026-07-13T12:00:00.000Z'
			 WHERE id = 1`,
		).run();
		try {
			const res = await handleConsoleApi(req("/admin/api/status", { token: reviewerToken }), deps());
			const status = (await body(res)).data as {
				automationPaused: boolean;
				pausedReason: string | null;
				pausedSince: string | null;
			};
			expect(status.automationPaused).toBe(true);
			expect(status.pausedReason).toBe("incident-77");
			expect(status.pausedSince).toBe("2026-07-13T12:00:00.000Z");
		} finally {
			await testEnv.DB.prepare(
				`UPDATE automation_state SET paused = 0, paused_reason = NULL WHERE id = 1`,
			).run();
		}
	});
});

describe("consoleAssetPath — asset prefix rewrite", () => {
	// The SPA is built with base "/admin/" but the asset binding serves
	// ./dist/console one-to-one, so the /admin prefix must be stripped before
	// ASSETS.fetch or every hashed asset falls through to the SPA shell.
	it.each([
		["/admin", "/"],
		["/admin/", "/"],
		["/admin/assets/index-abc123.js", "/assets/index-abc123.js"],
		["/admin/assets/index-abc123.css", "/assets/index-abc123.css"],
		["/admin/index.html", "/index.html"],
		// Client-side deep links resolve to no file, so the SPA fallback serves
		// the shell — the rewrite just has to land them under the binding root.
		["/admin/assessments/abc", "/assessments/abc"],
		["/admin/subjects", "/subjects"],
	])("rewrites %s to %s", (input, expected) => {
		expect(consoleAssetPath(input)).toBe(expected);
	});

	// Must NOT be treated as console assets: near-miss prefixes and the public
	// surface stay out of the asset branch (they fall through to the 404).
	it.each(["/adminx", "/administrator", "/admin-console", "/", "/xrpc/x", "/.well-known/did.json"])(
		"returns null for the non-asset path %s",
		(input) => {
			expect(consoleAssetPath(input)).toBeNull();
		},
	);

	// The read API is dispatched before the asset branch; the helper also
	// excludes it so an asset rewrite can never swallow an API path.
	it.each(["/admin/api", "/admin/api/", "/admin/api/status", "/admin/api/assessments/x"])(
		"never treats the API path %s as an asset",
		(input) => {
			expect(consoleAssetPath(input)).toBeNull();
		},
	);
});

describe("probeJetstreamConnected — degradation", () => {
	it("reports disconnected (not an error) when both the DO and the D1 fallback fail", async () => {
		const brokenEnv = {
			LABELER_DISCOVERY_DO: {
				idFromName: () => ({}),
				get: () => ({
					fetch: async () => {
						throw new Error("DO unreachable");
					},
				}),
			},
			DB: {
				prepare: () => ({
					first: async () => {
						throw new Error("no such table: ingest_state");
					},
				}),
			},
		} as unknown as Parameters<typeof probeJetstreamConnected>[0];
		expect(await probeJetstreamConnected(brokenEnv)).toBe(false);
	});
});
