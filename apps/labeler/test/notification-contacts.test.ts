import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import {
	canSendConfirm,
	confirmContact,
	type ContactState,
	declineContact,
	ensureContact,
	generateConfirmToken,
	getContactState,
	hashConfirmToken,
	isSuppressed,
	recipientHash,
	recordConfirmSent,
	suppress,
} from "../src/notification-contacts.js";

interface TestEnv {
	DB: D1Database;
	TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
}

const testEnv = env as unknown as TestEnv;
const db = () => testEnv.DB;

const PEPPER = "pepper-one";
let hashCounter = 0;

/** A distinct recipient hash per test, so rows never collide across cases. */
async function freshHash(): Promise<string> {
	hashCounter++;
	return recipientHash(PEPPER, `person-${hashCounter}@example.test`);
}

beforeAll(async () => {
	await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
});

describe("recipientHash", () => {
	it("emits lowercase hex of the HMAC-SHA256 digest (64 chars)", async () => {
		const hash = await recipientHash(PEPPER, "user@example.test");
		expect(hash).toMatch(/^[0-9a-f]{64}$/);
	});

	it("is deterministic for the same pepper and address", async () => {
		const a = await recipientHash(PEPPER, "user@example.test");
		const b = await recipientHash(PEPPER, "user@example.test");
		expect(a).toBe(b);
	});

	it("collapses case and surrounding whitespace", async () => {
		const canonical = await recipientHash(PEPPER, "user@example.test");
		expect(await recipientHash(PEPPER, "USER@Example.TEST")).toBe(canonical);
		expect(await recipientHash(PEPPER, "  user@example.test  ")).toBe(canonical);
		expect(await recipientHash(PEPPER, "\tUser@Example.Test\n")).toBe(canonical);
	});

	it("does not fold provider-specific address variants", async () => {
		const plain = await recipientHash(PEPPER, "user@example.test");
		expect(await recipientHash(PEPPER, "u.s.e.r@example.test")).not.toBe(plain);
		expect(await recipientHash(PEPPER, "user+tag@example.test")).not.toBe(plain);
	});

	it("changes with the pepper", async () => {
		const a = await recipientHash(PEPPER, "user@example.test");
		const b = await recipientHash("pepper-two", "user@example.test");
		expect(a).not.toBe(b);
	});
});

describe("contact lifecycle", () => {
	it("ensureContact inserts an unconfirmed row and is idempotent", async () => {
		const hash = await freshHash();
		await ensureContact(db(), hash, "2026-07-16T00:00:00.000Z");
		const first = await getContactState(db(), hash);
		expect(first).toMatchObject({
			recipientHash: hash,
			confirmState: "unconfirmed",
			confirmTokenHash: null,
			firstSeenAt: "2026-07-16T00:00:00.000Z",
			confirmedAt: null,
			lastConfirmSentAtEpochMs: null,
		});

		await ensureContact(db(), hash, "2026-07-16T01:00:00.000Z");
		const second = await getContactState(db(), hash);
		expect(second?.firstSeenAt).toBe("2026-07-16T00:00:00.000Z");
	});

	it("getContactState returns null for an unknown recipient", async () => {
		expect(await getContactState(db(), await freshHash())).toBeNull();
	});

	it("recordConfirmSent stores the token hash and send time on an unconfirmed contact", async () => {
		const hash = await freshHash();
		await ensureContact(db(), hash, "2026-07-16T00:00:00.000Z");
		expect(await recordConfirmSent(db(), hash, "tokenhash-aaa", 1_000)).toBe(true);
		const state = await getContactState(db(), hash);
		expect(state?.confirmTokenHash).toBe("tokenhash-aaa");
		expect(state?.lastConfirmSentAtEpochMs).toBe(1_000);
		expect(state?.confirmState).toBe("unconfirmed");
	});

	it("recordConfirmSent is a no-op on a confirmed or declined contact", async () => {
		const confirmed = await freshHash();
		await ensureContact(db(), confirmed, "2026-07-16T00:00:00.000Z");
		await recordConfirmSent(db(), confirmed, "tokenhash-c", 1_000);
		await confirmContact(db(), confirmed, "tokenhash-c", "2026-07-16T02:00:00.000Z");
		expect(await recordConfirmSent(db(), confirmed, "tokenhash-reopen", 5_000)).toBe(false);
		const confirmedState = await getContactState(db(), confirmed);
		expect(confirmedState?.confirmState).toBe("confirmed");
		expect(confirmedState?.confirmTokenHash).toBeNull();
		expect(confirmedState?.lastConfirmSentAtEpochMs).toBe(1_000);

		const declined = await freshHash();
		await ensureContact(db(), declined, "2026-07-16T00:00:00.000Z");
		await declineContact(db(), declined);
		expect(await recordConfirmSent(db(), declined, "tokenhash-reopen", 5_000)).toBe(false);
		const declinedState = await getContactState(db(), declined);
		expect(declinedState?.confirmState).toBe("declined");
		expect(declinedState?.confirmTokenHash).toBeNull();
	});

	it("confirmContact flips to confirmed on a token match and clears the token", async () => {
		const hash = await freshHash();
		await ensureContact(db(), hash, "2026-07-16T00:00:00.000Z");
		await recordConfirmSent(db(), hash, "tokenhash-match", 1_000);

		const ok = await confirmContact(db(), hash, "tokenhash-match", "2026-07-16T02:00:00.000Z");
		expect(ok).toBe(true);

		const state = await getContactState(db(), hash);
		expect(state?.confirmState).toBe("confirmed");
		expect(state?.confirmTokenHash).toBeNull();
		expect(state?.confirmedAt).toBe("2026-07-16T02:00:00.000Z");
	});

	it("confirmContact rejects a wrong token and leaves state untouched", async () => {
		const hash = await freshHash();
		await ensureContact(db(), hash, "2026-07-16T00:00:00.000Z");
		await recordConfirmSent(db(), hash, "tokenhash-real", 1_000);

		const ok = await confirmContact(db(), hash, "tokenhash-wrong", "2026-07-16T02:00:00.000Z");
		expect(ok).toBe(false);

		const state = await getContactState(db(), hash);
		expect(state?.confirmState).toBe("unconfirmed");
		expect(state?.confirmTokenHash).toBe("tokenhash-real");
		expect(state?.confirmedAt).toBeNull();
	});

	it("confirmContact tokens are single-use", async () => {
		const hash = await freshHash();
		await ensureContact(db(), hash, "2026-07-16T00:00:00.000Z");
		await recordConfirmSent(db(), hash, "tokenhash-once", 1_000);

		expect(await confirmContact(db(), hash, "tokenhash-once", "2026-07-16T02:00:00.000Z")).toBe(
			true,
		);
		expect(await confirmContact(db(), hash, "tokenhash-once", "2026-07-16T03:00:00.000Z")).toBe(
			false,
		);

		const state = await getContactState(db(), hash);
		expect(state?.confirmedAt).toBe("2026-07-16T02:00:00.000Z");
	});

	it("confirmContact on an unknown recipient returns false", async () => {
		expect(
			await confirmContact(db(), await freshHash(), "tokenhash-any", "2026-07-16T02:00:00.000Z"),
		).toBe(false);
	});

	it("a matching token cannot flip a declined or confirmed row (state guard)", async () => {
		// A lingering token on a non-unconfirmed row can only arise from a bug or
		// race; the UPDATE's state guard must still refuse it. Seed the state
		// directly so the guard — not the token-clearing path — is what's tested.
		for (const state of ["declined", "confirmed"] as const) {
			const hash = await freshHash();
			await db()
				.prepare(
					`INSERT INTO notification_contacts
					 (recipient_hash, confirm_state, confirm_token_hash, first_seen_at)
					 VALUES (?, ?, 'tokenhash-stale', '2026-07-16T00:00:00.000Z')`,
				)
				.bind(hash, state)
				.run();

			expect(await confirmContact(db(), hash, "tokenhash-stale", "2026-07-16T02:00:00.000Z")).toBe(
				false,
			);
			const after = await getContactState(db(), hash);
			expect(after?.confirmState).toBe(state);
			expect(after?.confirmedAt).toBeNull();
		}
	});

	it("declineContact marks an unconfirmed contact declined and clears the token", async () => {
		const hash = await freshHash();
		await ensureContact(db(), hash, "2026-07-16T00:00:00.000Z");
		await recordConfirmSent(db(), hash, "tokenhash-decl", 1_000);

		expect(await declineContact(db(), hash)).toBe(true);
		const state = await getContactState(db(), hash);
		expect(state?.confirmState).toBe("declined");
		expect(state?.confirmTokenHash).toBeNull();
	});

	it("declineContact refuses to revoke a confirmed opt-in", async () => {
		const hash = await freshHash();
		await ensureContact(db(), hash, "2026-07-16T00:00:00.000Z");
		await recordConfirmSent(db(), hash, "tokenhash-conf", 1_000);
		await confirmContact(db(), hash, "tokenhash-conf", "2026-07-16T02:00:00.000Z");

		expect(await declineContact(db(), hash)).toBe(false);
		const state = await getContactState(db(), hash);
		expect(state?.confirmState).toBe("confirmed");
		expect(state?.confirmedAt).toBe("2026-07-16T02:00:00.000Z");
	});

	it("declineContact on an unknown recipient returns false", async () => {
		expect(await declineContact(db(), await freshHash())).toBe(false);
	});

	it("recordConfirmSent rejects a non-finite epochMs", async () => {
		const hash = await freshHash();
		await ensureContact(db(), hash, "2026-07-16T00:00:00.000Z");
		await expect(recordConfirmSent(db(), hash, "tokenhash-nan", NaN)).rejects.toThrow(TypeError);
		const state = await getContactState(db(), hash);
		expect(state?.confirmTokenHash).toBeNull();
		expect(state?.lastConfirmSentAtEpochMs).toBeNull();
	});

	it("confirmContact returns false when the row exists but carries no token", async () => {
		const hash = await freshHash();
		await ensureContact(db(), hash, "2026-07-16T00:00:00.000Z");
		expect(await confirmContact(db(), hash, "tokenhash-anything", "2026-07-16T02:00:00.000Z")).toBe(
			false,
		);
		const state = await getContactState(db(), hash);
		expect(state?.confirmState).toBe("unconfirmed");
	});
});

describe("suppressions", () => {
	it("isSuppressed is false until an address is suppressed", async () => {
		const hash = await freshHash();
		expect(await isSuppressed(db(), hash)).toBe(false);
		await suppress(db(), hash, "bounce", "2026-07-16T00:00:00.000Z", 1_752_624_000_000);
		expect(await isSuppressed(db(), hash)).toBe(true);
	});

	it("keeps the earliest reason on repeated suppression", async () => {
		const hash = await freshHash();
		await suppress(db(), hash, "unsubscribe", "2026-07-16T00:00:00.000Z", 1_752_624_000_000);
		await suppress(db(), hash, "complaint", "2026-07-16T05:00:00.000Z", 1_752_642_000_000);

		const row = await db()
			.prepare(
				`SELECT reason, created_at, created_at_epoch_ms
				 FROM notification_suppressions WHERE recipient_hash = ?`,
			)
			.bind(hash)
			.first<{ reason: string; created_at: string; created_at_epoch_ms: number }>();
		expect(row?.reason).toBe("unsubscribe");
		expect(row?.created_at).toBe("2026-07-16T00:00:00.000Z");
		expect(row?.created_at_epoch_ms).toBe(1_752_624_000_000);
	});

	it("rejects a non-finite epochMs", async () => {
		const hash = await freshHash();
		await expect(suppress(db(), hash, "bounce", "2026-07-16T00:00:00.000Z", NaN)).rejects.toThrow(
			TypeError,
		);
		expect(await isSuppressed(db(), hash)).toBe(false);
	});
});

describe("canSendConfirm", () => {
	const unconfirmed = (lastSent: number | null): ContactState => ({
		recipientHash: "h",
		confirmState: "unconfirmed",
		confirmTokenHash: null,
		firstSeenAt: "2026-07-16T00:00:00.000Z",
		confirmedAt: null,
		lastConfirmSentAtEpochMs: lastSent,
	});

	it("allows a never-seen contact", () => {
		expect(canSendConfirm(null, 10_000, 1_000)).toBe(true);
	});

	it("allows an unconfirmed contact that has never been sent to", () => {
		expect(canSendConfirm(unconfirmed(null), 10_000, 1_000)).toBe(true);
	});

	it("blocks before the interval elapses and allows exactly at the boundary", () => {
		expect(canSendConfirm(unconfirmed(10_000), 10_999, 1_000)).toBe(false);
		expect(canSendConfirm(unconfirmed(10_000), 11_000, 1_000)).toBe(true);
		expect(canSendConfirm(unconfirmed(10_000), 11_001, 1_000)).toBe(true);
	});

	it("never sends a confirmation to a confirmed or declined contact", () => {
		expect(canSendConfirm({ ...unconfirmed(null), confirmState: "confirmed" }, 10_000, 1_000)).toBe(
			false,
		);
		expect(canSendConfirm({ ...unconfirmed(null), confirmState: "declined" }, 10_000, 1_000)).toBe(
			false,
		);
	});
});

describe("generateConfirmToken", () => {
	it("emits base64url with at least 128 bits of entropy", () => {
		const token = generateConfirmToken();
		expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
		// base64url has no padding; >=22 chars is >=128 bits, and this token is 32 bytes.
		expect(token.length).toBeGreaterThanOrEqual(22);
		expect(token).not.toContain("=");
	});

	it("is unique across draws (CSPRNG, not monotonic)", () => {
		const tokens = new Set(Array.from({ length: 500 }, () => generateConfirmToken()));
		expect(tokens.size).toBe(500);
	});

	it("survives the confirm round-trip: the send-path hash confirms against the endpoint re-hash", async () => {
		const hash = await freshHash();
		const token = generateConfirmToken();
		await ensureContact(db(), hash, "2026-07-16T00:00:00.000Z");
		// Send path stores SHA-256(token); the raw token travels in the link.
		await recordConfirmSent(db(), hash, await hashConfirmToken(token), 1_000);
		// Confirm endpoint re-hashes the raw token from the link before comparing.
		const presentedHash = await hashConfirmToken(token);
		expect(await confirmContact(db(), hash, presentedHash, "2026-07-16T02:00:00.000Z")).toBe(true);
	});
});

describe("schema", () => {
	it("stores no plaintext email column on either table", async () => {
		const contactColumns = await columnNames("notification_contacts");
		expect(contactColumns).toEqual([
			"recipient_hash",
			"confirm_state",
			"confirm_token_hash",
			"first_seen_at",
			"confirmed_at",
			"last_confirm_sent_at_epoch_ms",
		]);

		const suppressionColumns = await columnNames("notification_suppressions");
		expect(suppressionColumns).toEqual([
			"recipient_hash",
			"reason",
			"created_at",
			"created_at_epoch_ms",
		]);

		for (const column of [...contactColumns, ...suppressionColumns]) {
			expect(column).not.toMatch(/email|address|plaintext/i);
		}
	});
});

async function columnNames(
	table: "notification_contacts" | "notification_suppressions",
): Promise<string[]> {
	// PRAGMA cannot parameterize the table name; allowlist the identifier before
	// interpolating.
	const allowed = new Set(["notification_contacts", "notification_suppressions"]);
	if (!allowed.has(table)) throw new TypeError(`invalid table identifier: ${table}`);
	const result = await db().prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
	return result.results.map((row) => row.name);
}
