import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import { AggregatorClient } from "../src/aggregator-client.js";
import { CONFIRM_DID_MAX_DISTINCT_RECIPIENTS, CONFIRM_MIN_INTERVAL_MS } from "../src/constants.js";
import {
	confirmContact,
	declineContact,
	ensureContact,
	hashConfirmToken,
	recipientHash,
	recordConfirmSent,
	suppress,
} from "../src/notification-contacts.js";
import type {
	ConfirmationPayload,
	NoticePayload,
	NotificationRequest,
	NotificationSender,
	SendContext,
	SendResult,
} from "../src/notification-send.js";
import { sendNotification } from "../src/notification-send.js";

interface TestEnv {
	DB: D1Database;
	TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
}

const testEnv = env as unknown as TestEnv;
const db = () => testEnv.DB;

const PEPPER = "send-pepper";
const ORIGIN = "https://labels.example";

let counter = 0;
function uniq(prefix: string): string {
	counter++;
	return `${prefix}-${counter}`;
}

beforeAll(async () => {
	await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
});

/** An AggregatorClient whose publisher-profile read carries `email` as a
 * security-kind tier-3 contact (package reads 404, so tiers 1-2 miss). A null
 * `email` makes both reads 404 — the no-resolvable-contact case. */
function aggregatorFor(email: string | null): AggregatorClient {
	const notFound = () =>
		new Response(JSON.stringify({ error: "NotFound" }), {
			status: 404,
			headers: { "content-type": "application/json" },
		});
	const fetcher = {
		// AggregatorClient always calls fetch with a string URL (see aggregator-client.ts).
		fetch: async (url: string) => {
			if (url.includes("getPublisher") && !url.includes("getPublisherVerification") && email) {
				return Response.json({
					did: "did:plc:stub",
					profile: { contact: [{ kind: "security", email }] },
				});
			}
			return notFound();
		},
	} as unknown as Fetcher;
	return new AggregatorClient(fetcher);
}

interface RecordingSender extends NotificationSender {
	confirmations: ConfirmationPayload[];
	notices: NoticePayload[];
}

function recordingSender(result: SendResult = { ok: true, providerId: "prov-1" }): RecordingSender {
	const confirmations: ConfirmationPayload[] = [];
	const notices: NoticePayload[] = [];
	return {
		confirmations,
		notices,
		sendConfirmation: async (payload) => {
			confirmations.push(payload);
			return result;
		},
		sendNotice: async (payload) => {
			notices.push(payload);
			return result;
		},
	};
}

function context(email: string | null, sender: RecordingSender, now?: () => Date): SendContext {
	return {
		db: db(),
		aggregator: aggregatorFor(email),
		pepper: PEPPER,
		sender,
		origin: ORIGIN,
		now,
	};
}

function request(did: string, sourceId: string): NotificationRequest {
	return {
		source: { type: "issuance", id: sourceId },
		target: { did, slug: "pkg" },
		notice: {
			subject: "Your package was blocked",
			publicSummary: "public summary",
			assessmentUrl: "https://labels.example/a/1",
			effect: "blocked",
			reconsiderationUrl: "https://labels.example/reconsider",
		},
	};
}

interface NotificationRow {
	id: string;
	kind: string;
	state: string;
	recipient_hash: string | null;
	attempts: number;
	provider_id: string | null;
	last_error: string | null;
	plaintext_email: string | null;
	sent_at: string | null;
}

async function rowsForSource(sourceId: string): Promise<NotificationRow[]> {
	const result = await db()
		.prepare(`SELECT * FROM notifications WHERE source_id = ? ORDER BY created_at_epoch_ms`)
		.bind(sourceId)
		.all<NotificationRow>();
	return result.results ?? [];
}

async function ledgerCount(did: string): Promise<number> {
	const row = await db()
		.prepare(`SELECT COUNT(*) AS n FROM notification_confirm_ledger WHERE publisher_did = ?`)
		.bind(did)
		.first<{ n: number }>();
	return row?.n ?? 0;
}

async function storedTokenHash(hash: string): Promise<string | null> {
	const row = await db()
		.prepare(`SELECT confirm_token_hash FROM notification_contacts WHERE recipient_hash = ?`)
		.bind(hash)
		.first<{ confirm_token_hash: string | null }>();
	return row?.confirm_token_hash ?? null;
}

async function seedConfirmed(hash: string): Promise<void> {
	await ensureContact(db(), hash, "2026-07-16T00:00:00.000Z");
	const tokenHash = await hashConfirmToken("seed-token");
	await recordConfirmSent(db(), hash, tokenHash, 1_000);
	await confirmContact(db(), hash, tokenHash, "2026-07-16T00:00:01.000Z");
}

describe("confirmed contact", () => {
	it("sends a substantive notice, marks it sent, and clears plaintext", async () => {
		const email = uniq("confirmed") + "@example.test";
		const hash = await recipientHash(PEPPER, email);
		await seedConfirmed(hash);
		const sender = recordingSender({ ok: true, providerId: "prov-notice" });
		const sourceId = uniq("src");

		const outcome = await sendNotification(context(email, sender), request("did:plc:a", sourceId));

		expect(outcome).toEqual({
			status: "notice_sent",
			recipientHash: hash,
			providerId: "prov-notice",
		});
		expect(sender.notices).toHaveLength(1);
		expect(sender.confirmations).toHaveLength(0);
		expect(sender.notices[0]).toMatchObject({
			to: email,
			subject: "Your package was blocked",
			effect: "blocked",
			assessmentUrl: "https://labels.example/a/1",
			reconsiderationUrl: "https://labels.example/reconsider",
		});
		expect(sender.notices[0]?.unsubscribeUrl).toBe(
			`https://labels.example/notifications/unsubscribe?c=${hash}`,
		);

		const rows = await rowsForSource(sourceId);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			kind: "notice",
			state: "sent",
			recipient_hash: hash,
			provider_id: "prov-notice",
			plaintext_email: null,
			attempts: 0,
		});
		expect(rows[0]?.sent_at).not.toBeNull();
	});

	it("records failed with attempts bumped and plaintext retained on a send failure", async () => {
		const email = uniq("confirmedfail") + "@example.test";
		const hash = await recipientHash(PEPPER, email);
		await seedConfirmed(hash);
		const sender = recordingSender({ ok: false, error: "smtp down" });
		const sourceId = uniq("src");

		const outcome = await sendNotification(context(email, sender), request("did:plc:a", sourceId));

		expect(outcome).toEqual({ status: "notice_failed", recipientHash: hash, error: "smtp down" });
		const rows = await rowsForSource(sourceId);
		expect(rows[0]).toMatchObject({
			kind: "notice",
			state: "failed",
			last_error: "smtp down",
			attempts: 1,
			plaintext_email: email,
		});
	});

	it("sends nothing to a confirmed but suppressed contact", async () => {
		const email = uniq("confsupp") + "@example.test";
		const hash = await recipientHash(PEPPER, email);
		await seedConfirmed(hash);
		await suppress(db(), hash, "bounce", "2026-07-16T00:00:00.000Z", 1_000);
		const sender = recordingSender();
		const sourceId = uniq("src");

		const outcome = await sendNotification(context(email, sender), request("did:plc:a", sourceId));

		expect(outcome).toEqual({ status: "suppressed", recipientHash: hash });
		expect(sender.notices).toHaveLength(0);
		const rows = await rowsForSource(sourceId);
		expect(rows[0]).toMatchObject({ state: "undeliverable", last_error: "suppressed" });
	});
});

describe("unconfirmed contact — double opt-in", () => {
	it("sends a confirmation mail, persisting only the token hash", async () => {
		const email = uniq("unconf") + "@example.test";
		const hash = await recipientHash(PEPPER, email);
		const did = uniq("did:plc");
		const sender = recordingSender({ ok: true, providerId: "prov-confirm" });
		const sourceId = uniq("src");

		const outcome = await sendNotification(context(email, sender), request(did, sourceId));

		expect(outcome).toEqual({
			status: "confirmation_sent",
			recipientHash: hash,
			providerId: "prov-confirm",
		});
		expect(sender.confirmations).toHaveLength(1);
		expect(sender.notices).toHaveLength(0);

		const confirmUrl = new URL(sender.confirmations[0]!.confirmUrl);
		expect(confirmUrl.origin + confirmUrl.pathname).toBe(
			"https://labels.example/notifications/confirm",
		);
		expect(confirmUrl.searchParams.get("c")).toBe(hash);
		const rawToken = confirmUrl.searchParams.get("t") ?? "";

		// CSPRNG base64url, >=128 bits (>=22 chars); matches the confirm endpoint's token grammar.
		expect(rawToken).toMatch(/^[A-Za-z0-9_-]+$/);
		expect(rawToken.length).toBeGreaterThanOrEqual(22);

		// The stored hash is SHA-256(rawToken); the raw token is nowhere in the DB.
		expect(await storedTokenHash(hash)).toBe(await hashConfirmToken(rawToken));
		const rows = await rowsForSource(sourceId);
		expect(rows[0]).toMatchObject({
			kind: "confirmation",
			state: "sent",
			recipient_hash: hash,
			provider_id: "prov-confirm",
			plaintext_email: null,
		});
		for (const row of rows) {
			expect(row.plaintext_email).not.toBe(rawToken);
			expect(row.last_error).not.toBe(rawToken);
		}
		expect(sender.confirmations[0]).toMatchObject({
			to: email,
			unsubscribeUrl: `https://labels.example/notifications/unsubscribe?c=${hash}`,
			notMeUrl: `https://labels.example/notifications/not-me?c=${hash}`,
		});
		expect(await ledgerCount(did)).toBe(1);
	});

	it("records confirmation failure with plaintext retained (token still recorded)", async () => {
		const email = uniq("unconffail") + "@example.test";
		const hash = await recipientHash(PEPPER, email);
		const sender = recordingSender({ ok: false, error: "provider 500" });
		const sourceId = uniq("src");

		const outcome = await sendNotification(context(email, sender), request(uniq("did"), sourceId));

		expect(outcome).toEqual({
			status: "confirmation_failed",
			recipientHash: hash,
			error: "provider 500",
		});
		const rows = await rowsForSource(sourceId);
		expect(rows[0]).toMatchObject({
			kind: "confirmation",
			state: "failed",
			last_error: "provider 500",
			attempts: 1,
			plaintext_email: email,
		});
		expect(await storedTokenHash(hash)).not.toBeNull();
	});

	it("rate-limits per address: no second confirmation within the interval", async () => {
		const email = uniq("addr") + "@example.test";
		const hash = await recipientHash(PEPPER, email);
		const sentAtMs = 2_000_000;
		await ensureContact(db(), hash, "2026-07-16T00:00:00.000Z");
		await recordConfirmSent(db(), hash, await hashConfirmToken("prev"), sentAtMs);
		const sender = recordingSender();
		const sourceId = uniq("src");
		const now = () => new Date(sentAtMs + CONFIRM_MIN_INTERVAL_MS - 1);

		const outcome = await sendNotification(
			context(email, sender, now),
			request(uniq("did"), sourceId),
		);

		expect(outcome).toEqual({ status: "rate_limited", recipientHash: hash, scope: "address" });
		expect(sender.confirmations).toHaveLength(0);
		expect(await rowsForSource(sourceId)).toHaveLength(0);
	});

	it("rate-limits per DID once the distinct-recipient cap is reached", async () => {
		const did = uniq("did:plc:bulk");
		const nowMs = 5_000_000;
		for (let i = 0; i < CONFIRM_DID_MAX_DISTINCT_RECIPIENTS; i++) {
			await db()
				.prepare(
					`INSERT INTO notification_confirm_ledger (id, publisher_did, recipient_hash, sent_at_epoch_ms)
					 VALUES (?, ?, ?, ?)`,
				)
				.bind(`ncl_bulk_${i}`, did, `victimhash${i}`, nowMs)
				.run();
		}
		const email = uniq("victim") + "@example.test";
		const hash = await recipientHash(PEPPER, email);
		const sender = recordingSender();
		const sourceId = uniq("src");

		const outcome = await sendNotification(
			context(email, sender, () => new Date(nowMs)),
			request(did, sourceId),
		);

		expect(outcome).toEqual({ status: "rate_limited", recipientHash: hash, scope: "did" });
		expect(sender.confirmations).toHaveLength(0);
		expect(await rowsForSource(sourceId)).toHaveLength(0);
	});

	it("allows a confirmation when the DID is just below the cap", async () => {
		const did = uniq("did:plc:justunder");
		const nowMs = 6_000_000;
		for (let i = 0; i < CONFIRM_DID_MAX_DISTINCT_RECIPIENTS - 1; i++) {
			await db()
				.prepare(
					`INSERT INTO notification_confirm_ledger (id, publisher_did, recipient_hash, sent_at_epoch_ms)
					 VALUES (?, ?, ?, ?)`,
				)
				.bind(`ncl_under_${i}`, did, `underhash${i}`, nowMs)
				.run();
		}
		const email = uniq("under") + "@example.test";
		const sender = recordingSender();
		const sourceId = uniq("src");

		const outcome = await sendNotification(
			context(email, sender, () => new Date(nowMs)),
			request(did, sourceId),
		);

		expect(outcome.status).toBe("confirmation_sent");
		expect(sender.confirmations).toHaveLength(1);
		expect(await ledgerCount(did)).toBe(CONFIRM_DID_MAX_DISTINCT_RECIPIENTS);
	});
});

describe("declined / suppressed / no-contact", () => {
	it("sends nothing to a declined contact (never gates on seeded:true)", async () => {
		const email = uniq("declined") + "@example.test";
		const hash = await recipientHash(PEPPER, email);
		await ensureContact(db(), hash, "2026-07-16T00:00:00.000Z");
		await declineContact(db(), hash);
		const sender = recordingSender();
		const sourceId = uniq("src");

		const outcome = await sendNotification(context(email, sender), request("did:plc:a", sourceId));

		expect(outcome).toEqual({ status: "declined", recipientHash: hash });
		expect(sender.confirmations).toHaveLength(0);
		expect(sender.notices).toHaveLength(0);
		const rows = await rowsForSource(sourceId);
		expect(rows[0]).toMatchObject({
			kind: "notice",
			state: "undeliverable",
			last_error: "declined",
			recipient_hash: hash,
			plaintext_email: null,
		});
	});

	it("sends nothing to a suppressed contact and records undeliverable", async () => {
		const email = uniq("suppressed") + "@example.test";
		const hash = await recipientHash(PEPPER, email);
		await suppress(db(), hash, "unsubscribe", "2026-07-16T00:00:00.000Z", 1_000);
		const sender = recordingSender();
		const sourceId = uniq("src");

		const outcome = await sendNotification(context(email, sender), request("did:plc:a", sourceId));

		expect(outcome).toEqual({ status: "suppressed", recipientHash: hash });
		expect(sender.confirmations).toHaveLength(0);
		const rows = await rowsForSource(sourceId);
		expect(rows[0]).toMatchObject({ state: "undeliverable", last_error: "suppressed" });
	});

	it("records an undeliverable row with a null recipient hash when no contact resolves", async () => {
		const sender = recordingSender();
		const sourceId = uniq("src");

		const outcome = await sendNotification(context(null, sender), request("did:plc:a", sourceId));

		expect(outcome).toEqual({ status: "no_contact" });
		expect(sender.confirmations).toHaveLength(0);
		expect(sender.notices).toHaveLength(0);
		const rows = await rowsForSource(sourceId);
		expect(rows[0]).toMatchObject({
			kind: "notice",
			state: "undeliverable",
			recipient_hash: null,
			last_error: "no_email_contact",
		});
	});
});
