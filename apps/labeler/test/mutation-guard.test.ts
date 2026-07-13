import { applyD1Migrations, env } from "cloudflare:test";
import { generateKeyPair, SignJWT } from "jose";
import { beforeAll, describe, expect, it } from "vitest";

import type { AccessAuthConfig, AccessKeyResolver } from "../src/access-auth.js";
import {
	commitMutation,
	guardMutation,
	MutationGuardError,
	OPERATOR_REQUEST_HEADER,
	type MutationGuardCode,
	type MutationGuardDeps,
	type MutationSpec,
} from "../src/mutation-guard.js";
import { getOperatorActionByKey } from "../src/operator-actions.js";

const TEAM_DOMAIN = "https://example-team.cloudflareaccess.com";
const AUDIENCE = "test-audience";
const ORIGIN = "https://labeler.example.com";

interface TestEnv {
	DB: D1Database;
	TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
}

const testEnv = env as unknown as TestEnv;

let signKey: CryptoKey;
let resolver: AccessKeyResolver;
let adminToken: string;
let reviewerToken: string;

beforeAll(async () => {
	await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
	const pair = await generateKeyPair("RS256");
	signKey = pair.privateKey;
	resolver = (async () => pair.publicKey) as AccessKeyResolver;
	adminToken = await mintToken({ email: "admin@example.com" });
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

function baseConfig(): AccessAuthConfig {
	return {
		teamDomain: TEAM_DOMAIN,
		audience: AUDIENCE,
		admins: ["admin@example.com"],
		reviewers: ["reviewer@example.com"],
	};
}

function deps(overrides: Partial<MutationGuardDeps> = {}): MutationGuardDeps {
	return {
		db: testEnv.DB,
		config: baseConfig(),
		keys: resolver,
		now: () => new Date("2026-07-12T00:00:00.000Z"),
		expectedOrigin: ORIGIN,
		...overrides,
	};
}

interface TestBody {
	subjectUri: string;
	labelValue: string;
}

function testSpec(overrides: Partial<MutationSpec<TestBody>> = {}): MutationSpec<TestBody> {
	return {
		action: "label-issue",
		requiredRole: "reviewer",
		parseBody: (raw) => {
			const { subjectUri, labelValue } = raw;
			if (typeof subjectUri !== "string" || typeof labelValue !== "string")
				throw new MutationGuardError("INVALID_BODY");
			return { subjectUri, labelValue };
		},
		auditFields: (body) => ({ subjectUri: body.subjectUri, labelValue: body.labelValue }),
		...overrides,
	};
}

let keyCounter = 0;

function validBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	keyCounter++;
	return {
		subjectUri: "at://did:plc:x/com.emdashcms.experimental.package.release/pkg:1.0.0",
		labelValue: "security-yanked",
		reason: "malware found in the release artifact",
		idempotencyKey: `idem-${keyCounter}-abcdefgh`,
		...overrides,
	};
}

interface RequestOptions {
	token?: string;
	contentType?: string | null;
	csrf?: string | null;
	origin?: string;
	secFetchSite?: string;
	body?: unknown;
	rawBody?: string;
	spoofEmail?: string;
}

function buildRequest(opts: RequestOptions = {}): Request {
	const headers = new Headers();
	const contentType = opts.contentType === undefined ? "application/json" : opts.contentType;
	if (contentType !== null) headers.set("Content-Type", contentType);
	const csrf = opts.csrf === undefined ? "1" : opts.csrf;
	if (csrf !== null) headers.set(OPERATOR_REQUEST_HEADER, csrf);
	if (opts.token !== undefined) headers.set("Cf-Access-Jwt-Assertion", opts.token);
	if (opts.origin !== undefined) headers.set("Origin", opts.origin);
	if (opts.secFetchSite !== undefined) headers.set("Sec-Fetch-Site", opts.secFetchSite);
	if (opts.spoofEmail !== undefined)
		headers.set("Cf-Access-Authenticated-User-Email", opts.spoofEmail);
	const body = opts.rawBody ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body));
	return new Request(`${ORIGIN}/admin/api/labels`, { method: "POST", headers, body });
}

async function expectRejection<TBody>(
	request: Request,
	spec: MutationSpec<TBody>,
	guardDeps: MutationGuardDeps,
	code: MutationGuardCode,
	status: number,
): Promise<void> {
	await expect(guardMutation(request, spec, guardDeps)).rejects.toMatchObject({ code, status });
}

/** Idempotent effect keyed by the operator idempotency key, so a concurrent
 * duplicate that shares the key does not double-apply. Its row count is the
 * observable "did the effect run" signal. */
function effectFor(key: string): D1PreparedStatement[] {
	return [
		testEnv.DB.prepare(
			`INSERT INTO ingest_state (source, cursor, updated_at) VALUES (?, ?, ?)
			 ON CONFLICT(source) DO NOTHING`,
		).bind(`effect:${key}`, "cursor-1", "2026-07-12T00:00:00.000Z"),
	];
}

async function effectRowCount(key: string): Promise<number> {
	const row = await testEnv.DB.prepare(`SELECT COUNT(*) AS n FROM ingest_state WHERE source = ?`)
		.bind(`effect:${key}`)
		.first<{ n: number }>();
	return row?.n ?? 0;
}

/** A NON-idempotent effect: a plain INSERT (no ON CONFLICT) committing a distinct
 * row per caller. Proves the loser's effect is rolled back, not merely
 * de-duplicated, when its audit insert loses the idempotency-key race. */
function nonIdempotentEffect(key: string, tag: string): D1PreparedStatement[] {
	return [
		testEnv.DB.prepare(
			`INSERT INTO ingest_state (source, cursor, updated_at) VALUES (?, 'cursor-1', '2026-07-12T00:00:00.000Z')`,
		).bind(`nonidem:${key}:${tag}`),
	];
}

async function nonIdempotentRowCount(key: string): Promise<number> {
	const row = await testEnv.DB.prepare(`SELECT COUNT(*) AS n FROM ingest_state WHERE source LIKE ?`)
		.bind(`nonidem:${key}:%`)
		.first<{ n: number }>();
	return row?.n ?? 0;
}

describe("guardMutation — JSON content type", () => {
	it("rejects a missing content type", async () => {
		await expectRejection(
			buildRequest({ token: adminToken, contentType: null, body: validBody() }),
			testSpec(),
			deps(),
			"UNSUPPORTED_MEDIA_TYPE",
			415,
		);
	});

	it("rejects text/plain", async () => {
		await expectRejection(
			buildRequest({ token: adminToken, contentType: "text/plain", body: validBody() }),
			testSpec(),
			deps(),
			"UNSUPPORTED_MEDIA_TYPE",
			415,
		);
	});

	it("rejects application/x-www-form-urlencoded", async () => {
		await expectRejection(
			buildRequest({
				token: adminToken,
				contentType: "application/x-www-form-urlencoded",
				body: validBody(),
			}),
			testSpec(),
			deps(),
			"UNSUPPORTED_MEDIA_TYPE",
			415,
		);
	});

	it("rejects a non-utf-8 charset", async () => {
		await expectRejection(
			buildRequest({
				token: adminToken,
				contentType: "application/json; charset=latin1",
				body: validBody(),
			}),
			testSpec(),
			deps(),
			"UNSUPPORTED_MEDIA_TYPE",
			415,
		);
	});

	it("accepts application/json with a utf-8 charset parameter", async () => {
		const outcome = await guardMutation(
			buildRequest({
				token: adminToken,
				contentType: "application/json; charset=utf-8",
				body: validBody(),
			}),
			testSpec(),
			deps(),
		);
		expect(outcome.outcome).toBe("proceed");
	});
});

describe("guardMutation — same-origin", () => {
	it("rejects a mismatching Origin", async () => {
		await expectRejection(
			buildRequest({ token: adminToken, origin: "https://evil.example.com", body: validBody() }),
			testSpec(),
			deps(),
			"CROSS_ORIGIN",
			403,
		);
	});

	it("rejects a cross-site Sec-Fetch-Site", async () => {
		await expectRejection(
			buildRequest({ token: adminToken, secFetchSite: "cross-site", body: validBody() }),
			testSpec(),
			deps(),
			"CROSS_ORIGIN",
			403,
		);
	});

	it("accepts a request with neither Origin nor Sec-Fetch-Site (non-browser client)", async () => {
		const outcome = await guardMutation(
			buildRequest({ token: adminToken, body: validBody() }),
			testSpec(),
			deps(),
		);
		expect(outcome.outcome).toBe("proceed");
	});

	it("accepts a matching Origin and same-origin Sec-Fetch-Site", async () => {
		const outcome = await guardMutation(
			buildRequest({
				token: adminToken,
				origin: ORIGIN,
				secFetchSite: "same-origin",
				body: validBody(),
			}),
			testSpec(),
			deps(),
		);
		expect(outcome.outcome).toBe("proceed");
	});

	it("defaults expectedOrigin to the request URL origin", async () => {
		const outcome = await guardMutation(
			buildRequest({ token: adminToken, origin: ORIGIN, body: validBody() }),
			testSpec(),
			deps({ expectedOrigin: undefined }),
		);
		expect(outcome.outcome).toBe("proceed");
	});
});

describe("guardMutation — CSRF header", () => {
	it("rejects a missing X-EmDash-Request header", async () => {
		await expectRejection(
			buildRequest({ token: adminToken, csrf: null, body: validBody() }),
			testSpec(),
			deps(),
			"CSRF_HEADER_MISSING",
			403,
		);
	});

	it("rejects a wrong X-EmDash-Request value", async () => {
		await expectRejection(
			buildRequest({ token: adminToken, csrf: "0", body: validBody() }),
			testSpec(),
			deps(),
			"CSRF_HEADER_MISSING",
			403,
		);
	});
});

describe("guardMutation — Access identity", () => {
	it("rejects a request with no assertion header", async () => {
		await expectRejection(
			buildRequest({ body: validBody() }),
			testSpec(),
			deps(),
			"UNAUTHENTICATED",
			401,
		);
	});

	it("rejects an invalid assertion (delegated to W9.1 verification)", async () => {
		await expectRejection(
			buildRequest({ token: "not-a-jwt", body: validBody() }),
			testSpec(),
			deps(),
			"UNAUTHENTICATED",
			401,
		);
	});

	it("never derives identity from a spoofed plaintext email header", async () => {
		await expectRejection(
			buildRequest({ spoofEmail: "admin@example.com", body: validBody() }),
			testSpec(),
			deps(),
			"UNAUTHENTICATED",
			401,
		);
	});
});

describe("guardMutation — role", () => {
	it("rejects a reviewer attempting an admin-required action", async () => {
		await expectRejection(
			buildRequest({ token: reviewerToken, body: validBody() }),
			testSpec({ requiredRole: "admin" }),
			deps(),
			"FORBIDDEN_ROLE",
			403,
		);
	});

	it("lets an admin satisfy a reviewer requirement via inheritance", async () => {
		const outcome = await guardMutation(
			buildRequest({ token: adminToken, body: validBody() }),
			testSpec({ requiredRole: "reviewer" }),
			deps(),
		);
		expect(outcome.outcome).toBe("proceed");
		if (outcome.outcome !== "proceed") return;
		// Recorded as the role the admin actually held, not the reviewer gate level.
		expect(outcome.ctx.role).toBe("admin");
	});
});

describe("guardMutation — body validation", () => {
	it("rejects a non-object body", async () => {
		await expectRejection(
			buildRequest({ token: adminToken, rawBody: "[]" }),
			testSpec(),
			deps(),
			"INVALID_BODY",
			400,
		);
	});

	it("rejects an unparseable body", async () => {
		await expectRejection(
			buildRequest({ token: adminToken, rawBody: "{not json" }),
			testSpec(),
			deps(),
			"INVALID_BODY",
			400,
		);
	});

	it("rejects an empty, whitespace, or overlong reason", async () => {
		for (const reason of ["", "   ", "x".repeat(1001)]) {
			await expectRejection(
				buildRequest({ token: adminToken, body: validBody({ reason }) }),
				testSpec(),
				deps(),
				"INVALID_BODY",
				400,
			);
		}
	});

	it("rejects a malformed idempotency key", async () => {
		for (const idempotencyKey of ["short", "has spaces!", "a".repeat(201)]) {
			await expectRejection(
				buildRequest({ token: adminToken, body: validBody({ idempotencyKey }) }),
				testSpec(),
				deps(),
				"INVALID_BODY",
				400,
			);
		}
	});

	it("rejects endpoint fields that fail spec.parseBody", async () => {
		await expectRejection(
			buildRequest({ token: adminToken, body: validBody({ labelValue: 42 }) }),
			testSpec(),
			deps(),
			"INVALID_BODY",
			400,
		);
	});
});

describe("guardMutation — happy path", () => {
	it("returns proceed with a fully populated context", async () => {
		const body = validBody();
		const outcome = await guardMutation(
			buildRequest({ token: adminToken, body }),
			testSpec({ requiredRole: "admin" }),
			deps(),
		);
		expect(outcome.outcome).toBe("proceed");
		if (outcome.outcome !== "proceed") return;
		expect(outcome.ctx.identity).toMatchObject({ kind: "human", email: "admin@example.com" });
		expect(outcome.ctx.role).toBe("admin");
		expect(outcome.ctx.reason).toBe(body.reason);
		expect(outcome.ctx.idempotencyKey).toBe(body.idempotencyKey);
		expect(outcome.ctx.body).toEqual({ subjectUri: body.subjectUri, labelValue: body.labelValue });
		expect(outcome.ctx.actionId).toMatch(/^oact_/);
		expect(outcome.ctx.fingerprint).toMatch(/^[0-9a-f]{64}$/);
		expect(outcome.ctx.now.toISOString()).toBe("2026-07-12T00:00:00.000Z");
	});
});

describe("guardMutation — idempotency replay and conflict", () => {
	it("replays a recorded action without re-running the effect", async () => {
		const body = validBody();
		const first = await guardMutation(
			buildRequest({ token: adminToken, body }),
			testSpec(),
			deps(),
		);
		expect(first.outcome).toBe("proceed");
		if (first.outcome !== "proceed") return;

		const result = await commitMutation(
			testEnv.DB,
			first.ctx,
			testSpec(),
			effectFor(body.idempotencyKey as string),
			{ issued: first.ctx.actionId },
		);
		expect(result).toEqual({ issued: first.ctx.actionId });
		expect(await effectRowCount(body.idempotencyKey as string)).toBe(1);

		const replay = await guardMutation(
			buildRequest({ token: adminToken, body }),
			testSpec(),
			deps(),
		);
		expect(replay.outcome).toBe("replay");
		if (replay.outcome !== "replay") return;
		// Narrowed payload: only the stored result and its id, never reason/fingerprint.
		expect(replay).toEqual({
			outcome: "replay",
			result: { issued: first.ctx.actionId },
			actionId: first.ctx.actionId,
		});
		expect(replay).not.toHaveProperty("action");
		// The route returns on replay and never commits again, so the effect count is unchanged.
		expect(await effectRowCount(body.idempotencyKey as string)).toBe(1);
	});

	it("rejects a replay with the same key but a different request", async () => {
		const body = validBody();
		const first = await guardMutation(
			buildRequest({ token: adminToken, body }),
			testSpec(),
			deps(),
		);
		if (first.outcome !== "proceed") {
			expect.unreachable();
			return;
		}
		await commitMutation(
			testEnv.DB,
			first.ctx,
			testSpec(),
			effectFor(body.idempotencyKey as string),
			{
				ok: true,
			},
		);

		await expectRejection(
			buildRequest({ token: adminToken, body: { ...body, labelValue: "package-disputed" } }),
			testSpec(),
			deps(),
			"IDEMPOTENCY_KEY_CONFLICT",
			409,
		);
	});
});

describe("commitMutation", () => {
	it("writes the audit row atomically with its effect", async () => {
		const body = validBody();
		const outcome = await guardMutation(
			buildRequest({ token: adminToken, body }),
			testSpec(),
			deps(),
		);
		if (outcome.outcome !== "proceed") {
			expect.unreachable();
			return;
		}
		const result = await commitMutation(
			testEnv.DB,
			outcome.ctx,
			testSpec(),
			effectFor(body.idempotencyKey as string),
			{ issued: true },
		);
		expect(result).toEqual({ issued: true });

		const stored = await getOperatorActionByKey(testEnv.DB, body.idempotencyKey as string);
		expect(stored).not.toBeNull();
		expect(stored!.id).toBe(outcome.ctx.actionId);
		expect(stored!.action).toBe("label-issue");
		// Admin actor clearing a reviewer gate via inheritance: the immutable row
		// records the role the actor actually held (admin), never the gate level.
		expect(stored!.role).toBe("admin");
		expect(stored!.subjectUri).toBe(body.subjectUri);
		expect(stored!.labelValue).toBe(body.labelValue);
		expect(stored!.reason).toBe(body.reason);
		expect(await effectRowCount(body.idempotencyKey as string)).toBe(1);
	});

	it("records the directly-held role, not always admin", async () => {
		const body = validBody();
		const outcome = await guardMutation(
			buildRequest({ token: reviewerToken, body }),
			testSpec(),
			deps(),
		);
		if (outcome.outcome !== "proceed") {
			expect.unreachable();
			return;
		}
		expect(outcome.ctx.role).toBe("reviewer");
		await commitMutation(
			testEnv.DB,
			outcome.ctx,
			testSpec(),
			effectFor(body.idempotencyKey as string),
			{
				issued: true,
			},
		);
		const stored = await getOperatorActionByKey(testEnv.DB, body.idempotencyKey as string);
		expect(stored!.role).toBe("reviewer");
	});

	it("does not double-apply concurrent duplicates and returns the same result", async () => {
		const body = validBody();
		const g1 = await guardMutation(buildRequest({ token: adminToken, body }), testSpec(), deps());
		const g2 = await guardMutation(buildRequest({ token: adminToken, body }), testSpec(), deps());
		if (g1.outcome !== "proceed" || g2.outcome !== "proceed") {
			expect.unreachable();
			return;
		}

		const key = body.idempotencyKey as string;
		const [r1, r2] = await Promise.all([
			commitMutation(testEnv.DB, g1.ctx, testSpec(), nonIdempotentEffect(key, "1"), {
				winner: g1.ctx.actionId,
			}),
			commitMutation(testEnv.DB, g2.ctx, testSpec(), nonIdempotentEffect(key, "2"), {
				winner: g2.ctx.actionId,
			}),
		]);

		const stored = await getOperatorActionByKey(testEnv.DB, key);
		expect(stored).not.toBeNull();
		expect([g1.ctx.actionId, g2.ctx.actionId]).toContain(stored!.id);
		const winnerResult = JSON.parse(stored!.resultJson!) as unknown;
		expect(r1).toEqual(winnerResult);
		expect(r2).toEqual(winnerResult);
		// Only the winner's effect committed; the loser's batch — including its
		// distinct, non-idempotent effect row — rolled back.
		expect(await nonIdempotentRowCount(key)).toBe(1);
	});

	it("rejects concurrent duplicates that share a key but differ in content", async () => {
		const key = `idem-conflict-${Date.now()}-abcd`;
		const bodyA = validBody({ idempotencyKey: key, labelValue: "security-yanked" });
		const bodyB = validBody({ idempotencyKey: key, labelValue: "package-disputed" });
		const gA = await guardMutation(
			buildRequest({ token: adminToken, body: bodyA }),
			testSpec(),
			deps(),
		);
		const gB = await guardMutation(
			buildRequest({ token: adminToken, body: bodyB }),
			testSpec(),
			deps(),
		);
		if (gA.outcome !== "proceed" || gB.outcome !== "proceed") {
			expect.unreachable();
			return;
		}

		const settled = await Promise.allSettled([
			commitMutation(testEnv.DB, gA.ctx, testSpec(), nonIdempotentEffect(key, "A"), { v: "A" }),
			commitMutation(testEnv.DB, gB.ctx, testSpec(), nonIdempotentEffect(key, "B"), { v: "B" }),
		]);

		const fulfilled = settled.filter((r) => r.status === "fulfilled");
		const rejected = settled.filter((r) => r.status === "rejected");
		expect(fulfilled).toHaveLength(1);
		expect(rejected).toHaveLength(1);
		const reason = (rejected[0] as PromiseRejectedResult).reason;
		expect(reason).toBeInstanceOf(MutationGuardError);
		expect(reason).toMatchObject({ code: "IDEMPOTENCY_KEY_CONFLICT", status: 409 });
		// F1 regression: the losing request's NON-idempotent effect was rolled back
		// with its aborted batch. Exactly one effect row exists — the loser that got
		// the 409 committed nothing. (Under the old ON CONFLICT insert this was 2.)
		expect(await nonIdempotentRowCount(key)).toBe(1);
	});
});

describe("MutationGuardError", () => {
	it("renders a JSON error response that omits request content", async () => {
		const error = new MutationGuardError("IDEMPOTENCY_KEY_CONFLICT");
		const response = error.toResponse();
		expect(response.status).toBe(409);
		expect(response.headers.get("Content-Type")).toContain("application/json");
		expect(await response.json()).toEqual({
			error: { code: "IDEMPOTENCY_KEY_CONFLICT", message: expect.any(String) },
		});
	});
});
