import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
	createR2MediaContentStore,
	purgeExpiredMediaQuarantine,
} from "../src/assessment/runtime-media.js";

const MEDIA_BYTES = new TextEncoder().encode("display media evidence");
const IDEMPOTENCY_KEY = "release-icon";
const CONTENT_ADDRESS = "sha256:display-media-evidence";

async function sha256Hex(bytes: Uint8Array): Promise<string> {
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
	return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function insertPendingClaim(objectKey: string, sha256: string): Promise<void> {
	await env.DB.prepare(
		`INSERT INTO media_quarantine_objects
		 (object_key, idempotency_key, sha256, byte_length, created_at, expires_at, ready)
		 VALUES (?, ?, ?, ?, ?, ?, 0)`,
	)
		.bind(
			objectKey,
			IDEMPOTENCY_KEY,
			sha256,
			MEDIA_BYTES.byteLength,
			"2026-08-25T00:00:00.000Z",
			"2026-09-01T00:00:00.000Z",
		)
		.run();
}

function mediaStoreInput(sha256: string) {
	return {
		idempotencyKey: IDEMPOTENCY_KEY,
		contentAddress: CONTENT_ADDRESS,
		subject: {
			uri: "at://did:plc:publisher/com.emdashcms.experimental.registry.release/example",
			cid: "bafyreig6v7w2f5w6e4h2a2wdd3z7imf7xosqg5rj2lup5xkqcz4rh6a5ke",
			kind: "release" as const,
		},
		descriptor: {
			kind: "icon" as const,
			index: 0,
			url: "https://media.example/icon.png",
			checksum: CONTENT_ADDRESS,
			contentType: "image/png",
			width: 1,
			height: 1,
		},
		bytes: MEDIA_BYTES,
		sha256,
		mimeType: "image/png",
		width: 1,
		height: 1,
		frames: 1,
		signal: new AbortController().signal,
		deadline: Date.now() + 10_000,
	};
}

beforeAll(async () => {
	await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
	const listed = await env.MEDIA_QUARANTINE.list();
	if (listed.objects.length > 0) {
		await env.MEDIA_QUARANTINE.delete(listed.objects.map(({ key }) => key));
	}
	await env.DB.prepare("DELETE FROM media_quarantine_objects").run();
});

describe("media quarantine retention", () => {
	it("deletes expired objects while preserving live evidence", async () => {
		await Promise.all([
			env.MEDIA_QUARANTINE.put("media/expired", new Uint8Array([1])),
			env.MEDIA_QUARANTINE.put("media/live", new Uint8Array([2])),
		]);
		await env.DB.batch([
			env.DB.prepare(
				`INSERT INTO media_quarantine_objects
				 (object_key, sha256, byte_length, created_at, expires_at)
				 VALUES ('media/expired', ?, 1, ?, ?)`,
			).bind("a".repeat(64), "2026-08-01T00:00:00.000Z", "2026-08-20T00:00:00.000Z"),
			env.DB.prepare(
				`INSERT INTO media_quarantine_objects
				 (object_key, sha256, byte_length, created_at, expires_at)
				 VALUES ('media/live', ?, 1, ?, ?)`,
			).bind("b".repeat(64), "2026-08-24T00:00:00.000Z", "2026-08-30T00:00:00.000Z"),
		]);

		await expect(
			purgeExpiredMediaQuarantine(
				env.DB,
				env.MEDIA_QUARANTINE,
				new Date("2026-08-25T00:00:00.000Z"),
			),
		).resolves.toEqual({ deleted: 1, remaining: false });
		expect(await env.MEDIA_QUARANTINE.head("media/expired")).toBeNull();
		expect(await env.MEDIA_QUARANTINE.head("media/live")).not.toBeNull();
		expect(
			await env.DB.prepare("SELECT COUNT(*) AS count FROM media_quarantine_objects").first<number>(
				"count",
			),
		).toBe(1);
	});

	it("reclaims an expired pending claim and its partial R2 object", async () => {
		const sha256 = await sha256Hex(MEDIA_BYTES);
		const objectKey = `media/${sha256}/00000000-0000-4000-8000-000000000003`;
		await env.MEDIA_QUARANTINE.put(objectKey, MEDIA_BYTES);
		await env.DB.prepare(
			`INSERT INTO media_quarantine_objects
			 (object_key, idempotency_key, sha256, byte_length, created_at, expires_at, ready)
			 VALUES (?, 'abandoned-pending', ?, ?, ?, ?, 0)`,
		)
			.bind(
				objectKey,
				sha256,
				MEDIA_BYTES.byteLength,
				"2026-08-01T00:00:00.000Z",
				"2026-08-20T00:00:00.000Z",
			)
			.run();

		await expect(
			purgeExpiredMediaQuarantine(
				env.DB,
				env.MEDIA_QUARANTINE,
				new Date("2026-08-25T00:00:00.000Z"),
			),
		).resolves.toEqual({ deleted: 1, remaining: false });
		expect(await env.MEDIA_QUARANTINE.head(objectKey)).toBeNull();
		expect(
			await env.DB.prepare("SELECT object_key FROM media_quarantine_objects WHERE object_key = ?")
				.bind(objectKey)
				.first(),
		).toBeNull();
	});

	it("does not purge an expired pending claim with an active recovery lease", async () => {
		const sha256 = await sha256Hex(MEDIA_BYTES);
		const objectKey = `media/${sha256}/00000000-0000-4000-8000-000000000004`;
		await env.MEDIA_QUARANTINE.put(objectKey, MEDIA_BYTES);
		await env.DB.prepare(
			`INSERT INTO media_quarantine_objects
			 (object_key, idempotency_key, sha256, byte_length, created_at, expires_at,
			  ready, lease_token, lease_expires_at)
			 VALUES (?, 'active-pending', ?, ?, ?, ?, 0, 'writer', ?)`,
		)
			.bind(
				objectKey,
				sha256,
				MEDIA_BYTES.byteLength,
				"2026-08-01T00:00:00.000Z",
				"2026-08-20T00:00:00.000Z",
				"2026-08-25T00:05:00.000Z",
			)
			.run();

		await expect(
			purgeExpiredMediaQuarantine(
				env.DB,
				env.MEDIA_QUARANTINE,
				new Date("2026-08-25T00:00:00.000Z"),
			),
		).resolves.toEqual({ deleted: 0, remaining: true });
		expect(await env.MEDIA_QUARANTINE.head(objectKey)).not.toBeNull();
	});
});

describe("media quarantine write recovery", () => {
	it("repairs and renews a ready claim whose R2 object disappeared", async () => {
		const sha256 = await sha256Hex(MEDIA_BYTES);
		const store = createR2MediaContentStore(env.MEDIA_QUARANTINE, env.DB);
		const first = await store.put(mediaStoreInput(sha256));
		const objectKey = first.contentRef.slice("r2://quarantine/".length);
		await env.MEDIA_QUARANTINE.delete(objectKey);
		await env.DB.prepare("UPDATE media_quarantine_objects SET expires_at = ? WHERE object_key = ?")
			.bind("2026-08-25T00:00:00.000Z", objectKey)
			.run();

		await expect(store.put(mediaStoreInput(sha256))).resolves.toEqual(first);
		expect(await env.MEDIA_QUARANTINE.get(objectKey).then((object) => object?.bytes())).toEqual(
			MEDIA_BYTES,
		);
		const expiry = await env.DB.prepare(
			"SELECT expires_at FROM media_quarantine_objects WHERE object_key = ?",
		)
			.bind(objectKey)
			.first<string>("expires_at");
		expect(Date.parse(expiry!)).toBeGreaterThan(Date.now());
	});

	it("does not purge an expired ready claim while an access lease is active", async () => {
		const sha256 = await sha256Hex(MEDIA_BYTES);
		const objectKey = `media/${sha256}/00000000-0000-4000-8000-000000000005`;
		await env.MEDIA_QUARANTINE.put(objectKey, MEDIA_BYTES);
		await env.DB.prepare(
			`INSERT INTO media_quarantine_objects
			 (object_key, idempotency_key, sha256, byte_length, created_at, expires_at,
			  ready, lease_token, lease_expires_at)
			 VALUES (?, 'active-ready', ?, ?, ?, ?, 1, 'reader', ?)`,
		)
			.bind(
				objectKey,
				sha256,
				MEDIA_BYTES.byteLength,
				"2026-08-01T00:00:00.000Z",
				"2026-08-20T00:00:00.000Z",
				"2026-08-25T00:05:00.000Z",
			)
			.run();

		await expect(
			purgeExpiredMediaQuarantine(
				env.DB,
				env.MEDIA_QUARANTINE,
				new Date("2026-08-25T00:00:00.000Z"),
			),
		).resolves.toEqual({ deleted: 0, remaining: true });
		expect(await env.MEDIA_QUARANTINE.head(objectKey)).not.toBeNull();
	});

	it("resumes the claimed object key after a crash before the R2 write", async () => {
		const sha256 = await sha256Hex(MEDIA_BYTES);
		const objectKey = `media/${sha256}/00000000-0000-4000-8000-000000000001`;
		await insertPendingClaim(objectKey, sha256);

		const stored = await createR2MediaContentStore(env.MEDIA_QUARANTINE, env.DB).put(
			mediaStoreInput(sha256),
		);

		expect(stored).toEqual({
			contentRef: `r2://quarantine/${objectKey}`,
			contentAddress: CONTENT_ADDRESS,
		});
		expect(await env.MEDIA_QUARANTINE.get(objectKey).then((object) => object?.bytes())).toEqual(
			MEDIA_BYTES,
		);
		expect(
			await env.DB.prepare(
				"SELECT object_key, ready FROM media_quarantine_objects WHERE idempotency_key = ?",
			)
				.bind(IDEMPOTENCY_KEY)
				.first(),
		).toEqual({ object_key: objectKey, ready: 1 });
	});

	it("finalizes the claimed object key after a crash following the R2 write", async () => {
		const sha256 = await sha256Hex(MEDIA_BYTES);
		const objectKey = `media/${sha256}/00000000-0000-4000-8000-000000000002`;
		await insertPendingClaim(objectKey, sha256);
		await env.MEDIA_QUARANTINE.put(objectKey, MEDIA_BYTES, {
			httpMetadata: { contentType: "image/png" },
			customMetadata: { sha256, width: "1", height: "1", frames: "1" },
			sha256: Uint8Array.from({ length: 32 }, (_, index) =>
				Number.parseInt(sha256.slice(index * 2, index * 2 + 2), 16),
			),
		});
		const writtenVersion = (await env.MEDIA_QUARANTINE.head(objectKey))?.version;

		const stored = await createR2MediaContentStore(env.MEDIA_QUARANTINE, env.DB).put(
			mediaStoreInput(sha256),
		);

		expect(stored.contentRef).toBe(`r2://quarantine/${objectKey}`);
		expect((await env.MEDIA_QUARANTINE.head(objectKey))?.version).toBe(writtenVersion);
		expect(
			await env.DB.prepare(
				"SELECT object_key, ready FROM media_quarantine_objects WHERE idempotency_key = ?",
			)
				.bind(IDEMPOTENCY_KEY)
				.first(),
		).toEqual({ object_key: objectKey, ready: 1 });
	});
});
