import { applyD1Migrations, env } from "cloudflare:test";
import { ulid } from "ulidx";
import { beforeAll, describe, expect, it } from "vitest";

import { AggregatorClient } from "../src/aggregator-client.js";
import {
	NOTIFICATION_MAX_SEND_ATTEMPTS,
	NOTIFICATION_RETENTION_MS,
	NOTIFICATION_STUCK_PENDING_MS,
} from "../src/constants.js";
import {
	ensureContact,
	hashConfirmToken,
	recipientHash,
	recordConfirmSent,
	suppress,
} from "../src/notification-contacts.js";
import type { ConfirmationPayload, NoticePayload, SendResult } from "../src/notification-send.js";
import { runNotificationSweep } from "../src/notification-sweep.js";
import type { NotifyDeps } from "../src/notification-triggers.js";

interface TestEnv {
	DB: D1Database;
	TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
}
const testEnv = env as unknown as TestEnv;
const db = () => testEnv.DB;

const PEPPER = "sweep-pepper";
const SERVICE = "https://labels.example";
const RELEASE_URI = "at://did:plc:x/com.emdashcms.experimental.package.release/rel1";
const NOW = new Date(10_000_000_000);

let counter = 0;
const uniq = (p: string) => `${p}-${++counter}`;

beforeAll(async () => {
	await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
});

function dummyAggregator(): AggregatorClient {
	return new AggregatorClient({
		fetch: async () => new Response("nope", { status: 404 }),
	} as unknown as Fetcher);
}

interface RecordingSender {
	confirmations: ConfirmationPayload[];
	notices: NoticePayload[];
	sendConfirmation(p: ConfirmationPayload): Promise<SendResult>;
	sendNotice(p: NoticePayload): Promise<SendResult>;
}
function recordingSender(result: SendResult = { ok: true, providerId: "swept" }): RecordingSender {
	const confirmations: ConfirmationPayload[] = [];
	const notices: NoticePayload[] = [];
	return {
		confirmations,
		notices,
		sendConfirmation: async (p) => (confirmations.push(p), result),
		sendNotice: async (p) => (notices.push(p), result),
	};
}

function deps(sender: RecordingSender): NotifyDeps {
	return {
		db: db(),
		aggregator: dummyAggregator(),
		sender,
		pepper: PEPPER,
		serviceUrl: SERVICE,
		reconsiderationUrl: "https://recon.example",
		now: () => NOW,
	};
}

interface InsertRow {
	kind: "confirmation" | "notice";
	sourceType?: string;
	sourceId: string;
	recipientHash?: string | null;
	plaintext?: string | null;
	state: string;
	attempts: number;
	createdMs?: number;
}
async function insertNotification(row: InsertRow): Promise<string> {
	const id = uniq("ntf");
	await db()
		.prepare(
			`INSERT INTO notifications
			 (id, source_type, source_id, kind, channel, recipient_hash, state, attempts,
			  plaintext_email, created_at, created_at_epoch_ms)
			 VALUES (?, ?, ?, ?, 'email', ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			id,
			row.sourceType ?? "operator",
			row.sourceId,
			row.kind,
			row.recipientHash ?? null,
			row.state,
			row.attempts,
			row.plaintext ?? null,
			new Date(row.createdMs ?? NOW.getTime()).toISOString(),
			row.createdMs ?? NOW.getTime(),
		)
		.run();
	return id;
}

async function insertOperatorAction(id: string, val: string): Promise<void> {
	await db()
		.prepare(
			`INSERT INTO operator_actions
			 (id, actor_type, actor_id, role, action, subject_uri, subject_cid, label_value,
			  reason, idempotency_key, request_fingerprint, metadata_json, created_at, created_at_epoch_ms)
			 VALUES (?, 'human', 'op', 'reviewer', 'label-issue', ?, 'bafycid', ?, 'r', ?, 'fp', '{}', ?, ?)`,
		)
		.bind(id, RELEASE_URI, val, uniq("idem"), NOW.toISOString(), NOW.getTime())
		.run();
}

async function rowState(
	id: string,
): Promise<{ state: string; attempts: number; plaintext: string | null; provider: string | null }> {
	const r = await db()
		.prepare(
			`SELECT state, attempts, plaintext_email AS plaintext, provider_id AS provider FROM notifications WHERE id = ?`,
		)
		.bind(id)
		.first<{
			state: string;
			attempts: number;
			plaintext: string | null;
			provider: string | null;
		}>();
	return r!;
}

describe("failed notice retry", () => {
	it("re-renders from source and marks it sent", async () => {
		const sourceId = uniq("oact");
		await insertOperatorAction(sourceId, "security-yanked");
		const email = uniq("n") + "@x.test";
		const hash = await recipientHash(PEPPER, email);
		const id = await insertNotification({
			kind: "notice",
			sourceId,
			recipientHash: hash,
			plaintext: email,
			state: "failed",
			attempts: 1,
		});
		const sender = recordingSender();

		await runNotificationSweep(deps(sender));

		expect(sender.notices).toHaveLength(1);
		expect(sender.notices[0]?.to).toBe(email);
		const row = await rowState(id);
		expect(row).toMatchObject({ state: "sent", plaintext: null, provider: "swept" });
	});

	it("abandons a notice whose source has vanished", async () => {
		const email = uniq("gone") + "@x.test";
		const hash = await recipientHash(PEPPER, email);
		const id = await insertNotification({
			kind: "notice",
			sourceId: uniq("missing"),
			recipientHash: hash,
			plaintext: email,
			state: "failed",
			attempts: 1,
		});
		const sender = recordingSender();

		await runNotificationSweep(deps(sender));

		expect(sender.notices).toHaveLength(0);
		expect((await rowState(id)).state).toBe("undeliverable");
	});
});

describe("failed confirmation retry", () => {
	it("mints a FRESH token, stamps its hash, and sends", async () => {
		const email = uniq("c") + "@x.test";
		const hash = await recipientHash(PEPPER, email);
		await ensureContact(db(), hash, NOW.toISOString());
		const oldHash = await hashConfirmToken("old-token");
		await recordConfirmSent(db(), hash, oldHash, 1_000);
		const id = await insertNotification({
			kind: "confirmation",
			sourceId: uniq("src"),
			recipientHash: hash,
			plaintext: email,
			state: "failed",
			attempts: 2,
		});
		const sender = recordingSender();

		await runNotificationSweep(deps(sender));

		expect(sender.confirmations).toHaveLength(1);
		const url = new URL(sender.confirmations[0]!.confirmUrl);
		const newToken = url.searchParams.get("t") ?? "";
		const stored = await db()
			.prepare(`SELECT confirm_token_hash FROM notification_contacts WHERE recipient_hash = ?`)
			.bind(hash)
			.first<{ confirm_token_hash: string }>();
		expect(stored?.confirm_token_hash).toBe(await hashConfirmToken(newToken));
		expect(stored?.confirm_token_hash).not.toBe(oldHash);
		expect((await rowState(id)).state).toBe("sent");
	});

	it("abandons (undeliverable) when the contact is no longer unconfirmed", async () => {
		const email = uniq("cdone") + "@x.test";
		const hash = await recipientHash(PEPPER, email);
		// No unconfirmed contact row exists → recordConfirmSent no-ops → abandon.
		const id = await insertNotification({
			kind: "confirmation",
			sourceId: uniq("src"),
			recipientHash: hash,
			plaintext: email,
			state: "failed",
			attempts: 1,
		});
		const sender = recordingSender();

		await runNotificationSweep(deps(sender));

		expect(sender.confirmations).toHaveLength(0);
		expect((await rowState(id)).state).toBe("undeliverable");
	});
});

describe("attempts cap", () => {
	it("abandons an exhausted confirmation to undeliverable, clears plaintext, and reopens the lifetime cap", async () => {
		const email = uniq("cap") + "@x.test";
		const hash = await recipientHash(PEPPER, email);
		await ensureContact(db(), hash, NOW.toISOString());
		const id = await insertNotification({
			kind: "confirmation",
			sourceId: uniq("src"),
			recipientHash: hash,
			plaintext: email,
			state: "failed",
			attempts: NOTIFICATION_MAX_SEND_ATTEMPTS,
		});
		const sender = recordingSender();

		await runNotificationSweep(deps(sender));

		expect(sender.confirmations).toHaveLength(0);
		const row = await rowState(id);
		expect(row).toMatchObject({ state: "undeliverable", plaintext: null });
		// Cap reopened: no non-undeliverable confirmation row blocks a fresh send.
		const blocking = await db()
			.prepare(
				`SELECT COUNT(*) AS n FROM notifications WHERE recipient_hash = ? AND kind = 'confirmation' AND state != 'undeliverable'`,
			)
			.bind(hash)
			.first<{ n: number }>();
		expect(blocking?.n).toBe(0);
	});
});

describe("stuck pending", () => {
	it("re-drives a crash-stuck pending row", async () => {
		const sourceId = uniq("oact");
		await insertOperatorAction(sourceId, "security-yanked");
		const email = uniq("stuck") + "@x.test";
		const hash = await recipientHash(PEPPER, email);
		const id = await insertNotification({
			kind: "notice",
			sourceId,
			recipientHash: hash,
			plaintext: email,
			state: "pending",
			attempts: 0,
			createdMs: NOW.getTime() - NOTIFICATION_STUCK_PENDING_MS - 1,
		});
		const sender = recordingSender();

		await runNotificationSweep(deps(sender));

		expect(sender.notices).toHaveLength(1);
		expect((await rowState(id)).state).toBe("sent");
	});

	it("leaves a FRESH pending row alone", async () => {
		const email = uniq("fresh") + "@x.test";
		const hash = await recipientHash(PEPPER, email);
		const id = await insertNotification({
			kind: "notice",
			sourceId: uniq("oact"),
			recipientHash: hash,
			plaintext: email,
			state: "pending",
			attempts: 0,
			createdMs: NOW.getTime(),
		});
		const sender = recordingSender();

		await runNotificationSweep(deps(sender));

		expect(sender.notices).toHaveLength(0);
		expect((await rowState(id)).state).toBe("pending");
	});
});

describe("provider suppression during a retry", () => {
	it("retires the row and records the suppression", async () => {
		const email = uniq("bnc") + "@x.test";
		const hash = await recipientHash(PEPPER, email);
		await ensureContact(db(), hash, NOW.toISOString());
		await recordConfirmSent(db(), hash, await hashConfirmToken("t"), 1_000);
		const id = await insertNotification({
			kind: "confirmation",
			sourceId: uniq("src"),
			recipientHash: hash,
			plaintext: email,
			state: "failed",
			attempts: 1,
		});
		const sender = recordingSender({
			ok: false,
			error: "E_RECIPIENT_SUPPRESSED",
			suppress: "bounce",
		});

		await runNotificationSweep(deps(sender));

		expect((await rowState(id)).state).toBe("undeliverable");
		const supp = await db()
			.prepare(`SELECT reason FROM notification_suppressions WHERE recipient_hash = ?`)
			.bind(hash)
			.first<{ reason: string }>();
		expect(supp?.reason).toBe("bounce");
	});
});

describe("retention cleanup + ledger prune", () => {
	it("deletes old undeliverable and sent-notice rows but KEEPS sent confirmations", async () => {
		const old = NOW.getTime() - NOTIFICATION_RETENTION_MS - 1;
		const undel = await insertNotification({
			kind: "notice",
			sourceId: uniq("s"),
			recipientHash: "h1",
			state: "undeliverable",
			attempts: 0,
			createdMs: old,
		});
		const sentNotice = await insertNotification({
			kind: "notice",
			sourceId: uniq("s"),
			recipientHash: "h2",
			state: "sent",
			attempts: 0,
			createdMs: old,
		});
		const sentConfirm = await insertNotification({
			kind: "confirmation",
			sourceId: uniq("s"),
			recipientHash: "h3",
			state: "sent",
			attempts: 0,
			createdMs: old,
		});

		await runNotificationSweep(deps(recordingSender()));

		expect(await exists(undel)).toBe(false);
		expect(await exists(sentNotice)).toBe(false);
		expect(await exists(sentConfirm)).toBe(true);
	});

	it("prunes confirm-ledger rows below the rolling window", async () => {
		const oldMs = NOW.getTime() - 48 * 60 * 60 * 1000;
		await db()
			.prepare(
				`INSERT INTO notification_confirm_ledger (id, publisher_did, recipient_hash, sent_at_epoch_ms) VALUES (?, ?, ?, ?)`,
			)
			.bind(uniq("ncl"), "did:plc:old", "hh", oldMs)
			.run();

		await runNotificationSweep(deps(recordingSender()));

		const remaining = await db()
			.prepare(
				`SELECT COUNT(*) AS n FROM notification_confirm_ledger WHERE publisher_did = 'did:plc:old'`,
			)
			.first<{ n: number }>();
		expect(remaining?.n).toBe(0);
	});
});

describe("suppression re-check (F1)", () => {
	it("abandons and does NOT mail a failed NOTICE whose address was suppressed after it failed", async () => {
		const sourceId = uniq("oact");
		await insertOperatorAction(sourceId, "security-yanked");
		const email = uniq("supp") + "@x.test";
		const hash = await recipientHash(PEPPER, email);
		const id = await insertNotification({
			kind: "notice",
			sourceId,
			recipientHash: hash,
			plaintext: email,
			state: "failed",
			attempts: 1,
		});
		// The suppression lands after the row failed (e.g. an Unsubscribe click).
		await suppress(db(), hash, "unsubscribe", NOW.toISOString(), NOW.getTime());
		const sender = recordingSender();

		await runNotificationSweep(deps(sender));

		expect(sender.notices).toHaveLength(0);
		expect(await rowState(id)).toMatchObject({ state: "undeliverable", plaintext: null });
	});

	it("abandons a suppressed failed CONFIRMATION without minting a token", async () => {
		const email = uniq("csupp") + "@x.test";
		const hash = await recipientHash(PEPPER, email);
		await ensureContact(db(), hash, NOW.toISOString());
		await recordConfirmSent(db(), hash, await hashConfirmToken("t"), 1_000);
		const id = await insertNotification({
			kind: "confirmation",
			sourceId: uniq("src"),
			recipientHash: hash,
			plaintext: email,
			state: "failed",
			attempts: 1,
		});
		await suppress(db(), hash, "not_me", NOW.toISOString(), NOW.getTime());
		const sender = recordingSender();

		await runNotificationSweep(deps(sender));

		expect(sender.confirmations).toHaveLength(0);
		expect((await rowState(id)).state).toBe("undeliverable");
	});
});

describe("transient source read (F3)", () => {
	it("keeps a notice row pending (self-heals) when the assessment read fails transiently — never abandons it", async () => {
		const email = uniq("f3") + "@x.test";
		const hash = await recipientHash(PEPPER, email);
		const sourceId = `asmt_${ulid()}`; // valid id shape → getAssessment reaches the (throwing) query
		const id = await insertNotification({
			kind: "notice",
			sourceType: "issuance",
			sourceId,
			recipientHash: hash,
			plaintext: email,
			state: "failed",
			attempts: 1,
		});
		const sender = recordingSender();
		const throwingDeps: NotifyDeps = { ...deps(sender), db: dbThrowingOnAssessments(db()) };

		await runNotificationSweep(throwingDeps);

		expect(sender.notices).toHaveLength(0);
		// Claimed (→pending, attempts bumped) but NOT abandoned: the next sweep re-drives it.
		const row = await rowState(id);
		expect(row.state).toBe("pending");
		expect(row.attempts).toBe(2);
	});
});

/** Wrap a D1Database so the `getAssessment` read (`FROM assessments`) throws a
 * transient (non-TypeError) error; every other statement delegates. */
function dbThrowingOnAssessments(real: D1Database): D1Database {
	const wrapStmt = (stmt: D1PreparedStatement): D1PreparedStatement =>
		new Proxy(stmt, {
			get(target, prop, receiver) {
				if (prop === "bind")
					return (...args: unknown[]) =>
						wrapStmt((target.bind as (...a: unknown[]) => D1PreparedStatement)(...args));
				if (prop === "first")
					return async () => {
						throw new Error("transient D1 read");
					};
				const v = Reflect.get(target, prop, receiver);
				return typeof v === "function" ? v.bind(target) : v;
			},
		});
	return new Proxy(real, {
		get(target, prop, receiver) {
			if (prop === "prepare")
				return (query: string) => {
					const stmt = target.prepare(query);
					return query.includes("FROM assessments") ? wrapStmt(stmt) : stmt;
				};
			const v = Reflect.get(target, prop, receiver);
			return typeof v === "function" ? v.bind(target) : v;
		},
	});
}

async function exists(id: string): Promise<boolean> {
	const r = await db().prepare(`SELECT 1 FROM notifications WHERE id = ?`).bind(id).first();
	return r !== null;
}
