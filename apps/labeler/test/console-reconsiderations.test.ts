import { applyD1Migrations, env } from "cloudflare:test";
import { generateKeyPair, SignJWT } from "jose";
import { beforeAll, describe, expect, it } from "vitest";

import type { AccessKeyResolver } from "../src/access-auth.js";
import { AggregatorClient } from "../src/aggregator-client.js";
import { computeRunKey, initialTriggerId } from "../src/assessment-lifecycle.js";
import { createAssessmentRun, createSubject } from "../src/assessment-store.js";
import { handleConsoleApi, type ConsoleApiDeps } from "../src/console-api.js";
import { handleConsoleMutation, type ConsoleMutationDeps } from "../src/console-mutation-api.js";
import { OPERATOR_REQUEST_HEADER } from "../src/mutation-guard.js";
import {
	confirmContact,
	ensureContact,
	hashConfirmToken,
	recipientHash,
	recordConfirmSent,
} from "../src/notification-contacts.js";
import type { ConfirmationPayload, NoticePayload, SendResult } from "../src/notification-send.js";
import { resolveNoticeForSource, type NotifyDeps } from "../src/notification-triggers.js";

const TEAM_DOMAIN = "https://example-team.cloudflareaccess.com";
const AUDIENCE = "test-audience";
const ORIGIN = "https://labeler.example.com";
const LABELER_DID = "did:web:labels.emdashcms.com";
const LABELER_SERVICE_URL = "https://labels.emdashcms.com";
const PUBLISHER_DID = "did:plc:publisher000000000000000000";
const PUBLISHER_EMAIL = "security@publisher.example";
const RECON_URL = "https://emdashcms.com/plugin-moderation/reconsideration";
const PEPPER = "recon-pepper";
const CID = "bafkreif4oaymum54i5qefbwoblrt5zasfjhpyhyvacpseqtehi3queew5m";
const PRIVATE_NOTE = "PRIVATE-INTERNAL-secret-exploit-detail-do-not-leak";

const CONFIG = {
	labelerDid: LABELER_DID,
	signingKeyVersion: "v1",
	serviceUrl: LABELER_SERVICE_URL,
	signingPublicKeyMultibase: "zDnaepsL7AXenJkVYdkh5KuKsSU7Ykh7kyXaLLU7auN9FWSiZ",
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

interface RecordingSender {
	confirmations: ConfirmationPayload[];
	notices: NoticePayload[];
	sendConfirmation(p: ConfirmationPayload): Promise<SendResult>;
	sendNotice(p: NoticePayload): Promise<SendResult>;
}

function recordingSender(): RecordingSender {
	const confirmations: ConfirmationPayload[] = [];
	const notices: NoticePayload[] = [];
	return {
		confirmations,
		notices,
		sendConfirmation: async (p) => {
			confirmations.push(p);
			return { ok: true, providerId: "p" };
		},
		sendNotice: async (p) => {
			notices.push(p);
			return { ok: true, providerId: "p" };
		},
	};
}

/** Aggregator that surfaces the publisher's security email and no verification
 * claims, so a notice takes the double-opt-in path against a confirmed contact. */
function aggregator(): AggregatorClient {
	const fetcher = {
		fetch: async (url: string) => {
			if (url.includes("getPublisherVerification"))
				return Response.json({ did: PUBLISHER_DID, verifications: [], labels: [] });
			if (url.includes("getPublisher"))
				return Response.json({
					did: PUBLISHER_DID,
					profile: { contact: [{ kind: "security", email: PUBLISHER_EMAIL }] },
				});
			return new Response(JSON.stringify({ error: "NotFound" }), {
				status: 404,
				headers: { "content-type": "application/json" },
			});
		},
	} as unknown as Fetcher;
	return new AggregatorClient(fetcher);
}

function notifyDeps(sender: RecordingSender): NotifyDeps {
	return {
		db: testEnv.DB,
		aggregator: aggregator(),
		sender,
		pepper: PEPPER,
		serviceUrl: LABELER_SERVICE_URL,
		reconsiderationUrl: RECON_URL,
	};
}

/** A mutation-deps whose `defer` collects the post-commit promises so a test can
 * await the deferred notice before asserting on the sender. */
function mutationDeps(overrides: Partial<ConsoleMutationDeps> = {}): {
	deps: ConsoleMutationDeps;
	settle: () => Promise<void>;
} {
	const deferred: Promise<unknown>[] = [];
	const deps: ConsoleMutationDeps = {
		db: testEnv.DB,
		accessConfig: {
			teamDomain: TEAM_DOMAIN,
			audience: AUDIENCE,
			admins: ["admin@example.com"],
			reviewers: ["reviewer@example.com"],
		},
		keys: resolver,
		config: CONFIG,
		createSigner: () => Promise.reject(new Error("no signer needed")),
		now: () => new Date(),
		afterCommit: async () => {},
		defer: (work) => {
			deferred.push(work);
		},
		sendDiscoveryJob: async () => {},
		...overrides,
	};
	return { deps, settle: async () => void (await Promise.allSettled(deferred)) };
}

function readDeps(): ConsoleApiDeps {
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

function nextKey(): string {
	keySeq += 1;
	return `recon-key-${keySeq.toString().padStart(6, "0")}`;
}

function releaseUri(rkey: string): string {
	return `at://${PUBLISHER_DID}/com.emdashcms.experimental.package.release/${rkey}`;
}

async function bodyData<T>(response: Response): Promise<T> {
	const parsed = (await response.json()) as { data: T };
	return parsed.data;
}

async function bodyError(response: Response): Promise<{ code: string; message: string }> {
	const parsed = (await response.json()) as { error: { code: string; message: string } };
	return parsed.error;
}

async function countRows(sql: string, ...binds: unknown[]): Promise<number> {
	const row = await testEnv.DB.prepare(sql)
		.bind(...binds)
		.first<{ n: number }>();
	return row?.n ?? 0;
}

/** Seeds a subject + one assessment run, returning its id + uri. */
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

/** Confirms a contact for the publisher email so the notice sends rather than
 * kicking off a double-opt-in confirmation. */
async function seedConfirmedContact(): Promise<void> {
	const hash = await recipientHash(PEPPER, PUBLISHER_EMAIL);
	await ensureContact(testEnv.DB, hash, "2026-07-16T00:00:00.000Z");
	const th = await hashConfirmToken("seed");
	await recordConfirmSent(testEnv.DB, hash, th, 1_000);
	await confirmContact(testEnv.DB, hash, th, "2026-07-16T00:00:01.000Z");
}

/**
 * Wraps `db` so the FIRST `getReconsiderationById` SELECT returns `snapshot` (a
 * stale `open` view) and then passes through. Reproduces a concurrent resolve
 * whose pre-check read the case as open before the winner's guarded UPDATE
 * landed: the loser's own UPDATE no-ops while its audit row still commits.
 */
function staleOpenOnce(db: D1Database, snapshot: Record<string, unknown>): D1Database {
	let used = false;
	return new Proxy(db, {
		get(target, prop, receiver) {
			if (prop === "prepare") {
				return (sql: string) => {
					const stmt = target.prepare(sql);
					if (used || !(sql.includes("FROM reconsiderations") && sql.includes("WHERE id = ?")))
						return stmt;
					return new Proxy(stmt, {
						get(s, p) {
							if (p === "bind")
								return (...args: unknown[]) => {
									const bound = s.bind(...args);
									return new Proxy(bound, {
										get(b, bp) {
											if (bp === "first")
												return async () => {
													used = true;
													return snapshot;
												};
											const value = Reflect.get(b, bp);
											return typeof value === "function" ? value.bind(b) : value;
										},
									});
								};
							const value = Reflect.get(s, p);
							return typeof value === "function" ? value.bind(s) : value;
						},
					});
				};
			}
			const value = Reflect.get(target, prop, receiver);
			return typeof value === "function" ? value.bind(target) : value;
		},
	}) as unknown as D1Database;
}

async function openCase(
	assessmentId: string,
	deps: ConsoleMutationDeps,
	note = "publisher wrote in about this release",
): Promise<{ response: Response; reconsiderationId: string }> {
	const response = await handleConsoleMutation(
		post("/admin/api/reconsiderations/open", {
			assessmentId,
			note,
			reason: "opening a case",
			idempotencyKey: nextKey(),
		}),
		deps,
	);
	if (response.status !== 200) return { response, reconsiderationId: "" };
	const data = await bodyData<{ reconsiderationId: string }>(response.clone());
	return { response, reconsiderationId: data.reconsiderationId };
}

describe("reconsideration open", () => {
	it("creates the case, its first note, the operational event, and the audit row", async () => {
		const { id, uri } = await seedRun("open-basic");
		const { deps } = mutationDeps();
		const { response, reconsiderationId } = await openCase(id, deps);
		expect(response.status).toBe(200);
		expect(reconsiderationId).toMatch(/^rcn_/);

		const cases = await testEnv.DB.prepare(
			`SELECT state, outcome, subject_uri, subject_cid, triggering_assessment_id, opened_by_email, opened_by_role
			 FROM reconsiderations WHERE id = ?`,
		)
			.bind(reconsiderationId)
			.first();
		expect(cases).toMatchObject({
			state: "open",
			outcome: null,
			subject_uri: uri,
			subject_cid: CID,
			triggering_assessment_id: id,
			opened_by_email: "reviewer@example.com",
			opened_by_role: "reviewer",
		});
		expect(
			await countRows(
				`SELECT COUNT(*) n FROM reconsideration_notes WHERE reconsideration_id = ?`,
				reconsiderationId,
			),
		).toBe(1);
		expect(
			await countRows(
				`SELECT COUNT(*) n FROM operational_events WHERE event_type = 'reconsideration-opened' AND subject_uri = ?`,
				uri,
			),
		).toBe(1);
		expect(
			await countRows(
				`SELECT COUNT(*) n FROM operator_actions WHERE action = 'reconsideration-open' AND subject_uri = ?`,
				uri,
			),
		).toBe(1);
	});

	it("409s a second open for a subject that already has an open case", async () => {
		const { id } = await seedRun("open-dup");
		const { deps } = mutationDeps();
		const first = await openCase(id, deps);
		expect(first.response.status).toBe(200);

		const second = await openCase(id, deps);
		expect(second.response.status).toBe(409);
		expect((await bodyError(second.response)).code).toBe("RECONSIDERATION_OPEN_EXISTS");
		expect(
			await countRows(
				`SELECT COUNT(*) n FROM reconsiderations WHERE subject_uri = ? AND state = 'open'`,
				releaseUri("open-dup"),
			),
		).toBe(1);
	});

	it("404s an unknown assessment id", async () => {
		const { deps } = mutationDeps();
		const response = await handleConsoleMutation(
			post("/admin/api/reconsiderations/open", {
				assessmentId: "asmt_00000000000000000000000000",
				note: "no such run",
				reason: "opening",
				idempotencyKey: nextKey(),
			}),
			deps,
		);
		expect(response.status).toBe(404);
	});

	it("replays the stored descriptor without a second case", async () => {
		const { id } = await seedRun("open-replay");
		const { deps } = mutationDeps();
		const body = {
			assessmentId: id,
			note: "once",
			reason: "opening",
			idempotencyKey: nextKey(),
		};
		const first = await handleConsoleMutation(post("/admin/api/reconsiderations/open", body), deps);
		const firstText = await first.text();
		const second = await handleConsoleMutation(
			post("/admin/api/reconsiderations/open", body),
			deps,
		);
		expect(await second.text()).toBe(firstText);
		expect(
			await countRows(
				`SELECT COUNT(*) n FROM reconsiderations WHERE subject_uri = ?`,
				releaseUri("open-replay"),
			),
		).toBe(1);
	});
});

describe("reconsideration note", () => {
	it("appends a note to an open case", async () => {
		const { id } = await seedRun("note-open");
		const { deps } = mutationDeps();
		const { reconsiderationId } = await openCase(id, deps);

		const response = await handleConsoleMutation(
			post(`/admin/api/reconsiderations/${reconsiderationId}/note`, {
				note: "second note",
				reason: "adding context",
				idempotencyKey: nextKey(),
			}),
			deps,
		);
		expect(response.status).toBe(200);
		expect(
			await countRows(
				`SELECT COUNT(*) n FROM reconsideration_notes WHERE reconsideration_id = ?`,
				reconsiderationId,
			),
		).toBe(2);
	});

	it("404s a note on an unknown case", async () => {
		const { deps } = mutationDeps();
		const response = await handleConsoleMutation(
			post("/admin/api/reconsiderations/rcn_00000000000000000000000000/note", {
				note: "orphan",
				reason: "adding",
				idempotencyKey: nextKey(),
			}),
			deps,
		);
		expect(response.status).toBe(404);
	});

	it("allows a note on a resolved case for post-hoc audit", async () => {
		const { id } = await seedRun("note-resolved");
		const { deps } = mutationDeps();
		const { reconsiderationId } = await openCase(id, deps);
		const resolved = await handleConsoleMutation(
			post(`/admin/api/reconsiderations/${reconsiderationId}/resolve`, {
				outcome: "withdrawn",
				reason: "moot",
				idempotencyKey: nextKey(),
			}),
			deps,
		);
		expect(resolved.status).toBe(200);

		const response = await handleConsoleMutation(
			post(`/admin/api/reconsiderations/${reconsiderationId}/note`, {
				note: "post-hoc",
				reason: "audit",
				idempotencyKey: nextKey(),
			}),
			deps,
		);
		expect(response.status).toBe(200);
	});
});

describe("reconsideration resolve", () => {
	it("sets outcome, state, and provenance and fires a notice for granted", async () => {
		await seedConfirmedContact();
		const { id, uri } = await seedRun("resolve-granted");
		const sender = recordingSender();
		const { deps, settle } = mutationDeps({ notify: notifyDeps(sender) });
		const { reconsiderationId } = await openCase(id, deps, PRIVATE_NOTE);

		const response = await handleConsoleMutation(
			post(`/admin/api/reconsiderations/${reconsiderationId}/resolve`, {
				outcome: "granted",
				note: `${PRIVATE_NOTE} — resolving`,
				reason: "reviewer granted after rerun",
				idempotencyKey: nextKey(),
			}),
			deps,
		);
		expect(response.status).toBe(200);
		await settle();

		const row = await testEnv.DB.prepare(
			`SELECT state, outcome, resolved_by_email, outcome_action_id FROM reconsiderations WHERE id = ?`,
		)
			.bind(reconsiderationId)
			.first();
		const descriptor = await bodyData<{ actionId: string }>(response);
		expect(row).toMatchObject({
			state: "resolved",
			outcome: "granted",
			resolved_by_email: "reviewer@example.com",
			outcome_action_id: descriptor.actionId,
		});
		expect(
			await countRows(
				`SELECT COUNT(*) n FROM operational_events WHERE event_type = 'reconsideration-resolved' AND action_id = ?`,
				descriptor.actionId,
			),
		).toBe(1);

		// The notice went out and its copy contains NONE of the private-note text.
		expect(sender.notices).toHaveLength(1);
		const notice = sender.notices[0]!;
		expect(notice.subject).toBe("Your reconsideration request was granted");
		expect(notice.assessmentUrl).toContain(encodeURIComponent(uri));
		expect(notice.reconsiderationUrl).toBe(RECON_URL);
		expect(JSON.stringify(notice)).not.toContain(PRIVATE_NOTE);
	});

	it("fires a notice for denied", async () => {
		await seedConfirmedContact();
		const { id } = await seedRun("resolve-denied");
		const sender = recordingSender();
		const { deps, settle } = mutationDeps({ notify: notifyDeps(sender) });
		const { reconsiderationId } = await openCase(id, deps);

		const response = await handleConsoleMutation(
			post(`/admin/api/reconsiderations/${reconsiderationId}/resolve`, {
				outcome: "denied",
				reason: "assessment upheld",
				idempotencyKey: nextKey(),
			}),
			deps,
		);
		expect(response.status).toBe(200);
		await settle();
		expect(sender.notices).toHaveLength(1);
		expect(sender.notices[0]!.subject).toBe("Your reconsideration request was reviewed");
	});

	it("fires NO notice for withdrawn", async () => {
		await seedConfirmedContact();
		const { id } = await seedRun("resolve-withdrawn");
		const sender = recordingSender();
		const { deps, settle } = mutationDeps({ notify: notifyDeps(sender) });
		const { reconsiderationId } = await openCase(id, deps);

		const response = await handleConsoleMutation(
			post(`/admin/api/reconsiderations/${reconsiderationId}/resolve`, {
				outcome: "withdrawn",
				reason: "requester withdrew",
				idempotencyKey: nextKey(),
			}),
			deps,
		);
		expect(response.status).toBe(200);
		await settle();
		expect(sender.notices).toHaveLength(0);
		expect(sender.confirmations).toHaveLength(0);
	});

	it("409s a double-resolve", async () => {
		const { id } = await seedRun("resolve-double");
		const { deps } = mutationDeps();
		const { reconsiderationId } = await openCase(id, deps);

		const first = await handleConsoleMutation(
			post(`/admin/api/reconsiderations/${reconsiderationId}/resolve`, {
				outcome: "denied",
				reason: "first resolve",
				idempotencyKey: nextKey(),
			}),
			deps,
		);
		expect(first.status).toBe(200);

		const second = await handleConsoleMutation(
			post(`/admin/api/reconsiderations/${reconsiderationId}/resolve`, {
				outcome: "granted",
				reason: "second resolve",
				idempotencyKey: nextKey(),
			}),
			deps,
		);
		expect(second.status).toBe(409);
		expect((await bodyError(second)).code).toBe("RECONSIDERATION_RESOLVED");
	});

	it("rejects an unknown outcome", async () => {
		const { id } = await seedRun("resolve-badoutcome");
		const { deps } = mutationDeps();
		const { reconsiderationId } = await openCase(id, deps);
		const response = await handleConsoleMutation(
			post(`/admin/api/reconsiderations/${reconsiderationId}/resolve`, {
				outcome: "maybe",
				reason: "bad",
				idempotencyKey: nextKey(),
			}),
			deps,
		);
		expect(response.status).toBe(400);
	});

	it("lets a fresh case open after resolution", async () => {
		const { id } = await seedRun("resolve-reopen");
		const { deps } = mutationDeps();
		const first = await openCase(id, deps);
		await handleConsoleMutation(
			post(`/admin/api/reconsiderations/${first.reconsiderationId}/resolve`, {
				outcome: "denied",
				reason: "upheld",
				idempotencyKey: nextKey(),
			}),
			deps,
		);
		const second = await openCase(id, deps);
		expect(second.response.status).toBe(200);
		expect(second.reconsiderationId).not.toBe(first.reconsiderationId);
	});

	it("does not re-notify when a losing concurrent resolve's key is replayed", async () => {
		await seedConfirmedContact();
		const { id, uri } = await seedRun("resolve-concurrent-loser");
		const sender = recordingSender();
		const { deps, settle } = mutationDeps({ notify: notifyDeps(sender) });
		const { reconsiderationId } = await openCase(id, deps);

		// The open snapshot both concurrent resolves' pre-checks would have read.
		const openSnapshot = await testEnv.DB.prepare(`SELECT * FROM reconsiderations WHERE id = ?`)
			.bind(reconsiderationId)
			.first();
		expect(openSnapshot?.state).toBe("open");

		// Winner A resolves granted and notifies.
		const winner = await handleConsoleMutation(
			post(`/admin/api/reconsiderations/${reconsiderationId}/resolve`, {
				outcome: "granted",
				reason: "A wins",
				idempotencyKey: nextKey(),
			}),
			deps,
		);
		expect(winner.status).toBe(200);
		await settle();
		const winnerActionId = (await bodyData<{ actionId: string }>(winner)).actionId;
		expect(sender.notices).toHaveLength(1);
		expect(sender.notices[0]!.subject).toBe("Your reconsideration request was granted");

		// Loser B: its pre-check sees the stale open snapshot, so it reaches commit;
		// its guarded UPDATE no-ops (case already resolved) but its audit row + stored
		// descriptor persist with outcome=denied. Fresh path must not notify (it lost).
		const loserBody = { outcome: "denied", reason: "B loses", idempotencyKey: nextKey() };
		const loserDeps = mutationDeps({ notify: notifyDeps(sender) });
		const loser = await handleConsoleMutation(
			post(`/admin/api/reconsiderations/${reconsiderationId}/resolve`, loserBody),
			{ ...loserDeps.deps, db: staleOpenOnce(testEnv.DB, openSnapshot!) },
		);
		expect(loser.status).toBe(200);
		await loserDeps.settle();
		const loserDescriptor = await bodyData<{ actionId: string; outcome: string }>(loser);
		expect(loserDescriptor.outcome).toBe("denied");
		// The case still records A's win, and no second notice fired.
		const caseRow = await testEnv.DB.prepare(
			`SELECT outcome, outcome_action_id FROM reconsiderations WHERE id = ?`,
		)
			.bind(reconsiderationId)
			.first<{ outcome: string; outcome_action_id: string }>();
		expect(caseRow?.outcome).toBe("granted");
		expect(caseRow?.outcome_action_id).not.toBe(loserDescriptor.actionId);
		expect(sender.notices).toHaveLength(1);
		// Exactly one resolved-event, the winner's — the loser's is gated out.
		const events = await testEnv.DB.prepare(
			`SELECT action_id FROM operational_events WHERE event_type = 'reconsideration-resolved' AND subject_uri = ?`,
		)
			.bind(uri)
			.all<{ action_id: string }>();
		expect(events.results).toHaveLength(1);
		expect(events.results![0]!.action_id).toBe(winnerActionId);

		// Replaying B's key must NOT fire a second (contradictory 'denied') notice.
		const replayDeps = mutationDeps({ notify: notifyDeps(sender) });
		const replay = await handleConsoleMutation(
			post(`/admin/api/reconsiderations/${reconsiderationId}/resolve`, loserBody),
			replayDeps.deps,
		);
		expect(replay.status).toBe(200);
		await replayDeps.settle();
		expect(sender.notices).toHaveLength(1);
		expect(sender.notices[0]!.subject).toBe("Your reconsideration request was granted");
	});
});

describe("resolveNoticeForSource sweep parity", () => {
	it("re-renders content identical to the live granted notice", async () => {
		await seedConfirmedContact();
		const { id } = await seedRun("sweep-parity");
		const sender = recordingSender();
		const { deps, settle } = mutationDeps({ notify: notifyDeps(sender) });
		const { reconsiderationId } = await openCase(id, deps, PRIVATE_NOTE);
		const response = await handleConsoleMutation(
			post(`/admin/api/reconsiderations/${reconsiderationId}/resolve`, {
				outcome: "granted",
				reason: "granted",
				idempotencyKey: nextKey(),
			}),
			deps,
		);
		await settle();
		const descriptor = await bodyData<{ actionId: string }>(response);

		const rebuilt = await resolveNoticeForSource(
			notifyDeps(sender),
			"operator",
			descriptor.actionId,
		);
		expect(rebuilt).not.toBeNull();
		const live = sender.notices[0]!;
		expect(rebuilt).toMatchObject({
			subject: live.subject,
			publicSummary: live.publicSummary,
			effect: live.effect,
			assessmentUrl: live.assessmentUrl,
			reconsiderationUrl: live.reconsiderationUrl,
		});
		expect(JSON.stringify(rebuilt)).not.toContain(PRIVATE_NOTE);
	});

	it("re-renders null for a withdrawn resolve (sweep abandons the row)", async () => {
		const { id } = await seedRun("sweep-withdrawn");
		const sender = recordingSender();
		const { deps } = mutationDeps({ notify: notifyDeps(sender) });
		const { reconsiderationId } = await openCase(id, deps);
		const response = await handleConsoleMutation(
			post(`/admin/api/reconsiderations/${reconsiderationId}/resolve`, {
				outcome: "withdrawn",
				reason: "moot",
				idempotencyKey: nextKey(),
			}),
			deps,
		);
		const descriptor = await bodyData<{ actionId: string }>(response);
		expect(
			await resolveNoticeForSource(notifyDeps(sender), "operator", descriptor.actionId),
		).toBeNull();
	});
});

describe("reconsideration read API", () => {
	it("lists cases newest-first and returns a case with its note thread", async () => {
		const { id } = await seedRun("read-case");
		const { deps } = mutationDeps();
		const { reconsiderationId } = await openCase(id, deps, "first note");
		await handleConsoleMutation(
			post(`/admin/api/reconsiderations/${reconsiderationId}/note`, {
				note: "second note",
				reason: "context",
				idempotencyKey: nextKey(),
			}),
			deps,
		);

		const list = await handleConsoleApi(getReq("/admin/api/reconsiderations"), readDeps());
		expect(list.status).toBe(200);
		const listBody = await bodyData<{ items: { id: string; state: string }[] }>(list);
		expect(listBody.items.some((c) => c.id === reconsiderationId && c.state === "open")).toBe(true);

		const detail = await handleConsoleApi(
			getReq(`/admin/api/reconsiderations/${reconsiderationId}`),
			readDeps(),
		);
		expect(detail.status).toBe(200);
		const detailBody = await bodyData<{
			reconsideration: { id: string; state: string };
			notes: { note: string }[];
		}>(detail);
		expect(detailBody.reconsideration.id).toBe(reconsiderationId);
		expect(detailBody.notes.map((n) => n.note)).toEqual(["first note", "second note"]);
	});

	it("404s an unknown case", async () => {
		const response = await handleConsoleApi(
			getReq("/admin/api/reconsiderations/rcn_00000000000000000000000000"),
			readDeps(),
		);
		expect(response.status).toBe(404);
	});
});
