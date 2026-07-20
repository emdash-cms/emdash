import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import { operatorTriggerId } from "../src/assessment-lifecycle.js";
import {
	buildOperatorActionInsert,
	computeRequestFingerprint,
	getOperatorActionByKey,
	isIdempotencyKeyConflict,
	type OperatorActionInsert,
	type StoredOperatorAction,
} from "../src/operator-actions.js";

interface TestEnv {
	DB: D1Database;
	TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
}

const testEnv = env as unknown as TestEnv;

beforeAll(async () => {
	await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
});

let counter = 0;

function insertInput(overrides: Partial<OperatorActionInsert> = {}): OperatorActionInsert {
	counter++;
	const now = new Date("2026-07-12T00:00:00.000Z");
	return {
		id: `oact_test${counter}`,
		actorType: "human",
		actorId: "user-sub-1",
		actorEmail: "admin@example.com",
		actorCommonName: null,
		role: "admin",
		action: "label-issue",
		subjectUri: "at://did:plc:x/com.emdashcms.experimental.package.release/pkg:1.0.0",
		subjectCid: "bafkreicid00000000000000000000000000000000000000000",
		labelValue: "security-yanked",
		reason: "malware in postinstall",
		idempotencyKey: `key-${counter}-abcdefgh`,
		requestFingerprint: `fp-${counter}`,
		resultJson: JSON.stringify({ ok: true }),
		metadataJson: "{}",
		createdAt: now.toISOString(),
		createdAtEpochMs: now.getTime(),
		...overrides,
	};
}

describe("operator_actions store", () => {
	it("inserts and reads back every audit column", async () => {
		const input = insertInput();
		await buildOperatorActionInsert(testEnv.DB, input).run();

		const stored = await getOperatorActionByKey(testEnv.DB, input.idempotencyKey);
		expect(stored).toEqual<StoredOperatorAction>({
			id: input.id,
			actorType: "human",
			actorId: input.actorId,
			actorEmail: input.actorEmail,
			actorCommonName: null,
			role: "admin",
			action: input.action,
			subjectUri: input.subjectUri,
			subjectCid: input.subjectCid,
			labelValue: input.labelValue,
			reason: input.reason,
			idempotencyKey: input.idempotencyKey,
			requestFingerprint: input.requestFingerprint,
			resultJson: input.resultJson,
			metadataJson: input.metadataJson,
			createdAt: input.createdAt,
			createdAtEpochMs: input.createdAtEpochMs,
		});
		expect(operatorTriggerId(stored!.id)).toBe(`operator:${input.id}`);
	});

	it("records a service actor with a common name and no email", async () => {
		const input = insertInput({
			actorType: "service",
			actorEmail: null,
			actorCommonName: "ci-automation",
			role: "reviewer",
		});
		await buildOperatorActionInsert(testEnv.DB, input).run();

		const stored = await getOperatorActionByKey(testEnv.DB, input.idempotencyKey);
		expect(stored!.actorType).toBe("service");
		expect(stored!.actorCommonName).toBe("ci-automation");
		expect(stored!.actorEmail).toBeNull();
	});

	it("persists a subject-less action with NULL subject columns", async () => {
		const input = insertInput({
			action: "pause-issuance",
			subjectUri: null,
			subjectCid: null,
			labelValue: null,
		});
		await buildOperatorActionInsert(testEnv.DB, input).run();

		const stored = await getOperatorActionByKey(testEnv.DB, input.idempotencyKey);
		expect(stored!.action).toBe("pause-issuance");
		expect(stored!.subjectUri).toBeNull();
		expect(stored!.subjectCid).toBeNull();
		expect(stored!.labelValue).toBeNull();
	});

	it("rejects UPDATE on a recorded action (immutable log)", async () => {
		const input = insertInput();
		await buildOperatorActionInsert(testEnv.DB, input).run();

		await expect(
			testEnv.DB.prepare("UPDATE operator_actions SET reason = 'tampered' WHERE id = ?")
				.bind(input.id)
				.run(),
		).rejects.toThrow(/immutable/);
	});

	it("rejects DELETE on a recorded action (immutable log)", async () => {
		const input = insertInput();
		await buildOperatorActionInsert(testEnv.DB, input).run();

		await expect(
			testEnv.DB.prepare("DELETE FROM operator_actions WHERE id = ?").bind(input.id).run(),
		).rejects.toThrow(/immutable/);
	});

	it("rejects a duplicate idempotency key with a detectable UNIQUE violation", async () => {
		const first = insertInput();
		await buildOperatorActionInsert(testEnv.DB, first).run();

		const second = insertInput({
			id: "oact_second",
			idempotencyKey: first.idempotencyKey,
			reason: "different reason",
			requestFingerprint: "fp-conflicting",
		});

		let caught: unknown;
		try {
			await buildOperatorActionInsert(testEnv.DB, second).run();
		} catch (error) {
			caught = error;
		}
		expect(isIdempotencyKeyConflict(caught)).toBe(true);

		// The first row is untouched — the conflicting insert never applied.
		const stored = await getOperatorActionByKey(testEnv.DB, first.idempotencyKey);
		expect(stored!.id).toBe(first.id);
		expect(stored!.reason).toBe(first.reason);
		expect(stored!.requestFingerprint).toBe(first.requestFingerprint);
	});

	it("does not flag a primary-key conflict or an unrelated error as a key conflict", async () => {
		const first = insertInput();
		await buildOperatorActionInsert(testEnv.DB, first).run();

		let pkError: unknown;
		try {
			// Reused `id`, fresh idempotency key: this is a PRIMARY KEY conflict on
			// `id`, which must NOT be mistaken for the idempotency-key conflict.
			await buildOperatorActionInsert(testEnv.DB, insertInput({ id: first.id })).run();
		} catch (error) {
			pkError = error;
		}
		expect(pkError).toBeInstanceOf(Error);
		expect(isIdempotencyKeyConflict(pkError)).toBe(false);
		expect(isIdempotencyKeyConflict(new Error("some other failure"))).toBe(false);
		expect(isIdempotencyKeyConflict(null)).toBe(false);
	});

	it("returns null for an unknown idempotency key", async () => {
		expect(await getOperatorActionByKey(testEnv.DB, "no-such-key-abcdefgh")).toBeNull();
	});
});

describe("computeRequestFingerprint", () => {
	it("is stable under top-level key reordering", async () => {
		const a = await computeRequestFingerprint("label-issue", {
			subjectUri: "u",
			labelValue: "v",
			reason: "r",
		});
		const b = await computeRequestFingerprint("label-issue", {
			reason: "r",
			labelValue: "v",
			subjectUri: "u",
		});
		expect(a).toBe(b);
	});

	it("is stable under nested key reordering", async () => {
		const a = await computeRequestFingerprint("label-issue", {
			reason: "r",
			metadata: { alpha: 1, beta: 2 },
		});
		const b = await computeRequestFingerprint("label-issue", {
			metadata: { beta: 2, alpha: 1 },
			reason: "r",
		});
		expect(a).toBe(b);
	});

	it("ignores the idempotency key", async () => {
		const a = await computeRequestFingerprint("label-issue", {
			reason: "r",
			idempotencyKey: "key-one-abcdefgh",
		});
		const b = await computeRequestFingerprint("label-issue", {
			reason: "r",
			idempotencyKey: "key-two-abcdefgh",
		});
		expect(a).toBe(b);
	});

	it("changes when the action changes", async () => {
		const a = await computeRequestFingerprint("label-issue", { reason: "r" });
		const b = await computeRequestFingerprint("label-retract", { reason: "r" });
		expect(a).not.toBe(b);
	});

	it("changes when any material field changes", async () => {
		const base = await computeRequestFingerprint("label-issue", { reason: "r", labelValue: "v" });
		expect(
			await computeRequestFingerprint("label-issue", { reason: "r", labelValue: "w" }),
		).not.toBe(base);
		expect(
			await computeRequestFingerprint("label-issue", { reason: "s", labelValue: "v" }),
		).not.toBe(base);
	});
});
