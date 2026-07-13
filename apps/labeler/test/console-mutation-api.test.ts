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
import { createSubject, getActiveLabelState } from "../src/assessment-store.js";
import { handleConsoleApi, type ConsoleApiDeps } from "../src/console-api.js";
import {
	handleConsoleMutation,
	type ConsoleMutationDeps,
	type IssuedLabelDescriptor,
} from "../src/console-mutation-api.js";
import { OPERATOR_REQUEST_HEADER } from "../src/mutation-guard.js";
import { issueManualLabel } from "../src/service.js";

const TEAM_DOMAIN = "https://example-team.cloudflareaccess.com";
const AUDIENCE = "test-audience";
const ORIGIN = "https://labeler.example.com";
const LABELER_DID = "did:web:labels.emdashcms.com";
const LABELER_SERVICE_URL = "https://labels.emdashcms.com";
const PUBLISHER_DID = "did:plc:publisher000000000000000000";
const PRIVATE_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAE";
const MULTIKEY = "zDnaepsL7AXenJkVYdkh5KuKsSU7Ykh7kyXaLLU7auN9FWSiZ";
const CID = "bafkreif4oaymum54i5qefbwoblrt5zasfjhpyhyvacpseqtehi3queew5m";
const CID_2 = "bafkreieq5jui4j25lacwomsqgjeswwl3y5zcdrresptwgmfylxo2depppq";

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
let adminToken: string;
let noRoleToken: string;
let keySeq = 0;

beforeAll(async () => {
	await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
	const pair = await generateKeyPair("RS256");
	signKey = pair.privateKey;
	resolver = (async () => pair.publicKey) as AccessKeyResolver;
	reviewerToken = await mintToken({ email: "reviewer@example.com" });
	adminToken = await mintToken({ email: "admin@example.com" });
	noRoleToken = await mintToken({ email: "nobody@example.com" });
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
	const published: string[] = [];
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
		afterCommit: async (actionId) => {
			published.push(actionId);
		},
		defer: (work) => {
			void work;
		},
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

interface PostOptions {
	token?: string | null;
	csrf?: string | null;
	contentType?: string | null;
	origin?: string;
}

function post(path: string, body: unknown, opts: PostOptions = {}): Request {
	const headers = new Headers();
	const csrf = opts.csrf === undefined ? "1" : opts.csrf;
	if (csrf !== null) headers.set(OPERATOR_REQUEST_HEADER, csrf);
	const contentType = opts.contentType === undefined ? "application/json" : opts.contentType;
	if (contentType !== null) headers.set("Content-Type", contentType);
	const token = opts.token === undefined ? reviewerToken : opts.token;
	if (token !== null) headers.set("Cf-Access-Jwt-Assertion", token);
	if (opts.origin) headers.set("Origin", opts.origin);
	return new Request(`${ORIGIN}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
}

function getReq(path: string, token: string | null = reviewerToken): Request {
	const headers = new Headers();
	headers.set(OPERATOR_REQUEST_HEADER, "1");
	if (token !== null) headers.set("Cf-Access-Jwt-Assertion", token);
	return new Request(`${ORIGIN}${path}`, { method: "GET", headers });
}

function releaseUri(rkey: string): string {
	return `at://${PUBLISHER_DID}/com.emdashcms.experimental.package.release/${rkey}`;
}

function profileUri(rkey: string): string {
	return `at://${PUBLISHER_DID}/com.emdashcms.experimental.package.profile/${rkey}`;
}

async function seedReleaseSubject(rkey: string, cid = CID): Promise<string> {
	const uri = releaseUri(rkey);
	await createSubject(testEnv.DB, {
		uri,
		cid,
		did: PUBLISHER_DID,
		collection: "com.emdashcms.experimental.package.release",
		rkey,
		now: new Date("2026-07-08T08:00:00.000Z"),
	});
	return uri;
}

function nextKey(): string {
	keySeq += 1;
	return `idem-key-${keySeq.toString().padStart(6, "0")}`;
}

/**
 * Simulates the in-batch signing-guard suppression a signing-key rotation race
 * produces: the unguarded `operator_actions` INSERT commits while the guarded
 * `issuance_actions` / `issued_labels` INSERTs match zero rows. Wraps `batch` to
 * run only the audit INSERT, leaving the exact "audit row present, label absent"
 * phantom state the handler's post-commit verification must reject. Every other
 * method (`prepare`, etc.) passes through to the real D1, so no signing_state is
 * written and later tests stay isolated.
 */
function suppressIssuanceDb(db: D1Database): D1Database {
	return new Proxy(db, {
		get(target, prop, receiver) {
			if (prop === "batch")
				return (statements: D1PreparedStatement[]) => target.batch([statements[0]!]);
			const value: unknown = Reflect.get(target, prop, receiver);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
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

describe("console mutation: issue/retract effect + audit atomicity", () => {
	it("commits the label, issuance action, and audit row with consistent linkage", async () => {
		const uri = await seedReleaseSubject("atomicity-ok");
		const key = nextKey();
		const response = await handleConsoleMutation(
			post("/admin/api/labels/issue", {
				uri,
				val: "security-yanked",
				confirmation: "atomicity-ok",
				reason: "withdrawing for a disclosed CVE",
				idempotencyKey: key,
			}),
			mutationDeps(),
		);
		expect(response.status).toBe(200);
		const descriptor = await bodyData<IssuedLabelDescriptor>(response);
		expect(descriptor).toMatchObject({
			val: "security-yanked",
			uri,
			cid: null,
			neg: false,
			effect: "block",
		});
		expect(descriptor.actionId).toMatch(/^oact_/);
		// No sequence in the idempotent result.
		expect("sequence" in descriptor).toBe(false);

		const audit = await testEnv.DB.prepare(
			`SELECT id, action, actor_type, actor_email, role, subject_uri, subject_cid, label_value
			 FROM operator_actions WHERE idempotency_key = ?`,
		)
			.bind(key)
			.first();
		expect(audit).toMatchObject({
			id: descriptor.actionId,
			action: "label-issue",
			actor_type: "human",
			actor_email: "reviewer@example.com",
			role: "reviewer",
			subject_uri: uri,
			subject_cid: null,
			label_value: "security-yanked",
		});

		// issuance_actions.idempotency_key === operator_actions.id === actionId.
		const linked = await testEnv.DB.prepare(
			`SELECT l.val, l.neg FROM issued_labels l
			 JOIN issuance_actions a ON a.id = l.action_id
			 WHERE a.idempotency_key = ?`,
		)
			.bind(descriptor.actionId)
			.first<{ val: string; neg: number }>();
		expect(linked).toEqual({ val: "security-yanked", neg: 0 });
	});

	it("returns a retryable 503 (not a phantom 200) when the label is suppressed after the audit commits", async () => {
		const uri = await seedReleaseSubject("phantom-suppressed");
		const key = nextKey();
		const body = {
			uri,
			val: "security-yanked",
			confirmation: "phantom-suppressed",
			reason: "rotation lands mid-issuance",
			idempotencyKey: key,
		};
		const response = await handleConsoleMutation(
			post("/admin/api/labels/issue", body),
			mutationDeps({ db: suppressIssuanceDb(testEnv.DB) }),
		);
		expect(response.status).toBe(503);
		expect((await bodyError(response)).code).toBe("LABEL_ISSUANCE_UNAVAILABLE");
		// The audit row committed (its INSERT is unguarded) but no label persisted —
		// the exact phantom state the post-commit verification rejects.
		expect(
			await countRows(`SELECT COUNT(*) n FROM operator_actions WHERE idempotency_key = ?`, key),
		).toBe(1);
		expect(await countRows(`SELECT COUNT(*) n FROM issued_labels WHERE uri = ?`, uri)).toBe(0);

		// A retry with the same idempotency key hits guardMutation's replay branch —
		// which would return the stored (success) descriptor. The replay path must run
		// the same persistence check and also 503, not a phantom 200. A plain db here:
		// the replay short-circuits before any batch, reading the committed audit row.
		const retry = await handleConsoleMutation(
			post("/admin/api/labels/issue", body),
			mutationDeps(),
		);
		expect(retry.status).toBe(503);
		expect((await bodyError(retry)).code).toBe("LABEL_ISSUANCE_UNAVAILABLE");
		// The replay wrote nothing: still no label, still exactly one audit row.
		expect(await countRows(`SELECT COUNT(*) n FROM issued_labels WHERE uri = ?`, uri)).toBe(0);
		expect(
			await countRows(`SELECT COUNT(*) n FROM operator_actions WHERE idempotency_key = ?`, key),
		).toBe(1);
	});

	it("writes no audit row when signing prep fails (no effect ⇒ no audit)", async () => {
		const uri = await seedReleaseSubject("atomicity-fail");
		const key = nextKey();
		const response = await handleConsoleMutation(
			post("/admin/api/labels/issue", {
				uri,
				val: "security-yanked",
				confirmation: "atomicity-fail",
				reason: "prep should fail",
				idempotencyKey: key,
			}),
			mutationDeps({
				createSigner: () =>
					Promise.resolve({
						issuerDid: LABELER_DID,
						sign: () => Promise.reject(new Error("signer unavailable")),
					}),
			}),
		);
		expect(response.status).toBe(500);
		expect(
			await countRows(`SELECT COUNT(*) n FROM operator_actions WHERE idempotency_key = ?`, key),
		).toBe(0);
	});
});

describe("console mutation: guard integration (representative)", () => {
	const body = {
		uri: releaseUri("guard"),
		val: "security-yanked",
		confirmation: "guard",
		reason: "guard test",
		idempotencyKey: "guard-key-000001",
	};

	it("rejects a missing CSRF header", async () => {
		const response = await handleConsoleMutation(
			post("/admin/api/labels/issue", body, { csrf: null }),
			mutationDeps(),
		);
		expect(response.status).toBe(403);
		expect((await bodyError(response)).code).toBe("CSRF_HEADER_MISSING");
	});

	it("rejects a non-JSON content type", async () => {
		const response = await handleConsoleMutation(
			post("/admin/api/labels/issue", body, { contentType: "text/plain" }),
			mutationDeps(),
		);
		expect(response.status).toBe(415);
	});

	it("rejects an unauthenticated request", async () => {
		const response = await handleConsoleMutation(
			post("/admin/api/labels/issue", body, { token: null }),
			mutationDeps(),
		);
		expect(response.status).toBe(401);
	});

	it("rejects a caller without the reviewer role", async () => {
		const response = await handleConsoleMutation(
			post("/admin/api/labels/issue", body, { token: noRoleToken }),
			mutationDeps(),
		);
		expect(response.status).toBe(403);
		expect((await bodyError(response)).code).toBe("FORBIDDEN_ROLE");
	});

	it("lets an admin satisfy the reviewer gate and records the inherited role", async () => {
		const uri = await seedReleaseSubject("admin-inherits");
		const response = await handleConsoleMutation(
			post(
				"/admin/api/labels/issue",
				{
					uri,
					val: "security-yanked",
					confirmation: "admin-inherits",
					reason: "admin acting as reviewer",
					idempotencyKey: nextKey(),
				},
				{ token: adminToken },
			),
			mutationDeps(),
		);
		expect(response.status).toBe(200);
		const audit = await testEnv.DB.prepare(
			`SELECT role, actor_email FROM operator_actions WHERE subject_uri = ? AND action = 'label-issue'`,
		)
			.bind(uri)
			.first<{ role: string; actor_email: string }>();
		expect(audit).toMatchObject({ role: "admin", actor_email: "admin@example.com" });
	});
});

describe("console mutation: vocabulary and scope", () => {
	async function issue(uri: string, val: string, confirmation: string, cid?: string) {
		return handleConsoleMutation(
			post("/admin/api/labels/issue", {
				uri,
				val,
				...(cid === undefined ? {} : { cid }),
				confirmation,
				reason: `issue ${val}`,
				idempotencyKey: nextKey(),
			}),
			mutationDeps(),
		);
	}

	it("rejects an automated-only label (assessment-pending)", async () => {
		const response = await issue(releaseUri("vocab-pending"), "assessment-pending", CID, CID);
		expect(response.status).toBe(400);
		expect((await bodyError(response)).code).toBe("INVALID_BODY");
	});

	it("rejects the override-coupled pair (assessment-passed)", async () => {
		const response = await issue(releaseUri("vocab-passed"), "assessment-passed", CID, CID);
		expect(response.status).toBe(400);
		expect((await bodyError(response)).code).toBe("INVALID_BODY");
	});

	it("rejects an admin-only label issued as reviewer (!takedown)", async () => {
		const response = await issue(releaseUri("vocab-takedown"), "!takedown", "vocab-takedown");
		expect(response.status).toBe(400);
	});

	it("rejects a CID on a cidRule:forbidden label (security-yanked)", async () => {
		const response = await issue(releaseUri("vocab-yank-cid"), "security-yanked", CID, CID);
		expect(response.status).toBe(400);
		expect((await bodyError(response)).code).toBe("INVALID_BODY");
	});

	it("accepts security-yanked URI-wide on a release", async () => {
		await seedReleaseSubject("vocab-yank-ok");
		const response = await issue(releaseUri("vocab-yank-ok"), "security-yanked", "vocab-yank-ok");
		expect(response.status).toBe(200);
	});

	it("accepts a reviewer-granted descriptive label (malware) CID-bound", async () => {
		await seedReleaseSubject("vocab-malware");
		const response = await issue(releaseUri("vocab-malware"), "malware", CID, CID);
		expect(response.status).toBe(200);
	});

	it("accepts package-disputed with and without a CID", async () => {
		const withCid = await issue(profileUri("vocab-disputed-a"), "package-disputed", CID, CID);
		expect(withCid.status).toBe(200);
		const withoutCid = await issue(
			profileUri("vocab-disputed-b"),
			"package-disputed",
			"vocab-disputed-b",
		);
		expect(withoutCid.status).toBe(200);
	});
});

describe("console mutation: confirmation", () => {
	it("rejects a CID-bound action whose confirmation is not the CID", async () => {
		await seedReleaseSubject("conf-cid");
		const response = await handleConsoleMutation(
			post("/admin/api/labels/issue", {
				uri: releaseUri("conf-cid"),
				val: "malware",
				cid: CID,
				confirmation: "not-the-cid",
				reason: "bad confirmation",
				idempotencyKey: nextKey(),
			}),
			mutationDeps(),
		);
		expect(response.status).toBe(400);
		expect((await bodyError(response)).code).toBe("CONFIRMATION_MISMATCH");
	});

	it("rejects a URI-wide action whose confirmation is not the rkey", async () => {
		await seedReleaseSubject("conf-rkey");
		const response = await handleConsoleMutation(
			post("/admin/api/labels/issue", {
				uri: releaseUri("conf-rkey"),
				val: "security-yanked",
				confirmation: "wrong-rkey",
				reason: "bad confirmation",
				idempotencyKey: nextKey(),
			}),
			mutationDeps(),
		);
		expect(response.status).toBe(400);
		expect((await bodyError(response)).code).toBe("CONFIRMATION_MISMATCH");
	});
});

describe("console mutation: retraction is negation", () => {
	it("records a negation and the stream winner becomes inactive", async () => {
		const uri = await seedReleaseSubject("retract-flow");
		const issued = await handleConsoleMutation(
			post("/admin/api/labels/issue", {
				uri,
				val: "security-yanked",
				confirmation: "retract-flow",
				reason: "yank it",
				idempotencyKey: nextKey(),
			}),
			mutationDeps(),
		);
		expect(issued.status).toBe(200);

		const retracted = await handleConsoleMutation(
			post("/admin/api/labels/retract", {
				uri,
				val: "security-yanked",
				confirmation: "retract-flow",
				reason: "false alarm",
				idempotencyKey: nextKey(),
			}),
			mutationDeps(),
		);
		expect(retracted.status).toBe(200);
		const descriptor = await bodyData<IssuedLabelDescriptor>(retracted);
		expect(descriptor.neg).toBe(true);

		expect(
			await countRows(
				`SELECT COUNT(*) n FROM issued_labels WHERE uri = ? AND val = 'security-yanked' AND neg = 1`,
				uri,
			),
		).toBe(1);

		const winners = await getActiveLabelState(testEnv.DB, { src: LABELER_DID, uri, cid: CID });
		expect(winners.get("security-yanked")?.active).toBe(false);
	});
});

describe("console mutation: replay and conflict", () => {
	it("returns the byte-identical stored descriptor on replay without a second write", async () => {
		const uri = await seedReleaseSubject("replay");
		const key = nextKey();
		const request = () =>
			post("/admin/api/labels/issue", {
				uri,
				val: "security-yanked",
				confirmation: "replay",
				reason: "first and replay",
				idempotencyKey: key,
			});
		const first = await handleConsoleMutation(request(), mutationDeps());
		const firstBody = await first.text();
		const second = await handleConsoleMutation(request(), mutationDeps());
		const secondBody = await second.text();
		expect(second.status).toBe(200);
		expect(secondBody).toBe(firstBody);
		expect(
			await countRows(
				`SELECT COUNT(*) n FROM issued_labels WHERE uri = ? AND val = 'security-yanked'`,
				uri,
			),
		).toBe(1);
	});

	it("returns 409 for the same key with a different fingerprint", async () => {
		const uri = await seedReleaseSubject("conflict");
		const key = nextKey();
		const first = await handleConsoleMutation(
			post("/admin/api/labels/issue", {
				uri,
				val: "security-yanked",
				confirmation: "conflict",
				reason: "original reason",
				idempotencyKey: key,
			}),
			mutationDeps(),
		);
		expect(first.status).toBe(200);
		const second = await handleConsoleMutation(
			post("/admin/api/labels/issue", {
				uri,
				val: "security-yanked",
				confirmation: "conflict",
				reason: "different reason",
				idempotencyKey: key,
			}),
			mutationDeps(),
		);
		expect(second.status).toBe(409);
		expect((await bodyError(second)).code).toBe("IDEMPOTENCY_KEY_CONFLICT");
	});
});

describe("console reads: whoami", () => {
	it("returns the caller kind, principal, and roles", async () => {
		const response = await handleConsoleApi(getReq("/admin/api/whoami"), readDeps());
		expect(response.status).toBe(200);
		const data = await bodyData<{ kind: string; principal: string; roles: string[] }>(response);
		expect(data).toMatchObject({
			kind: "human",
			principal: "reviewer@example.com",
			roles: ["reviewer"],
		});
	});

	it("reports admin roles for an admin caller", async () => {
		const response = await handleConsoleApi(getReq("/admin/api/whoami", adminToken), readDeps());
		const data = await bodyData<{ roles: string[] }>(response);
		expect(data.roles).toEqual(["admin"]);
	});
});

describe("console reads: effect preview", () => {
	async function preview(uri: string, val: string, cid?: string, neg = false) {
		const search = new URLSearchParams({ uri, val });
		if (cid) search.set("cid", cid);
		if (neg) search.set("neg", "true");
		const response = await handleConsoleApi(
			getReq(`/admin/api/labels/effect-preview?${search.toString()}`),
			readDeps(),
		);
		return response;
	}

	it("grounds before/after in the aggregator evaluator for a blocked release", async () => {
		const uri = await seedReleaseSubject("preview-block");
		await issueManualLabel(
			testEnv.DB,
			CONFIG,
			await testSigner(),
			{
				actor: LABELER_DID,
				type: "manual-label",
				reason: "seed block",
				idempotencyKey: nextKey(),
			},
			{ uri, val: "malware", cid: CID },
			new Date("2026-07-08T09:00:00.000Z"),
		);

		const response = await preview(uri, "security-yanked");
		expect(response.status).toBe(200);
		const data = await bodyData<{
			labelEffect: string;
			scope: string;
			before: { eligibility: string; blockingLabels: string[] } | null;
			after: { eligibility: string; blockingLabels: string[] } | null;
		}>(response);
		expect(data.labelEffect).toBe("block");
		expect(data.scope).toBe("uri-wide");
		expect(data.before?.eligibility).toBe("blocked");
		expect(data.before?.blockingLabels).toContain("malware");
		expect(data.after?.blockingLabels).toContain("security-yanked");

		// No drift: the endpoint's `after` matches a direct evaluator call over the
		// overlaid label set (comparing effect fields, not cts-bearing labels).
		const activeMalware: ModerationLabel = {
			ver: 1,
			src: LABELER_DID,
			uri,
			cid: CID,
			val: "malware",
			cts: "2026-07-08T09:00:00.000Z",
		};
		const overlay: ModerationLabel = {
			ver: 1,
			src: LABELER_DID,
			uri,
			val: "security-yanked",
			cts: "2026-07-10T00:00:00.000Z",
		};
		const direct = evaluateHydratedReleaseModeration({
			acceptedLabelers: [{ did: LABELER_DID, redact: false }],
			context: {
				publisherDid: PUBLISHER_DID,
				package: { uri, cid: CID },
				release: { uri, cid: CID },
			},
			evaluatedAt: new Date(),
			labels: [activeMalware, overlay],
		});
		expect(data.after?.eligibility).toBe(direct.eligibility);
		expect(data.after?.blockingLabels).toEqual(direct.blockingLabels);
	});

	it("shows a retract returning the release toward eligible", async () => {
		const uri = await seedReleaseSubject("preview-retract", CID_2);
		const base = new Date("2026-07-08T09:00:00.000Z");
		await issueManualLabel(
			testEnv.DB,
			CONFIG,
			await testSigner(),
			{ actor: LABELER_DID, type: "manual-label", reason: "seed pass", idempotencyKey: nextKey() },
			{ uri, val: "assessment-passed", cid: CID_2 },
			base,
		);
		await issueManualLabel(
			testEnv.DB,
			CONFIG,
			await testSigner(),
			{ actor: LABELER_DID, type: "manual-label", reason: "seed block", idempotencyKey: nextKey() },
			{ uri, val: "malware", cid: CID_2 },
			new Date("2026-07-08T09:05:00.000Z"),
		);

		const blocked = await bodyData<{ before: { eligibility: string } | null }>(
			await preview(uri, "malware", CID_2),
		);
		expect(blocked.before?.eligibility).toBe("blocked");

		const retract = await bodyData<{ after: { eligibility: string } | null }>(
			await preview(uri, "malware", CID_2, true),
		);
		expect(retract.after?.eligibility).toBe("eligible");
	});

	it("rejects an unknown label value", async () => {
		const response = await preview(releaseUri("preview-unknown"), "not-a-label");
		expect(response.status).toBe(400);
	});
});
