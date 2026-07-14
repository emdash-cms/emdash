import {
	createLabelSigner,
	evaluateHydratedReleaseModeration,
	type LabelDidDocument,
	type ModerationLabel,
} from "@emdash-cms/registry-moderation";
import { applyD1Migrations, env } from "cloudflare:test";
import { generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import type { AccessKeyResolver } from "../src/access-auth.js";
import { computeRunKey, initialTriggerId } from "../src/assessment-lifecycle.js";
import {
	createAssessmentRun,
	createSubject,
	getActiveLabelState,
} from "../src/assessment-store.js";
import { handleConsoleApi, type ConsoleApiDeps } from "../src/console-api.js";
import {
	handleConsoleMutation,
	type ConsoleMutationDeps,
	type IssuedLabelDescriptor,
} from "../src/console-mutation-api.js";
import {
	processDiscoveryMessage,
	type DiscoveryConsumerDeps,
	type MessageController,
} from "../src/discovery-consumer.js";
import type { DiscoveryJob } from "../src/env.js";
import { OPERATOR_REQUEST_HEADER } from "../src/mutation-guard.js";
import type { DidDocumentResolverLike } from "../src/record-verification.js";
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

// ─── W9.6: admin-only emergency actions ─────────────────────────────────────

const PUBLISHER_SEGMENT = PUBLISHER_DID.split(":").at(-1)!;

/** Seeds a real automated `malware` block (via an assessment, satisfying the
 * `issuance_actions.assessment_id` FK) so a takedown/retract test rests on a
 * genuine automated block, not a hand-inserted row. */
async function seedAutomatedBlock(uri: string, cid: string): Promise<void> {
	await createSubject(testEnv.DB, {
		uri,
		cid,
		did: PUBLISHER_DID,
		collection: "com.emdashcms.experimental.package.release",
		rkey: uri.split("/").at(-1)!,
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
	});
	await issueAutomatedAssessmentLabel(
		testEnv.DB,
		CONFIG,
		await testSigner(),
		{
			actor: LABELER_DID,
			type: "automated-assessment",
			assessmentId: assessment.id,
			reason: "automated block",
			idempotencyKey: nextKey(),
		},
		{ uri, cid, val: "malware", findingCategory: "malware", severity: "critical" },
		new Date("2026-07-08T09:00:00.000Z"),
	);
}

/** Reads the issued labels for a URI as evaluator input, newest last — the
 * grounded label set the aggregator evaluator reduces (sigs are irrelevant to
 * label semantics). */
async function moderationLabelsFor(uri: string): Promise<ModerationLabel[]> {
	const rows = await testEnv.DB.prepare(
		`SELECT src, uri, cid, val, neg, cts FROM issued_labels WHERE uri = ? ORDER BY sequence ASC`,
	)
		.bind(uri)
		.all<{ src: string; uri: string; cid: string | null; val: string; neg: number; cts: string }>();
	return (rows.results ?? []).map((row) => ({
		ver: 1,
		src: row.src,
		uri: row.uri,
		...(row.cid === null ? {} : { cid: row.cid }),
		val: row.val,
		...(row.neg === 1 ? { neg: true } : {}),
		cts: row.cts,
	}));
}

async function eventCount(actionId: string): Promise<number> {
	return countRows(`SELECT COUNT(*) n FROM operational_events WHERE action_id = ?`, actionId);
}

async function outboxCount(actionId: string): Promise<number> {
	return countRows(
		`SELECT COUNT(*) n FROM notification_outbox nob
		 JOIN operational_events oe ON oe.id = nob.event_id
		 WHERE oe.action_id = ?`,
		actionId,
	);
}

async function globalCounts(): Promise<Record<string, number>> {
	return {
		actions: await countRows(`SELECT COUNT(*) n FROM operator_actions`),
		labels: await countRows(`SELECT COUNT(*) n FROM issued_labels`),
		events: await countRows(`SELECT COUNT(*) n FROM operational_events`),
		outbox: await countRows(`SELECT COUNT(*) n FROM notification_outbox`),
	};
}

function emergency(
	path: string,
	body: Record<string, unknown>,
	token: string | null = adminToken,
): Request {
	return post(path, { reason: "incident response", idempotencyKey: nextKey(), ...body }, { token });
}

describe("console mutation: emergency issuance (admin)", () => {
	it("issues !takedown URI-wide on a release with the atomic event + outbox", async () => {
		const uri = await seedReleaseSubject("emrg-td-release");
		const response = await handleConsoleMutation(
			emergency("/admin/api/emergency/takedown", {
				uri,
				subjectConfirmation: "emrg-td-release",
				intent: "CONFIRM TAKEDOWN",
			}),
			mutationDeps(),
		);
		expect(response.status).toBe(200);
		const descriptor = await bodyData<IssuedLabelDescriptor>(response);
		expect(descriptor).toMatchObject({
			val: "!takedown",
			uri,
			cid: null,
			neg: false,
			effect: "redact",
		});

		expect(
			await countRows(
				`SELECT COUNT(*) n FROM issued_labels WHERE uri = ? AND val = '!takedown' AND neg = 0`,
				uri,
			),
		).toBe(1);
		expect(
			await countRows(
				`SELECT COUNT(*) n FROM operational_events
				 WHERE action_id = ? AND event_type = 'emergency-takedown' AND severity = 'critical'`,
				descriptor.actionId,
			),
		).toBe(1);
		expect(await outboxCount(descriptor.actionId)).toBe(1);

		// T8: the alert payload carries the operator reason only — no evidence fields.
		const event = await testEnv.DB.prepare(
			`SELECT payload_json, subject_uri, label_value FROM operational_events WHERE action_id = ?`,
		)
			.bind(descriptor.actionId)
			.first<{ payload_json: string; subject_uri: string; label_value: string }>();
		expect(event).toMatchObject({ subject_uri: uri, label_value: "!takedown" });
		expect(JSON.parse(event!.payload_json)).toEqual({ reason: "incident response" });
	});

	it("issues !takedown on a package profile (rkey confirmation)", async () => {
		const response = await handleConsoleMutation(
			emergency("/admin/api/emergency/takedown", {
				uri: profileUri("emrg-td-pkg"),
				subjectConfirmation: "emrg-td-pkg",
				intent: "CONFIRM TAKEDOWN",
			}),
			mutationDeps(),
		);
		expect(response.status).toBe(200);
		expect((await bodyData<IssuedLabelDescriptor>(response)).val).toBe("!takedown");
	});

	it("issues !takedown on a publisher DID (final-segment confirmation)", async () => {
		const response = await handleConsoleMutation(
			emergency("/admin/api/emergency/takedown", {
				uri: PUBLISHER_DID,
				subjectConfirmation: PUBLISHER_SEGMENT,
				intent: "CONFIRM TAKEDOWN",
			}),
			mutationDeps(),
		);
		expect(response.status).toBe(200);
		expect((await bodyData<IssuedLabelDescriptor>(response)).uri).toBe(PUBLISHER_DID);
	});

	it("issues publisher-compromised on a publisher DID", async () => {
		const response = await handleConsoleMutation(
			emergency("/admin/api/emergency/publisher-compromised", {
				uri: PUBLISHER_DID,
				subjectConfirmation: PUBLISHER_SEGMENT,
				intent: "CONFIRM COMPROMISE",
			}),
			mutationDeps(),
		);
		expect(response.status).toBe(200);
		const descriptor = await bodyData<IssuedLabelDescriptor>(response);
		expect(descriptor).toMatchObject({
			val: "publisher-compromised",
			uri: PUBLISHER_DID,
			neg: false,
		});
		expect(
			await countRows(
				`SELECT COUNT(*) n FROM operational_events
				 WHERE action_id = ? AND event_type = 'publisher-compromised' AND severity = 'critical'`,
				descriptor.actionId,
			),
		).toBe(1);
	});

	it("rejects publisher-compromised targeting a release (no admin rule for that subject)", async () => {
		const response = await handleConsoleMutation(
			emergency("/admin/api/emergency/publisher-compromised", {
				uri: releaseUri("emrg-pc-release"),
				subjectConfirmation: "emrg-pc-release",
				intent: "CONFIRM COMPROMISE",
			}),
			mutationDeps(),
		);
		expect(response.status).toBe(400);
		expect((await bodyError(response)).code).toBe("INVALID_BODY");
	});
});

describe("console mutation: emergency authorization (per-endpoint, pre-effect)", () => {
	const cases = [
		{
			path: "/admin/api/emergency/takedown",
			uri: () => PUBLISHER_DID,
			conf: PUBLISHER_SEGMENT,
			intent: "CONFIRM TAKEDOWN",
		},
		{
			path: "/admin/api/emergency/takedown-retract",
			uri: () => PUBLISHER_DID,
			conf: PUBLISHER_SEGMENT,
			intent: "CONFIRM RETRACT",
		},
		{
			path: "/admin/api/emergency/publisher-compromised",
			uri: () => PUBLISHER_DID,
			conf: PUBLISHER_SEGMENT,
			intent: "CONFIRM COMPROMISE",
		},
		{
			path: "/admin/api/emergency/publisher-compromised-retract",
			uri: () => PUBLISHER_DID,
			conf: PUBLISHER_SEGMENT,
			intent: "CONFIRM RETRACT",
		},
	];

	it.each(cases)(
		"rejects a reviewer with zero side effects: $path",
		async ({ path, uri, conf, intent }) => {
			const before = {
				actions: await countRows(`SELECT COUNT(*) n FROM operator_actions`),
				labels: await countRows(`SELECT COUNT(*) n FROM issued_labels`),
				events: await countRows(`SELECT COUNT(*) n FROM operational_events`),
				outbox: await countRows(`SELECT COUNT(*) n FROM notification_outbox`),
			};
			const response = await handleConsoleMutation(
				emergency(path, { uri: uri(), subjectConfirmation: conf, intent }, reviewerToken),
				mutationDeps(),
			);
			expect(response.status).toBe(403);
			expect((await bodyError(response)).code).toBe("FORBIDDEN_ROLE");
			expect(await countRows(`SELECT COUNT(*) n FROM operator_actions`)).toBe(before.actions);
			expect(await countRows(`SELECT COUNT(*) n FROM issued_labels`)).toBe(before.labels);
			expect(await countRows(`SELECT COUNT(*) n FROM operational_events`)).toBe(before.events);
			expect(await countRows(`SELECT COUNT(*) n FROM notification_outbox`)).toBe(before.outbox);
		},
	);

	it.each(cases)(
		"accepts an admin (the 403 is the role, not a broken endpoint): $path",
		async ({ path, uri, conf, intent }) => {
			const response = await handleConsoleMutation(
				emergency(path, { uri: uri(), subjectConfirmation: conf, intent }, adminToken),
				mutationDeps(),
			);
			expect(response.status).toBe(200);
		},
	);

	it("rejects an unauthenticated caller with zero side effects (401)", async () => {
		const before = {
			actions: await countRows(`SELECT COUNT(*) n FROM operator_actions`),
			labels: await countRows(`SELECT COUNT(*) n FROM issued_labels`),
			events: await countRows(`SELECT COUNT(*) n FROM operational_events`),
			outbox: await countRows(`SELECT COUNT(*) n FROM notification_outbox`),
		};
		const response = await handleConsoleMutation(
			emergency(
				"/admin/api/emergency/takedown",
				{ uri: PUBLISHER_DID, subjectConfirmation: PUBLISHER_SEGMENT, intent: "CONFIRM TAKEDOWN" },
				null,
			),
			mutationDeps(),
		);
		expect(response.status).toBe(401);
		expect(await countRows(`SELECT COUNT(*) n FROM operator_actions`)).toBe(before.actions);
		expect(await countRows(`SELECT COUNT(*) n FROM issued_labels`)).toBe(before.labels);
		expect(await countRows(`SELECT COUNT(*) n FROM operational_events`)).toBe(before.events);
		expect(await countRows(`SELECT COUNT(*) n FROM notification_outbox`)).toBe(before.outbox);
	});
});

describe("console mutation: emergency ceremony", () => {
	it("rejects a wrong subject confirmation without echoing the typed value (400)", async () => {
		const response = await handleConsoleMutation(
			emergency("/admin/api/emergency/takedown", {
				uri: releaseUri("emrg-conf"),
				subjectConfirmation: "not-the-rkey",
				intent: "CONFIRM TAKEDOWN",
			}),
			mutationDeps(),
		);
		expect(response.status).toBe(400);
		const error = await bodyError(response);
		expect(error.code).toBe("CONFIRMATION_MISMATCH");
		expect(error.message).not.toContain("not-the-rkey");
	});

	it("rejects a wrong intent phrase (400)", async () => {
		const response = await handleConsoleMutation(
			emergency("/admin/api/emergency/takedown", {
				uri: releaseUri("emrg-intent"),
				subjectConfirmation: "emrg-intent",
				intent: "CONFIRM COMPROMISE",
			}),
			mutationDeps(),
		);
		expect(response.status).toBe(400);
		expect((await bodyError(response)).code).toBe("CONFIRMATION_MISMATCH");
	});

	it("rejects a missing intent (400)", async () => {
		const response = await handleConsoleMutation(
			post(
				"/admin/api/emergency/takedown",
				{
					uri: releaseUri("emrg-nointent"),
					subjectConfirmation: "emrg-nointent",
					reason: "no intent",
					idempotencyKey: nextKey(),
				},
				{ token: adminToken },
			),
			mutationDeps(),
		);
		expect(response.status).toBe(400);
	});

	it("rejects the issue intent on a retract endpoint (400)", async () => {
		const response = await handleConsoleMutation(
			emergency("/admin/api/emergency/takedown-retract", {
				uri: PUBLISHER_DID,
				subjectConfirmation: PUBLISHER_SEGMENT,
				intent: "CONFIRM TAKEDOWN",
			}),
			mutationDeps(),
		);
		expect(response.status).toBe(400);
		expect((await bodyError(response)).code).toBe("CONFIRMATION_MISMATCH");
	});

	it("T7: a release URI confirmed with a DID segment fails (subject-kind confusion)", async () => {
		const response = await handleConsoleMutation(
			emergency("/admin/api/emergency/takedown", {
				uri: releaseUri("emrg-t7"),
				subjectConfirmation: PUBLISHER_SEGMENT,
				intent: "CONFIRM TAKEDOWN",
			}),
			mutationDeps(),
		);
		expect(response.status).toBe(400);
		expect((await bodyError(response)).code).toBe("CONFIRMATION_MISMATCH");
	});
});

describe("console mutation: emergency replay and phantom success", () => {
	it("emits exactly one operational event + outbox row across a replay", async () => {
		const uri = await seedReleaseSubject("emrg-replay");
		const key = nextKey();
		const request = () =>
			post(
				"/admin/api/emergency/takedown",
				{
					uri,
					subjectConfirmation: "emrg-replay",
					intent: "CONFIRM TAKEDOWN",
					reason: "replay incident",
					idempotencyKey: key,
				},
				{ token: adminToken },
			);
		const first = await handleConsoleMutation(request(), mutationDeps());
		const firstBody = await first.text();
		const second = await handleConsoleMutation(request(), mutationDeps());
		expect(second.status).toBe(200);
		expect(await second.text()).toBe(firstBody);

		const descriptor = JSON.parse(firstBody).data as IssuedLabelDescriptor;
		expect(await eventCount(descriptor.actionId)).toBe(1);
		expect(await outboxCount(descriptor.actionId)).toBe(1);
		expect(
			await countRows(
				`SELECT COUNT(*) n FROM issued_labels WHERE uri = ? AND val = '!takedown'`,
				uri,
			),
		).toBe(1);
	});

	it("503s with no label, event, or outbox when the batch is suppressed, and re-503s on replay (T1)", async () => {
		const uri = await seedReleaseSubject("emrg-phantom");
		const key = nextKey();
		const body = {
			uri,
			subjectConfirmation: "emrg-phantom",
			intent: "CONFIRM TAKEDOWN",
			reason: "rotation mid-issuance",
			idempotencyKey: key,
		};
		const response = await handleConsoleMutation(
			post("/admin/api/emergency/takedown", body, { token: adminToken }),
			mutationDeps({ db: suppressIssuanceDb(testEnv.DB) }),
		);
		expect(response.status).toBe(503);
		expect((await bodyError(response)).code).toBe("LABEL_ISSUANCE_UNAVAILABLE");
		expect(
			await countRows(`SELECT COUNT(*) n FROM operator_actions WHERE idempotency_key = ?`, key),
		).toBe(1);
		expect(await countRows(`SELECT COUNT(*) n FROM issued_labels WHERE uri = ?`, uri)).toBe(0);
		expect(
			await countRows(`SELECT COUNT(*) n FROM operational_events WHERE subject_uri = ?`, uri),
		).toBe(0);

		const outboxBefore = await countRows(`SELECT COUNT(*) n FROM notification_outbox`);
		const retry = await handleConsoleMutation(
			post("/admin/api/emergency/takedown", body, { token: adminToken }),
			mutationDeps(),
		);
		expect(retry.status).toBe(503);
		expect((await bodyError(retry)).code).toBe("LABEL_ISSUANCE_UNAVAILABLE");
		expect(await countRows(`SELECT COUNT(*) n FROM issued_labels WHERE uri = ?`, uri)).toBe(0);
		expect(
			await countRows(`SELECT COUNT(*) n FROM operational_events WHERE subject_uri = ?`, uri),
		).toBe(0);
		expect(await countRows(`SELECT COUNT(*) n FROM notification_outbox`)).toBe(outboxBefore);
	});
});

describe("console mutation: emergency retract resting state", () => {
	it("re-exposes pre-takedown automated blocks and re-issues nothing (evaluator agrees)", async () => {
		const uri = releaseUri("emrg-rest");
		await seedAutomatedBlock(uri, CID);

		const takedown = await handleConsoleMutation(
			emergency("/admin/api/emergency/takedown", {
				uri,
				subjectConfirmation: "emrg-rest",
				intent: "CONFIRM TAKEDOWN",
			}),
			mutationDeps(),
		);
		expect(takedown.status).toBe(200);

		const redacted = evaluateHydratedReleaseModeration({
			acceptedLabelers: [{ did: LABELER_DID, redact: true }],
			context: {
				publisherDid: PUBLISHER_DID,
				package: { uri, cid: CID },
				release: { uri, cid: CID },
			},
			evaluatedAt: new Date(),
			labels: await moderationLabelsFor(uri),
		});
		expect(redacted.redacted).toBe(true);

		const retract = await handleConsoleMutation(
			emergency("/admin/api/emergency/takedown-retract", {
				uri,
				subjectConfirmation: "emrg-rest",
				intent: "CONFIRM RETRACT",
			}),
			mutationDeps(),
		);
		expect(retract.status).toBe(200);
		expect((await bodyData<IssuedLabelDescriptor>(retract)).neg).toBe(true);

		// Resting state: the takedown is inactive, the automated malware block is
		// active again (it was never negated), and nothing was re-issued for it.
		const winners = await getActiveLabelState(testEnv.DB, { src: LABELER_DID, uri, cid: CID });
		expect(winners.get("!takedown")?.active).toBe(false);
		expect(winners.get("malware")?.active).toBe(true);
		expect(
			await countRows(
				`SELECT COUNT(*) n FROM issued_labels WHERE uri = ? AND val = 'malware'`,
				uri,
			),
		).toBe(1);

		const atRest = evaluateHydratedReleaseModeration({
			acceptedLabelers: [{ did: LABELER_DID, redact: true }],
			context: {
				publisherDid: PUBLISHER_DID,
				package: { uri, cid: CID },
				release: { uri, cid: CID },
			},
			evaluatedAt: new Date(),
			labels: await moderationLabelsFor(uri),
		});
		expect(atRest.redacted).toBe(false);
		expect(atRest.eligibility).toBe("blocked");
		expect(atRest.blockingLabels).toContain("malware");
	});

	it("emits a high-severity operational event for a retract", async () => {
		const uri = await seedReleaseSubject("emrg-retract-event");
		const issued = await handleConsoleMutation(
			emergency("/admin/api/emergency/takedown", {
				uri,
				subjectConfirmation: "emrg-retract-event",
				intent: "CONFIRM TAKEDOWN",
			}),
			mutationDeps(),
		);
		expect(issued.status).toBe(200);

		const response = await handleConsoleMutation(
			emergency("/admin/api/emergency/takedown-retract", {
				uri,
				subjectConfirmation: "emrg-retract-event",
				intent: "CONFIRM RETRACT",
			}),
			mutationDeps(),
		);
		expect(response.status).toBe(200);
		const descriptor = await bodyData<IssuedLabelDescriptor>(response);
		expect(
			await countRows(
				`SELECT COUNT(*) n FROM operational_events WHERE action_id = ? AND severity = 'high'`,
				descriptor.actionId,
			),
		).toBe(1);
	});
});

describe("console mutation: emergency retract guard", () => {
	const FRESH_DID = "did:plc:nocompromise00000000000000";
	const FRESH_DID_SEGMENT = FRESH_DID.split(":").at(-1)!;

	it("retracts an active takedown: negation lands, event emitted (200)", async () => {
		const uri = await seedReleaseSubject("guard-active-td");
		const issued = await handleConsoleMutation(
			emergency("/admin/api/emergency/takedown", {
				uri,
				subjectConfirmation: "guard-active-td",
				intent: "CONFIRM TAKEDOWN",
			}),
			mutationDeps(),
		);
		expect(issued.status).toBe(200);

		const retract = await handleConsoleMutation(
			emergency("/admin/api/emergency/takedown-retract", {
				uri,
				subjectConfirmation: "guard-active-td",
				intent: "CONFIRM RETRACT",
			}),
			mutationDeps(),
		);
		expect(retract.status).toBe(200);
		const descriptor = await bodyData<IssuedLabelDescriptor>(retract);
		expect(descriptor.neg).toBe(true);

		const winners = await getActiveLabelState(testEnv.DB, { src: LABELER_DID, uri, cid: CID });
		expect(winners.get("!takedown")?.active).toBe(false);
		expect(await eventCount(descriptor.actionId)).toBe(1);
	});

	it("retracts an active takedown on a package subject (200)", async () => {
		const uri = profileUri("guard-active-td-pkg");
		const issued = await handleConsoleMutation(
			emergency("/admin/api/emergency/takedown", {
				uri,
				subjectConfirmation: "guard-active-td-pkg",
				intent: "CONFIRM TAKEDOWN",
			}),
			mutationDeps(),
		);
		expect(issued.status).toBe(200);

		const retract = await handleConsoleMutation(
			emergency("/admin/api/emergency/takedown-retract", {
				uri,
				subjectConfirmation: "guard-active-td-pkg",
				intent: "CONFIRM RETRACT",
			}),
			mutationDeps(),
		);
		expect(retract.status).toBe(200);
		expect((await bodyData<IssuedLabelDescriptor>(retract)).neg).toBe(true);
		const winners = await getActiveLabelState(testEnv.DB, { src: LABELER_DID, uri, cid: "" });
		expect(winners.get("!takedown")?.active).toBe(false);
	});

	it("retracts an active takedown on a publisher subject (200)", async () => {
		const uri = "did:plc:guardtdpublisher00000000000";
		const issued = await handleConsoleMutation(
			emergency("/admin/api/emergency/takedown", {
				uri,
				subjectConfirmation: uri.split(":").at(-1)!,
				intent: "CONFIRM TAKEDOWN",
			}),
			mutationDeps(),
		);
		expect(issued.status).toBe(200);

		const retract = await handleConsoleMutation(
			emergency("/admin/api/emergency/takedown-retract", {
				uri,
				subjectConfirmation: uri.split(":").at(-1)!,
				intent: "CONFIRM RETRACT",
			}),
			mutationDeps(),
		);
		expect(retract.status).toBe(200);
		expect((await bodyData<IssuedLabelDescriptor>(retract)).neg).toBe(true);
		const winners = await getActiveLabelState(testEnv.DB, { src: LABELER_DID, uri, cid: "" });
		expect(winners.get("!takedown")?.active).toBe(false);
	});

	it("retracts an active publisher-compromised on a publisher (200)", async () => {
		const uri = "did:plc:guardpccompromised000000000";
		const issued = await handleConsoleMutation(
			emergency("/admin/api/emergency/publisher-compromised", {
				uri,
				subjectConfirmation: uri.split(":").at(-1)!,
				intent: "CONFIRM COMPROMISE",
			}),
			mutationDeps(),
		);
		expect(issued.status).toBe(200);

		const retract = await handleConsoleMutation(
			emergency("/admin/api/emergency/publisher-compromised-retract", {
				uri,
				subjectConfirmation: uri.split(":").at(-1)!,
				intent: "CONFIRM RETRACT",
			}),
			mutationDeps(),
		);
		expect(retract.status).toBe(200);
		expect((await bodyData<IssuedLabelDescriptor>(retract)).neg).toBe(true);
		const winners = await getActiveLabelState(testEnv.DB, { src: LABELER_DID, uri, cid: "" });
		expect(winners.get("publisher-compromised")?.active).toBe(false);
	});

	it("rejects a takedown-retract with no active takedown (404, zero side effects)", async () => {
		const uri = await seedReleaseSubject("guard-no-td");
		const before = await globalCounts();
		const response = await handleConsoleMutation(
			emergency("/admin/api/emergency/takedown-retract", {
				uri,
				subjectConfirmation: "guard-no-td",
				intent: "CONFIRM RETRACT",
			}),
			mutationDeps(),
		);
		expect(response.status).toBe(404);
		expect((await bodyError(response)).code).toBe("NO_ACTIVE_LABEL");
		expect(await globalCounts()).toEqual(before);
	});

	it("rejects a publisher-compromised-retract with no active label (404, zero side effects)", async () => {
		const before = await globalCounts();
		const response = await handleConsoleMutation(
			emergency("/admin/api/emergency/publisher-compromised-retract", {
				uri: FRESH_DID,
				subjectConfirmation: FRESH_DID_SEGMENT,
				intent: "CONFIRM RETRACT",
			}),
			mutationDeps(),
		);
		expect(response.status).toBe(404);
		expect((await bodyError(response)).code).toBe("NO_ACTIVE_LABEL");
		expect(await globalCounts()).toEqual(before);
	});

	it("rejects retracting an already-retracted takedown (404, zero side effects)", async () => {
		const uri = await seedReleaseSubject("guard-double-retract");
		const issued = await handleConsoleMutation(
			emergency("/admin/api/emergency/takedown", {
				uri,
				subjectConfirmation: "guard-double-retract",
				intent: "CONFIRM TAKEDOWN",
			}),
			mutationDeps(),
		);
		expect(issued.status).toBe(200);
		const firstRetract = await handleConsoleMutation(
			emergency("/admin/api/emergency/takedown-retract", {
				uri,
				subjectConfirmation: "guard-double-retract",
				intent: "CONFIRM RETRACT",
			}),
			mutationDeps(),
		);
		expect(firstRetract.status).toBe(200);

		const before = await globalCounts();
		const secondRetract = await handleConsoleMutation(
			emergency("/admin/api/emergency/takedown-retract", {
				uri,
				subjectConfirmation: "guard-double-retract",
				intent: "CONFIRM RETRACT",
			}),
			mutationDeps(),
		);
		expect(secondRetract.status).toBe(404);
		expect((await bodyError(secondRetract)).code).toBe("NO_ACTIVE_LABEL");
		expect(await globalCounts()).toEqual(before);
	});

	it("keeps the role and ceremony rejections ahead of the retract guard", async () => {
		const uri = await seedReleaseSubject("guard-order");
		// Reviewer role gate (403) precedes the retract guard even with nothing active.
		const roleDenied = await handleConsoleMutation(
			emergency(
				"/admin/api/emergency/takedown-retract",
				{ uri, subjectConfirmation: "guard-order", intent: "CONFIRM RETRACT" },
				reviewerToken,
			),
			mutationDeps(),
		);
		expect(roleDenied.status).toBe(403);
		expect((await bodyError(roleDenied)).code).toBe("FORBIDDEN_ROLE");

		// Admin with a wrong intent: the ceremony gate (400) precedes the retract guard.
		const ceremonyDenied = await handleConsoleMutation(
			emergency("/admin/api/emergency/takedown-retract", {
				uri,
				subjectConfirmation: "guard-order",
				intent: "CONFIRM TAKEDOWN",
			}),
			mutationDeps(),
		);
		expect(ceremonyDenied.status).toBe(400);
		expect((await bodyError(ceremonyDenied)).code).toBe("CONFIRMATION_MISMATCH");
	});
});

describe("console mutation: emergency §10 automation interaction", () => {
	it("automation cannot negate an admin-issued !takedown", async () => {
		const uri = await seedReleaseSubject("emrg-s10");
		const takedown = await handleConsoleMutation(
			emergency("/admin/api/emergency/takedown", {
				uri,
				subjectConfirmation: "emrg-s10",
				intent: "CONFIRM TAKEDOWN",
			}),
			mutationDeps(),
		);
		expect(takedown.status).toBe(200);

		// The automated issuance path refuses the emergency vocabulary outright, so
		// automation can never reach — let alone negate — a manually-headed takedown.
		await expect(
			issueAutomatedAssessmentLabel(
				testEnv.DB,
				CONFIG,
				await testSigner(),
				{
					actor: LABELER_DID,
					type: "automated-assessment",
					assessmentId: `asmt_${"0".repeat(26)}`,
					reason: "automated negation attempt",
					idempotencyKey: nextKey(),
				},
				{ uri, cid: CID, val: "!takedown", neg: true },
			),
		).rejects.toThrow();

		const winners = await getActiveLabelState(testEnv.DB, { src: LABELER_DID, uri, cid: CID });
		expect(winners.get("!takedown")?.active).toBe(true);
	});
});

// ─── W9.6: admin-only automation kill-switch (pause/resume) ──────────────────

function automation(
	path: string,
	token: string | null = adminToken,
	body: Record<string, unknown> = {},
): Request {
	return post(path, { reason: "incident response", idempotencyKey: nextKey(), ...body }, { token });
}

async function automationRow(): Promise<{ paused: number; reason: string | null } | null> {
	return testEnv.DB.prepare(
		`SELECT paused, paused_reason AS reason FROM automation_state WHERE id = 1`,
	).first<{ paused: number; reason: string | null }>();
}

async function resetAutomation(): Promise<void> {
	await testEnv.DB.prepare(
		`UPDATE automation_state SET paused = 0, paused_reason = NULL WHERE id = 1`,
	).run();
}

interface AutomationToggleDescriptor {
	actionId: string;
	paused: boolean;
	reason: string;
	cts: string;
}

describe("console mutation: automation pause/resume (admin)", () => {
	afterEach(resetAutomation);

	it("pause flips the switch and emits one automation-paused event + audit row", async () => {
		const response = await handleConsoleMutation(
			automation("/admin/api/automation/pause"),
			mutationDeps(),
		);
		expect(response.status).toBe(200);
		const descriptor = await bodyData<AutomationToggleDescriptor>(response);
		expect(descriptor).toMatchObject({ paused: true, reason: "incident response" });

		const row = await automationRow();
		expect(row?.paused).toBe(1);
		expect(row?.reason).toBe("incident response");
		expect(
			await countRows(
				`SELECT COUNT(*) n FROM operator_actions WHERE id = ? AND action = 'pause-issuance'`,
				descriptor.actionId,
			),
		).toBe(1);
		expect(
			await countRows(
				`SELECT COUNT(*) n FROM operational_events
				 WHERE action_id = ? AND event_type = 'automation-paused' AND severity = 'high'`,
				descriptor.actionId,
			),
		).toBe(1);
		// Pause issues no label and queues no delivery row.
		expect(await outboxCount(descriptor.actionId)).toBe(0);

		// T8: the event carries the operator reason only, with no subject or label.
		const event = await testEnv.DB.prepare(
			`SELECT payload_json, subject_uri, label_value FROM operational_events WHERE action_id = ?`,
		)
			.bind(descriptor.actionId)
			.first<{ payload_json: string; subject_uri: string | null; label_value: string | null }>();
		expect(event).toMatchObject({ subject_uri: null, label_value: null });
		expect(JSON.parse(event!.payload_json)).toEqual({ reason: "incident response" });
	});

	it("resume flips the switch back and emits an automation-resumed event", async () => {
		await handleConsoleMutation(automation("/admin/api/automation/pause"), mutationDeps());
		expect((await automationRow())?.paused).toBe(1);

		const response = await handleConsoleMutation(
			automation("/admin/api/automation/resume"),
			mutationDeps(),
		);
		expect(response.status).toBe(200);
		const descriptor = await bodyData<AutomationToggleDescriptor>(response);
		expect(descriptor.paused).toBe(false);

		const row = await automationRow();
		expect(row?.paused).toBe(0);
		expect(row?.reason).toBeNull();
		expect(
			await countRows(
				`SELECT COUNT(*) n FROM operational_events
				 WHERE action_id = ? AND event_type = 'automation-resumed' AND severity = 'info'`,
				descriptor.actionId,
			),
		).toBe(1);
	});
});

describe("console mutation: automation authorization (per-endpoint, pre-effect)", () => {
	afterEach(resetAutomation);

	it.each(["/admin/api/automation/pause", "/admin/api/automation/resume"])(
		"rejects a reviewer with zero side effects: %s",
		async (path) => {
			const before = {
				actions: await countRows(`SELECT COUNT(*) n FROM operator_actions`),
				events: await countRows(`SELECT COUNT(*) n FROM operational_events`),
				paused: (await automationRow())?.paused,
			};
			const response = await handleConsoleMutation(automation(path, reviewerToken), mutationDeps());
			expect(response.status).toBe(403);
			expect((await bodyError(response)).code).toBe("FORBIDDEN_ROLE");
			expect(await countRows(`SELECT COUNT(*) n FROM operator_actions`)).toBe(before.actions);
			expect(await countRows(`SELECT COUNT(*) n FROM operational_events`)).toBe(before.events);
			expect((await automationRow())?.paused).toBe(before.paused);
		},
	);

	it.each(["/admin/api/automation/pause", "/admin/api/automation/resume"])(
		"accepts an admin (the 403 is the role, not a broken endpoint): %s",
		async (path) => {
			const response = await handleConsoleMutation(automation(path, adminToken), mutationDeps());
			expect(response.status).toBe(200);
		},
	);

	it("rejects an unauthenticated caller with zero side effects (401)", async () => {
		const before = {
			actions: await countRows(`SELECT COUNT(*) n FROM operator_actions`),
			events: await countRows(`SELECT COUNT(*) n FROM operational_events`),
			paused: (await automationRow())?.paused,
		};
		const response = await handleConsoleMutation(
			automation("/admin/api/automation/pause", null),
			mutationDeps(),
		);
		expect(response.status).toBe(401);
		expect(await countRows(`SELECT COUNT(*) n FROM operator_actions`)).toBe(before.actions);
		expect(await countRows(`SELECT COUNT(*) n FROM operational_events`)).toBe(before.events);
		expect((await automationRow())?.paused).toBe(before.paused);
	});
});

describe("console mutation: automation replay and idempotency", () => {
	afterEach(resetAutomation);

	it("replays the stored result for the same key + reason, toggling once", async () => {
		const key = nextKey();
		const request = () =>
			post(
				"/admin/api/automation/pause",
				{ reason: "same reason", idempotencyKey: key },
				{ token: adminToken },
			);
		const first = await handleConsoleMutation(request(), mutationDeps());
		const firstBody = await first.text();
		const second = await handleConsoleMutation(request(), mutationDeps());
		expect(second.status).toBe(200);
		expect(await second.text()).toBe(firstBody);

		const descriptor = (JSON.parse(firstBody) as { data: AutomationToggleDescriptor }).data;
		expect(await eventCount(descriptor.actionId)).toBe(1);
		expect((await automationRow())?.paused).toBe(1);
	});

	it("409s a same-key request whose reason differs, with no second event", async () => {
		const key = nextKey();
		const first = await handleConsoleMutation(
			post(
				"/admin/api/automation/pause",
				{ reason: "first reason", idempotencyKey: key },
				{ token: adminToken },
			),
			mutationDeps(),
		);
		expect(first.status).toBe(200);
		const eventsBefore = await countRows(`SELECT COUNT(*) n FROM operational_events`);

		const second = await handleConsoleMutation(
			post(
				"/admin/api/automation/pause",
				{ reason: "different reason", idempotencyKey: key },
				{ token: adminToken },
			),
			mutationDeps(),
		);
		expect(second.status).toBe(409);
		expect((await bodyError(second)).code).toBe("IDEMPOTENCY_KEY_CONFLICT");
		expect(await countRows(`SELECT COUNT(*) n FROM operational_events`)).toBe(eventsBefore);
	});

	it("a second distinct pause while already paused is a harmless success", async () => {
		const first = await bodyData<AutomationToggleDescriptor>(
			await handleConsoleMutation(automation("/admin/api/automation/pause"), mutationDeps()),
		);
		const secondResponse = await handleConsoleMutation(
			automation("/admin/api/automation/pause"),
			mutationDeps(),
		);
		expect(secondResponse.status).toBe(200);
		const second = await bodyData<AutomationToggleDescriptor>(secondResponse);
		expect(second.paused).toBe(true);
		expect(second.actionId).not.toBe(first.actionId);

		// Still paused; each distinct action is independently audited and emits its
		// own event.
		expect((await automationRow())?.paused).toBe(1);
		expect(await eventCount(first.actionId)).toBe(1);
		expect(await eventCount(second.actionId)).toBe(1);
	});
});

class KillSwitchMessage implements MessageController {
	acked = 0;
	retried = 0;
	ack() {
		this.acked += 1;
	}
	retry() {
		this.retried += 1;
	}
}

class KillSwitchStubResolver implements DidDocumentResolverLike {
	resolve(): never {
		throw new Error("resolver should not be called — verify is injected");
	}
}

describe("console mutation: pause endpoint drives the discovery consumer gate (end-to-end)", () => {
	afterEach(resetAutomation);

	it("retries ingestion while paused, processes after resume", async () => {
		const rkeyName = "kill-switch-e2e";
		const uri = releaseUri(rkeyName);
		const job: DiscoveryJob = {
			did: PUBLISHER_DID,
			collection: "com.emdashcms.experimental.package.release",
			operation: "create",
			cid: CID,
			rkey: rkeyName,
		};
		const consumerDeps: DiscoveryConsumerDeps = {
			db: testEnv.DB,
			config: CONFIG,
			signer: await testSigner(),
			didDocumentResolver: new KillSwitchStubResolver(),
			verify: () =>
				Promise.resolve({
					cid: CID,
					record: { $type: job.collection, package: rkeyName, version: "1.0.0" },
					carBytes: new Uint8Array([0xde, 0xad, 0xbe, 0xef]),
				}),
		};

		const paused = await handleConsoleMutation(
			automation("/admin/api/automation/pause"),
			mutationDeps(),
		);
		expect(paused.status).toBe(200);

		const pausedMsg = new KillSwitchMessage();
		await processDiscoveryMessage(job, pausedMsg, consumerDeps);
		expect(pausedMsg.retried).toBe(1);
		expect(pausedMsg.acked).toBe(0);
		expect(await countRows(`SELECT COUNT(*) n FROM subjects WHERE uri = ?`, uri)).toBe(0);

		const resumed = await handleConsoleMutation(
			automation("/admin/api/automation/resume"),
			mutationDeps(),
		);
		expect(resumed.status).toBe(200);

		const resumedMsg = new KillSwitchMessage();
		await processDiscoveryMessage(job, resumedMsg, consumerDeps);
		expect(resumedMsg.acked).toBe(1);
		expect(resumedMsg.retried).toBe(0);
		expect(await countRows(`SELECT COUNT(*) n FROM subjects WHERE uri = ?`, uri)).toBe(1);
	});
});

// ─── W9.6: admin-only dead-letter retry / quarantine controls ────────────────

interface DeadLetterActionDescriptor {
	actionId: string;
	deadLetterId: number;
	status: string;
	cts: string;
}

let dlSeq = 0;

async function seedDeadLetter(
	overrides: { status?: string; job?: Partial<DiscoveryJob> } = {},
): Promise<{ id: number; job: DiscoveryJob }> {
	dlSeq += 1;
	const rkey = `dl-${dlSeq.toString().padStart(4, "0")}`;
	const job: DiscoveryJob = {
		did: PUBLISHER_DID,
		collection: "com.emdashcms.experimental.package.release",
		rkey,
		operation: "create",
		cid: CID,
		jetstreamRecord: { $type: "com.emdashcms.experimental.package.release", package: rkey },
		...overrides.job,
	};
	const payload = new TextEncoder().encode(JSON.stringify(job));
	const result = await testEnv.DB.prepare(
		`INSERT INTO dead_letters (did, collection, rkey, reason, detail, payload, received_at, status)
		 VALUES (?, ?, ?, 'verify-failed', 'detail', ?, datetime('now'), ?)`,
	)
		.bind(job.did, job.collection, job.rkey, payload, overrides.status ?? "new")
		.run();
	return { id: Number(result.meta.last_row_id), job };
}

async function deadLetterRow(id: number): Promise<{
	status: string;
	resolved_at: string | null;
	resolved_by_action_id: string | null;
} | null> {
	return testEnv.DB.prepare(
		`SELECT status, resolved_at, resolved_by_action_id FROM dead_letters WHERE id = ?`,
	)
		.bind(id)
		.first();
}

function deadLetterReq(
	path: string,
	token: string | null = adminToken,
	body: Record<string, unknown> = {},
): Request {
	return post(path, { reason: "re-drive", idempotencyKey: nextKey(), ...body }, { token });
}

/** Captures the deferred re-enqueue tail so a test can settle it and observe the
 * queue sends. `defer` collects the work rather than dropping it (the default
 * `mutationDeps` swallows deferred work). */
function captureReenqueue(): {
	deps: ConsoleMutationDeps;
	sent: DiscoveryJob[];
	settle: () => Promise<unknown>;
} {
	const sent: DiscoveryJob[] = [];
	const deferred: Promise<unknown>[] = [];
	const deps = mutationDeps({
		sendDiscoveryJob: async (job) => {
			sent.push(job);
		},
		defer: (work) => {
			deferred.push(work);
		},
	});
	return { deps, sent, settle: () => Promise.all(deferred.splice(0)) };
}

describe("console mutation: dead-letter retry (admin)", () => {
	it("flips new→retried, emits one info event + audit row, enqueues one job", async () => {
		const { id, job } = await seedDeadLetter();
		const { deps, sent, settle } = captureReenqueue();
		const response = await handleConsoleMutation(
			deadLetterReq(`/admin/api/dead-letters/${id}/retry`),
			deps,
		);
		expect(response.status).toBe(200);
		const descriptor = await bodyData<DeadLetterActionDescriptor>(response);
		expect(descriptor).toMatchObject({ deadLetterId: id, status: "retried" });

		const row = await deadLetterRow(id);
		expect(row?.status).toBe("retried");
		expect(row?.resolved_at).not.toBeNull();
		expect(row?.resolved_by_action_id).toBe(descriptor.actionId);

		expect(
			await countRows(
				`SELECT COUNT(*) n FROM operator_actions WHERE id = ? AND action = 'dlq-retry'`,
				descriptor.actionId,
			),
		).toBe(1);
		expect(
			await countRows(
				`SELECT COUNT(*) n FROM operational_events
				 WHERE action_id = ? AND event_type = 'dead-letter-retried' AND severity = 'info'`,
				descriptor.actionId,
			),
		).toBe(1);
		// No label issued, so no delivery outbox row.
		expect(await outboxCount(descriptor.actionId)).toBe(0);

		await settle();
		expect(sent).toHaveLength(1);
		expect(sent[0]).toMatchObject({
			did: job.did,
			collection: job.collection,
			rkey: job.rkey,
			cid: job.cid,
			operation: "create",
		});
	});
});

describe("console mutation: dead-letter quarantine (admin)", () => {
	it("flips new→quarantined, emits one info event, enqueues nothing", async () => {
		const { id } = await seedDeadLetter();
		const { deps, sent, settle } = captureReenqueue();
		const response = await handleConsoleMutation(
			deadLetterReq(`/admin/api/dead-letters/${id}/quarantine`),
			deps,
		);
		expect(response.status).toBe(200);
		const descriptor = await bodyData<DeadLetterActionDescriptor>(response);
		expect(descriptor).toMatchObject({ deadLetterId: id, status: "quarantined" });

		const row = await deadLetterRow(id);
		expect(row?.status).toBe("quarantined");
		expect(row?.resolved_by_action_id).toBe(descriptor.actionId);
		expect(
			await countRows(
				`SELECT COUNT(*) n FROM operational_events
				 WHERE action_id = ? AND event_type = 'dead-letter-quarantined' AND severity = 'info'`,
				descriptor.actionId,
			),
		).toBe(1);

		await settle();
		expect(sent).toHaveLength(0);
	});
});

describe("console mutation: dead-letter authorization (per-endpoint, pre-effect)", () => {
	it.each(["retry", "quarantine"])(
		"rejects a reviewer with zero side effects: %s",
		async (verb) => {
			const { id } = await seedDeadLetter();
			const before = {
				actions: await countRows(`SELECT COUNT(*) n FROM operator_actions`),
				events: await countRows(`SELECT COUNT(*) n FROM operational_events`),
			};
			const { deps, sent, settle } = captureReenqueue();
			const response = await handleConsoleMutation(
				deadLetterReq(`/admin/api/dead-letters/${id}/${verb}`, reviewerToken),
				deps,
			);
			expect(response.status).toBe(403);
			expect((await bodyError(response)).code).toBe("FORBIDDEN_ROLE");
			expect(await countRows(`SELECT COUNT(*) n FROM operator_actions`)).toBe(before.actions);
			expect(await countRows(`SELECT COUNT(*) n FROM operational_events`)).toBe(before.events);
			expect((await deadLetterRow(id))?.status).toBe("new");
			await settle();
			expect(sent).toHaveLength(0);
		},
	);

	it.each(["retry", "quarantine"])(
		"accepts an admin (the 403 is the role, not a broken endpoint): %s",
		async (verb) => {
			const { id } = await seedDeadLetter();
			const response = await handleConsoleMutation(
				deadLetterReq(`/admin/api/dead-letters/${id}/${verb}`, adminToken),
				mutationDeps(),
			);
			expect(response.status).toBe(200);
		},
	);

	it("rejects an unauthenticated caller with zero side effects (401)", async () => {
		const { id } = await seedDeadLetter();
		const before = {
			actions: await countRows(`SELECT COUNT(*) n FROM operator_actions`),
			events: await countRows(`SELECT COUNT(*) n FROM operational_events`),
		};
		const { deps, sent, settle } = captureReenqueue();
		const response = await handleConsoleMutation(
			deadLetterReq(`/admin/api/dead-letters/${id}/retry`, null),
			deps,
		);
		expect(response.status).toBe(401);
		expect(await countRows(`SELECT COUNT(*) n FROM operator_actions`)).toBe(before.actions);
		expect(await countRows(`SELECT COUNT(*) n FROM operational_events`)).toBe(before.events);
		expect((await deadLetterRow(id))?.status).toBe("new");
		await settle();
		expect(sent).toHaveLength(0);
	});
});

describe("console mutation: dead-letter double-processing (T6)", () => {
	it("404s a retry on an absent dead letter", async () => {
		const response = await handleConsoleMutation(
			deadLetterReq(`/admin/api/dead-letters/99999999/retry`),
			mutationDeps(),
		);
		expect(response.status).toBe(404);
	});

	it("404s a malformed dead-letter id", async () => {
		const response = await handleConsoleMutation(
			deadLetterReq(`/admin/api/dead-letters/not-an-id/retry`),
			mutationDeps(),
		);
		expect(response.status).toBe(404);
	});

	it("409s a second retry on an already-resolved letter with no second enqueue", async () => {
		const { id } = await seedDeadLetter();
		const { deps, sent, settle } = captureReenqueue();
		const first = await handleConsoleMutation(
			deadLetterReq(`/admin/api/dead-letters/${id}/retry`),
			deps,
		);
		expect(first.status).toBe(200);
		await settle();
		expect(sent).toHaveLength(1);

		const actionsBefore = await countRows(`SELECT COUNT(*) n FROM operator_actions`);
		const eventsBefore = await countRows(`SELECT COUNT(*) n FROM operational_events`);
		const second = await handleConsoleMutation(
			deadLetterReq(`/admin/api/dead-letters/${id}/retry`),
			deps,
		);
		expect(second.status).toBe(409);
		expect((await bodyError(second)).code).toBe("DEAD_LETTER_RESOLVED");
		expect(await countRows(`SELECT COUNT(*) n FROM operator_actions`)).toBe(actionsBefore);
		expect(await countRows(`SELECT COUNT(*) n FROM operational_events`)).toBe(eventsBefore);
		await settle();
		expect(sent).toHaveLength(1);
	});

	it("409s a quarantine after a retry, and a retry after a quarantine", async () => {
		const a = await seedDeadLetter();
		expect(
			(
				await handleConsoleMutation(
					deadLetterReq(`/admin/api/dead-letters/${a.id}/retry`),
					mutationDeps(),
				)
			).status,
		).toBe(200);
		const quarantineAfterRetry = await handleConsoleMutation(
			deadLetterReq(`/admin/api/dead-letters/${a.id}/quarantine`),
			mutationDeps(),
		);
		expect(quarantineAfterRetry.status).toBe(409);

		const b = await seedDeadLetter();
		expect(
			(
				await handleConsoleMutation(
					deadLetterReq(`/admin/api/dead-letters/${b.id}/quarantine`),
					mutationDeps(),
				)
			).status,
		).toBe(200);
		const retryAfterQuarantine = await handleConsoleMutation(
			deadLetterReq(`/admin/api/dead-letters/${b.id}/retry`),
			mutationDeps(),
		);
		expect(retryAfterQuarantine.status).toBe(409);
	});
});

describe("console mutation: dead-letter replay and idempotency", () => {
	it("replays the stored result for the same key, enqueuing exactly once", async () => {
		const { id } = await seedDeadLetter();
		const key = nextKey();
		const { deps, sent, settle } = captureReenqueue();
		const request = () =>
			post(
				`/admin/api/dead-letters/${id}/retry`,
				{ reason: "re-drive", idempotencyKey: key },
				{ token: adminToken },
			);
		const first = await handleConsoleMutation(request(), deps);
		const firstBody = await first.text();
		await settle();
		const second = await handleConsoleMutation(request(), deps);
		expect(second.status).toBe(200);
		expect(await second.text()).toBe(firstBody);
		await settle();
		// The replay returns the stored descriptor without re-running the effect.
		expect(sent).toHaveLength(1);
		const actionId = (JSON.parse(firstBody) as { data: DeadLetterActionDescriptor }).data.actionId;
		expect(await eventCount(actionId)).toBe(1);
	});

	it("409s a same-key request targeting a different dead letter", async () => {
		const a = await seedDeadLetter();
		const b = await seedDeadLetter();
		const key = nextKey();
		const first = await handleConsoleMutation(
			post(
				`/admin/api/dead-letters/${a.id}/retry`,
				{ reason: "re-drive", idempotencyKey: key },
				{ token: adminToken },
			),
			mutationDeps(),
		);
		expect(first.status).toBe(200);
		const second = await handleConsoleMutation(
			post(
				`/admin/api/dead-letters/${b.id}/retry`,
				{ reason: "re-drive", idempotencyKey: key },
				{ token: adminToken },
			),
			mutationDeps(),
		);
		expect(second.status).toBe(409);
		expect((await bodyError(second)).code).toBe("IDEMPOTENCY_KEY_CONFLICT");
	});
});
