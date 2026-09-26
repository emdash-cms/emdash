import { abortAllDurableObjects, reset, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AccessActor } from "../src/access/auth.js";
import {
	handleAbortPublisherRestore,
	handleArchivePublisher,
	handlePreparePublisherRestore,
	handleRestorePublisher,
} from "../src/backup/routes.js";
import { loadConfiguration } from "../src/config.js";
import { SERVICE_CONTROL_OBJECT_NAME } from "../src/control-do/service-control-do.js";
import { TEST_BINDINGS } from "./fixtures/oauth.js";

const PUBLISHER_DID = "did:web:publisher.example.com";
const INTENT_ID = "01JABCDEFGHJKMNPQRSTVWXYZ0";
const ARCHIVE_ID = "publisher-archive-0001";
const NOW = 1_800_000_000_000;
const ADMIN: AccessActor = {
	realm: "access",
	identity: "admin@example.com",
	email: "admin@example.com",
	role: "admin",
};

function request(cursor: string | null, page: number, archiveId = ARCHIVE_ID): Request {
	return new Request(`${TEST_BINDINGS.PUBLIC_ORIGIN}/admin/api/publishers/archive`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"idempotency-key": `publisher-archive-page-${page}`,
		},
		body: JSON.stringify({ archiveId, cursor, page }),
	});
}

function restoreRequest(page: number): Request {
	return new Request(`${TEST_BINDINGS.PUBLIC_ORIGIN}/admin/api/publishers/restore`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"idempotency-key": `publisher-restore-page-${page}`,
		},
		body: JSON.stringify({ archiveId: ARCHIVE_ID, page }),
	});
}

function prepareRestoreRequest(): Request {
	return new Request(`${TEST_BINDINGS.PUBLIC_ORIGIN}/admin/api/publishers/restore/prepare`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"idempotency-key": "publisher-restore-prepare-0001",
		},
		body: JSON.stringify({ archiveId: ARCHIVE_ID, confirmPublisherDid: PUBLISHER_DID }),
	});
}

function abortRestoreRequest(): Request {
	return new Request(`${TEST_BINDINGS.PUBLIC_ORIGIN}/admin/api/publishers/restore/abort`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"idempotency-key": "publisher-restore-abort-0001",
		},
		body: JSON.stringify({ archiveId: ARCHIVE_ID, confirmPublisherDid: PUBLISHER_DID }),
	});
}

function maximalCanonicalObject(maxChars: number): string {
	const empty = JSON.stringify({ value: "" });
	return JSON.stringify({ value: "\\".repeat(Math.floor((maxChars - empty.length) / 2)) });
}

afterEach(async () => {
	vi.restoreAllMocks();
	await reset();
});

describe("publisher operations archive", () => {
	it("rejects an oversized conflicting snapshot without reading its body", async () => {
		const configuration = await loadConfiguration(TEST_BINDINGS);
		const text = vi.fn(async () => {
			throw new Error("oversized body must not be read");
		});
		// @ts-expect-error - conditional R2 writes return null when the precondition fails
		vi.spyOn(env.OPERATIONS_ARCHIVE, "put").mockResolvedValue(null);
		vi.spyOn(env.OPERATIONS_ARCHIVE, "get").mockResolvedValue({
			size: 1_500_001,
			text,
		} as unknown as R2ObjectBody);

		const response = await handleArchivePublisher(
			request(null, 0),
			"oversized-conflict",
			configuration,
			{ publisherDid: PUBLISHER_DID },
			ADMIN,
		);

		expect(response.status).toBe(409);
		expect(text).not.toHaveBeenCalled();
	});

	it("writes resumable encrypted snapshots and append-only sanitized audit pages", async () => {
		const configuration = await loadConfiguration(TEST_BINDINGS);
		const publisher = env.PUBLISHER_DO.getByName(PUBLISHER_DID);
		await publisher.putWorkloadPolicy({
			publisherDid: PUBLISHER_DID,
			packageSlug: "gallery",
			repository: "example/gallery",
			repositoryId: "123",
			repositoryOwnerId: "456",
			workflowRef: "example/gallery/.github/workflows/release.yml@refs/heads/main",
			allowedRefs: ["refs/heads/main"],
			allowedEnvironments: [],
			active: true,
			expectedVersion: null,
			now: NOW,
		});
		await publisher.createIntent({
			publisherDid: PUBLISHER_DID,
			intentId: INTENT_ID,
			packageSlug: "gallery",
			version: "1.2.3",
			workloadPolicyVersion: 1,
			workloadIdentityDigest: "A".repeat(43),
			workloadIdempotencyDigest: "I".repeat(43),
			idempotencyKey: "github-run-100-attempt-1",
			requestDigest: "B".repeat(43),
			workloadIdentityJson: '{"issuer":"github-actions","private":"repository-metadata"}',
			releaseInputJson: '{"release":{"package":"gallery","version":"1.2.3"}}',
			expiresAt: NOW + 60_000,
			now: NOW + 1,
		});
		await publisher.putDelegation({
			publisherDid: PUBLISHER_DID,
			releaseNsid: configuration.oauth.releaseNsid,
			scope: configuration.oauth.releaseScope,
			clientKeyId: configuration.oauth.activeAssertionKeyId,
			encryptedSession: "retained-authority-ciphertext",
			encryptionKeyVersion: 1,
			issuer: "https://authorization.example.com",
			pdsUrl: "https://pds.example.com",
			expiresAt: null,
			refreshBefore: null,
			expectedVersion: null,
		});

		let cursor: string | null = null;
		let page = 0;
		const responses: Array<Record<string, unknown>> = [];
		do {
			const response = await handleArchivePublisher(
				request(cursor, page),
				`request-${page}`,
				configuration,
				{ publisherDid: PUBLISHER_DID },
				ADMIN,
			);
			expect(response.status).toBe(200);
			const body = await response.json<{ data: Record<string, unknown> }>();
			responses.push(body.data);
			cursor = typeof body.data["nextCursor"] === "string" ? body.data["nextCursor"] : null;
			page = Number(body.data["nextPage"]);
		} while (cursor !== null);

		expect(responses.map((item) => item["kind"])).toEqual([
			"metadata",
			"workload-policies",
			"intents",
			"audit-events",
		]);
		expect(responses.at(-1)).toMatchObject({ complete: true, manifestWritten: true });
		const snapshots = await env.OPERATIONS_ARCHIVE.list({ prefix: "snapshots/" });
		expect(snapshots.objects).toHaveLength(5);
		for (const object of snapshots.objects) {
			const stored = await env.OPERATIONS_ARCHIVE.get(object.key);
			const text = await stored!.text();
			expect(text.split(".")).toHaveLength(5);
			expect(text).not.toContain(PUBLISHER_DID);
			expect(text).not.toContain("retained-authority-ciphertext");
			expect(text).not.toContain("repository-metadata");
		}

		const ownerHash = String(responses[0]?.["ownerHash"]);
		const firstSnapshot = await env.OPERATIONS_ARCHIVE.get(
			`snapshots/${ownerHash}/${ARCHIVE_ID}/000000.json.jwe`,
		);
		const decrypted = await configuration.encryption.decrypt(await firstSnapshot!.text(), {
			purpose: "publisher-snapshot",
			objectClass: "PublisherDurableObject",
			table: "operations_archive",
			primaryKey: `${ARCHIVE_ID}:0`,
			ownerDid: PUBLISHER_DID,
		});
		const metadata = JSON.parse(new TextDecoder().decode(decrypted));
		expect(metadata).toMatchObject({
			kind: "metadata",
			publisherDid: PUBLISHER_DID,
			data: { delegation: { status: "active" } },
		});
		expect(JSON.stringify(metadata)).not.toContain("retained-authority-ciphertext");

		const audit = await env.OPERATIONS_ARCHIVE.list({ prefix: `audit/${ownerHash}/` });
		expect(audit.objects.length).toBeGreaterThan(0);
		for (const object of audit.objects) {
			const text = await (await env.OPERATIONS_ARCHIVE.get(object.key))!.text();
			expect(text).not.toContain(PUBLISHER_DID);
			expect(text).not.toContain(ADMIN.identity);
			expect(text).not.toContain("retained-authority-ciphertext");
			expect(text).not.toContain("repository-metadata");
			const parsed = JSON.parse(text) as Record<string, unknown>;
			expect(Object.keys(parsed).toSorted()).toEqual(["events", "version"]);
			expect(parsed["events"]).toEqual(expect.arrayContaining([{}]));
		}

		const replay = await handleArchivePublisher(
			request(null, 0),
			"request-replay",
			configuration,
			{ publisherDid: PUBLISHER_DID },
			ADMIN,
		);
		expect(replay.status).toBe(200);
		await expect(replay.json()).resolves.toMatchObject({ data: { replayed: true } });
		expect((await env.OPERATIONS_ARCHIVE.list({ prefix: "snapshots/" })).objects).toHaveLength(5);

		const notSuspended = await handleRestorePublisher(
			restoreRequest(0),
			"restore-not-suspended",
			configuration,
			{ publisherDid: PUBLISHER_DID },
			ADMIN,
		);
		expect(notSuspended.status).toBe(409);
		await env.SERVICE_CONTROL_DO.getByName(SERVICE_CONTROL_OBJECT_NAME).setPublisherControl({
			actor: ADMIN,
			idempotencyKey: "suspend-before-restore-0001",
			requestDigest: "R".repeat(43),
			publisherDid: PUBLISHER_DID,
			status: "suspended",
			reasonCode: "SHARD_RESTORE",
			now: NOW + 2,
		});
		const prepared = await handlePreparePublisherRestore(
			prepareRestoreRequest(),
			"restore-prepare",
			configuration,
			{ publisherDid: PUBLISHER_DID },
			ADMIN,
		);
		expect(prepared.status).toBe(200);
		await expect(prepared.json()).resolves.toMatchObject({
			data: { archiveId: ARCHIVE_ID, publisherDid: PUBLISHER_DID, prepared: true },
		});
		await abortAllDurableObjects();

		for (let restorePage = 0; restorePage < page; restorePage += 1) {
			const response = await handleRestorePublisher(
				restoreRequest(restorePage),
				`restore-${restorePage}`,
				configuration,
				{ publisherDid: PUBLISHER_DID },
				ADMIN,
			);
			expect(response.status, await response.clone().text()).toBe(200);
			await expect(response.json()).resolves.toMatchObject({
				data: {
					page: restorePage,
					nextPage: restorePage + 1,
					complete: restorePage === page - 1,
					authorityStatus: "reauthorization_required",
				},
			});
			if (restorePage === 0) {
				const prepareReplay = await handlePreparePublisherRestore(
					prepareRestoreRequest(),
					"restore-prepare-replay",
					configuration,
					{ publisherDid: PUBLISHER_DID },
					ADMIN,
				);
				expect(prepareReplay.status).toBe(200);
				await expect(prepareReplay.json()).resolves.toMatchObject({ data: { replayed: true } });
			}
		}
		const restored = env.PUBLISHER_DO.getByName(PUBLISHER_DID);
		await expect(restored.getOperationsMetadata(PUBLISHER_DID)).resolves.toMatchObject({
			publisher: { status: "suspended" },
			delegation: { status: "reauthorization_required" },
		});
		await expect(restored.getDelegation(PUBLISHER_DID)).resolves.toMatchObject({
			encryptedSession: "",
			encryptionKeyVersion: null,
			status: "reauthorization_required",
		});
		await expect(restored.getWorkloadPolicy(PUBLISHER_DID, "gallery")).resolves.toMatchObject({
			active: false,
		});
		await expect(restored.getIntent(PUBLISHER_DID, INTENT_ID)).resolves.toMatchObject({
			state: "failed",
			stateDataJson: '{"reasonCode":"SHARD_RESTORED_REVIEW_REQUIRED"}',
		});
		await expect(restored.listAuditEvents(PUBLISHER_DID, 0, 100)).resolves.toEqual(
			expect.arrayContaining([
				expect.objectContaining({ eventType: "publisher-restore-completed" }),
			]),
		);
	});

	it("keeps sanitized audit exports append-only when a restored history resets sequences", async () => {
		const configuration = await loadConfiguration(TEST_BINDINGS);
		const publisher = env.PUBLISHER_DO.getByName(PUBLISHER_DID);
		await publisher.getOperationsMetadata(PUBLISHER_DID);
		await runInDurableObject(publisher, (_instance, state) => {
			state.storage.sql.exec(
				`INSERT INTO audit_events (
					event_type, actor_realm, actor_identity, subject,
					reason_code, public_payload, created_at
				) VALUES
					('before-1', 'access', ?, ?, NULL, '{"history":"before"}', ?),
					('before-2', 'access', ?, ?, NULL, '{"history":"before"}', ?)`,
				ADMIN.identity,
				PUBLISHER_DID,
				NOW,
				ADMIN.identity,
				PUBLISHER_DID,
				NOW + 1,
			);
		});

		const before = await handleArchivePublisher(
			request("audit:0", 0, "publisher-archive-before"),
			"audit-before",
			configuration,
			{ publisherDid: PUBLISHER_DID },
			ADMIN,
		);
		expect(before.status).toBe(200);
		const ownerHash = String((await before.json<{ data: { ownerHash: string } }>()).data.ownerHash);

		await runInDurableObject(publisher, (_instance, state) => {
			state.storage.sql.exec("DELETE FROM audit_events");
			state.storage.sql.exec("DELETE FROM sqlite_sequence WHERE name = 'audit_events'");
			state.storage.sql.exec(
				`INSERT INTO audit_events (
					event_type, actor_realm, actor_identity, subject,
					reason_code, public_payload, created_at
				) VALUES
					('after-1', 'access', ?, ?, NULL, '{"history":"after"}', ?),
					('after-2', 'access', ?, ?, NULL, '{"history":"after"}', ?)`,
				ADMIN.identity,
				PUBLISHER_DID,
				NOW + 2,
				ADMIN.identity,
				PUBLISHER_DID,
				NOW + 3,
			);
		});

		const after = await handleArchivePublisher(
			request("audit:0", 0, "publisher-archive-after"),
			"audit-after",
			configuration,
			{ publisherDid: PUBLISHER_DID },
			ADMIN,
		);
		expect(after.status, await after.clone().text()).toBe(200);
		const objects = await env.OPERATIONS_ARCHIVE.list({ prefix: `audit/${ownerHash}/` });
		expect(objects.objects).toHaveLength(2);
		for (const object of objects.objects) {
			const text = await (await env.OPERATIONS_ARCHIVE.get(object.key))!.text();
			expect(text).not.toContain(PUBLISHER_DID);
			expect(text).not.toContain(ADMIN.identity);
		}
	});

	it("bounds intent archive pages below the encryption plaintext limit", async () => {
		const configuration = await loadConfiguration(TEST_BINDINGS);
		const publisher = env.PUBLISHER_DO.getByName(PUBLISHER_DID);
		await publisher.putWorkloadPolicy({
			publisherDid: PUBLISHER_DID,
			packageSlug: "gallery",
			repository: "example/gallery",
			repositoryId: "123",
			repositoryOwnerId: "456",
			workflowRef: "example/gallery/.github/workflows/release.yml@refs/heads/main",
			allowedRefs: ["refs/heads/main"],
			allowedEnvironments: [],
			active: true,
			expectedVersion: null,
			now: NOW,
		});
		const workloadIdentityJson = maximalCanonicalObject(16 * 1024);
		const releaseInputJson = maximalCanonicalObject(64 * 1024);
		const stateDataJson = maximalCanonicalObject(64 * 1024);
		for (let index = 0; index < 4; index += 1) {
			const intentId = `${INTENT_ID.slice(0, -1)}${String(index)}`;
			await publisher.createIntent({
				publisherDid: PUBLISHER_DID,
				intentId,
				packageSlug: "gallery",
				version: `1.2.${index}`,
				workloadPolicyVersion: 1,
				workloadIdentityDigest: String(index).repeat(43),
				workloadIdempotencyDigest: String(index + 4).repeat(43),
				idempotencyKey: `github-run-${index}-attempt-1`,
				requestDigest: String(index + 5).repeat(43),
				workloadIdentityJson,
				releaseInputJson,
				expiresAt: NOW + 60_000,
				now: NOW + index + 1,
			});
			await runInDurableObject(publisher, (_instance, state) => {
				state.storage.sql.exec(
					"UPDATE intents SET state_data_json = ? WHERE id = ?",
					stateDataJson,
					intentId,
				);
			});
		}

		const response = await handleArchivePublisher(
			request("intents:", 0, "publisher-archive-large"),
			"archive-large-intents",
			configuration,
			{ publisherDid: PUBLISHER_DID },
			ADMIN,
		);
		expect(response.status, await response.clone().text()).toBe(200);
	});

	it("can abort a restore whose next archive page is missing and prepare it again", async () => {
		const configuration = await loadConfiguration(TEST_BINDINGS);
		let cursor: string | null = null;
		let page = 0;
		let ownerHash = "";
		do {
			const response = await handleArchivePublisher(
				request(cursor, page),
				`archive-for-abort-${page}`,
				configuration,
				{ publisherDid: PUBLISHER_DID },
				ADMIN,
			);
			expect(response.status).toBe(200);
			const body = await response.json<{
				data: { nextCursor: string | null; nextPage: number; ownerHash: string };
			}>();
			ownerHash = body.data.ownerHash;
			cursor = body.data.nextCursor;
			page = body.data.nextPage;
		} while (cursor !== null);
		await env.SERVICE_CONTROL_DO.getByName(SERVICE_CONTROL_OBJECT_NAME).setPublisherControl({
			actor: ADMIN,
			idempotencyKey: "suspend-before-restore-abort",
			requestDigest: "R".repeat(43),
			publisherDid: PUBLISHER_DID,
			status: "suspended",
			reasonCode: "SHARD_RESTORE",
			now: NOW,
		});
		expect(
			(
				await handlePreparePublisherRestore(
					prepareRestoreRequest(),
					"prepare-for-abort",
					configuration,
					{ publisherDid: PUBLISHER_DID },
					ADMIN,
				)
			).status,
		).toBe(200);
		expect(
			(
				await handleRestorePublisher(
					restoreRequest(0),
					"restore-before-abort",
					configuration,
					{ publisherDid: PUBLISHER_DID },
					ADMIN,
				)
			).status,
		).toBe(200);
		const missingPageKey = `snapshots/${ownerHash}/${ARCHIVE_ID}/000001.json.jwe`;
		const missingPage = await (await env.OPERATIONS_ARCHIVE.get(missingPageKey))!.text();
		await env.OPERATIONS_ARCHIVE.delete(missingPageKey);
		const missing = await handleRestorePublisher(
			restoreRequest(1),
			"restore-missing-page",
			configuration,
			{ publisherDid: PUBLISHER_DID },
			ADMIN,
		);
		expect(missing.status).toBe(404);

		const aborted = await handleAbortPublisherRestore(
			abortRestoreRequest(),
			"abort-wedged-restore",
			configuration,
			{ publisherDid: PUBLISHER_DID },
			ADMIN,
		);
		expect(aborted.status).toBe(200);
		await expect(aborted.json()).resolves.toMatchObject({
			data: { archiveId: ARCHIVE_ID, publisherDid: PUBLISHER_DID, aborted: true },
		});
		const abortReplay = await handleAbortPublisherRestore(
			abortRestoreRequest(),
			"abort-wedged-restore-replay",
			configuration,
			{ publisherDid: PUBLISHER_DID },
			ADMIN,
		);
		expect(abortReplay.status).toBe(200);
		await expect(abortReplay.json()).resolves.toMatchObject({ data: { replayed: true } });
		await env.OPERATIONS_ARCHIVE.put(missingPageKey, missingPage);
		const stalePage = await handleRestorePublisher(
			restoreRequest(1),
			"restore-after-abort",
			configuration,
			{ publisherDid: PUBLISHER_DID },
			ADMIN,
		);
		expect(stalePage.status).toBe(409);

		const preparedAgain = await handlePreparePublisherRestore(
			prepareRestoreRequest(),
			"prepare-after-abort",
			configuration,
			{ publisherDid: PUBLISHER_DID },
			ADMIN,
		);
		expect(preparedAgain.status, await preparedAgain.clone().text()).toBe(200);
		await expect(preparedAgain.json()).resolves.toMatchObject({ data: { replayed: false } });
	});
});
