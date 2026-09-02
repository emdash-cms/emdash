import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";

import type { AccessActor } from "../src/access/auth.js";
import { loadConfiguration } from "../src/config.js";
import {
	handleRotateApproverEncryption,
	handleRotatePublisherEncryption,
} from "../src/operations/encryption-routes.js";
import { TEST_BINDINGS } from "./fixtures/oauth.js";

const PUBLISHER_DID = "did:web:publisher.example.com";
const APPROVER_DID = "did:plc:approver";
const STATE_HASH = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";
const KEYRING_V2 =
	'{"current":2,"keys":[{"version":1,"key":"AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"},{"version":2,"key":"ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8"}]}';
const KEYRING_V2_RETIRED =
	'{"current":2,"keys":[{"version":2,"key":"ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8"}]}';
const ADMIN: AccessActor = {
	realm: "access",
	identity: "admin@example.com",
	email: "admin@example.com",
	role: "admin",
};

function request(body: unknown): Request {
	return new Request(`${TEST_BINDINGS.PUBLIC_ORIGIN}/admin/api/encryption/rotate`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"idempotency-key": "rotate-encryption-test",
		},
		body: JSON.stringify(body),
	});
}

function bindings(keyring: string) {
	return { ...TEST_BINDINGS, ENCRYPTION_KEYRING: keyring };
}

afterEach(async () => {
	await reset();
});

describe("Access encryption operations", () => {
	it("rotates a resumable publisher page and proves retirement readability", async () => {
		const initial = await loadConfiguration(TEST_BINDINGS);
		const now = Date.now();
		const delegationContext = {
			purpose: "oauth-session",
			objectClass: "PublisherDurableObject",
			table: "delegation",
			primaryKey: "1",
			ownerDid: PUBLISHER_DID,
		} as const;
		const stateContext = {
			purpose: "oauth-console-transaction",
			objectClass: "PublisherDurableObject",
			table: "oauth_states",
			primaryKey: STATE_HASH,
			ownerDid: PUBLISHER_DID,
		} as const;
		const delegation = await initial.encryption.encrypt(
			new TextEncoder().encode("delegation-plaintext"),
			delegationContext,
		);
		const state = await initial.encryption.encrypt(
			new TextEncoder().encode("state-plaintext"),
			stateContext,
		);
		const publisher = env.PUBLISHER_DO.getByName(PUBLISHER_DID);
		await publisher.putDelegation({
			publisherDid: PUBLISHER_DID,
			releaseNsid: initial.oauth.releaseNsid,
			scope: initial.oauth.releaseScope,
			clientKeyId: initial.oauth.activeAssertionKeyId,
			encryptedSession: delegation.envelope,
			encryptionKeyVersion: delegation.keyVersion,
			issuer: "https://authorization.example.com",
			pdsUrl: "https://pds.example.com",
			expiresAt: null,
			refreshBefore: null,
			expectedVersion: null,
		});
		await publisher.putOAuthState({
			publisherDid: PUBLISHER_DID,
			stateHash: STATE_HASH,
			encryptedState: state.envelope,
			encryptionKeyVersion: state.keyVersion,
			encryptionPurpose: "oauth-console-transaction",
			clientKeyId: initial.oauth.activeAssertionKeyId,
			redirectTarget: "/publisher",
			expiresAt: now + 60_000,
		});
		const rotating = await loadConfiguration(bindings(KEYRING_V2));

		const first = await handleRotatePublisherEncryption(
			request({ afterCursor: null, limit: 1 }),
			"request-1",
			rotating,
			{ publisherDid: PUBLISHER_DID },
			ADMIN,
		);
		expect(first.status).toBe(200);
		const firstText = await first.text();
		expect(firstText).not.toContain("plaintext");
		expect(firstText).not.toContain(delegation.envelope);
		expect(JSON.parse(firstText)).toMatchObject({
			data: {
				ownerDid: PUBLISHER_DID,
				targetKeyVersion: 2,
				scanned: 1,
				rotated: 1,
				raced: 0,
				nextCursor: "delegation:1",
			},
		});
		const second = await handleRotatePublisherEncryption(
			request({ afterCursor: "delegation:1", limit: 1 }),
			"request-2",
			rotating,
			{ publisherDid: PUBLISHER_DID },
			ADMIN,
		);
		expect(second.status).toBe(200);
		await expect(second.json()).resolves.toMatchObject({
			data: { scanned: 1, rotated: 1, raced: 0, nextCursor: null, complete: false },
		});
		const verification = await handleRotatePublisherEncryption(
			request({ afterCursor: null, limit: 10 }),
			"request-3",
			rotating,
			{ publisherDid: PUBLISHER_DID },
			ADMIN,
		);
		await expect(verification.json()).resolves.toMatchObject({
			data: { scanned: 2, rotated: 0, raced: 0, nextCursor: null, complete: true },
		});

		const records = await publisher.listEncryptionRecords(PUBLISHER_DID, null, 10, now);
		expect(records.items.map((record) => record.keyVersion)).toEqual([2, 2]);
		const retired = await loadConfiguration(bindings(KEYRING_V2_RETIRED));
		for (const record of records.items) {
			await expect(
				retired.encryption.decrypt(record.envelope, record.context),
			).resolves.toBeInstanceOf(Uint8Array);
		}
	});

	it("requires a clean rescan when an earlier publisher page races", async () => {
		const initial = await loadConfiguration(TEST_BINDINGS);
		const now = Date.now();
		const delegationContext = {
			purpose: "oauth-session",
			objectClass: "PublisherDurableObject",
			table: "delegation",
			primaryKey: "1",
			ownerDid: PUBLISHER_DID,
		} as const;
		const stateContext = {
			purpose: "oauth-console-transaction",
			objectClass: "PublisherDurableObject",
			table: "oauth_states",
			primaryKey: STATE_HASH,
			ownerDid: PUBLISHER_DID,
		} as const;
		const [delegation, racedDelegation, state] = await Promise.all([
			initial.encryption.encrypt(new TextEncoder().encode("delegation-before"), delegationContext),
			initial.encryption.encrypt(new TextEncoder().encode("delegation-raced"), delegationContext),
			initial.encryption.encrypt(new TextEncoder().encode("state"), stateContext),
		]);
		const publisher = env.PUBLISHER_DO.getByName(PUBLISHER_DID);
		await publisher.putDelegation({
			publisherDid: PUBLISHER_DID,
			releaseNsid: initial.oauth.releaseNsid,
			scope: initial.oauth.releaseScope,
			clientKeyId: initial.oauth.activeAssertionKeyId,
			encryptedSession: delegation.envelope,
			encryptionKeyVersion: delegation.keyVersion,
			issuer: "https://authorization.example.com",
			pdsUrl: "https://pds.example.com",
			expiresAt: null,
			refreshBefore: null,
			expectedVersion: null,
		});
		await publisher.putOAuthState({
			publisherDid: PUBLISHER_DID,
			stateHash: STATE_HASH,
			encryptedState: state.envelope,
			encryptionKeyVersion: state.keyVersion,
			encryptionPurpose: "oauth-console-transaction",
			clientKeyId: initial.oauth.activeAssertionKeyId,
			redirectTarget: "/publisher",
			expiresAt: now + 60_000,
		});
		const rotating = await loadConfiguration(bindings(KEYRING_V2));
		let injectRace = true;
		const racedConfiguration = {
			...rotating,
			encryption: {
				...rotating.encryption,
				rotate: async (...args: Parameters<typeof rotating.encryption.rotate>) => {
					const replacement = await rotating.encryption.rotate(...args);
					if (injectRace) {
						injectRace = false;
						await publisher.putDelegation({
							publisherDid: PUBLISHER_DID,
							releaseNsid: initial.oauth.releaseNsid,
							scope: initial.oauth.releaseScope,
							clientKeyId: initial.oauth.activeAssertionKeyId,
							encryptedSession: racedDelegation.envelope,
							encryptionKeyVersion: racedDelegation.keyVersion,
							issuer: "https://authorization.example.com",
							pdsUrl: "https://pds.example.com",
							expiresAt: null,
							refreshBefore: null,
							expectedVersion: 1,
						});
					}
					return replacement;
				},
			},
		};

		const first = await handleRotatePublisherEncryption(
			request({ afterCursor: null, limit: 1 }),
			"race-page-1",
			racedConfiguration,
			{ publisherDid: PUBLISHER_DID },
			ADMIN,
		);
		expect(first.status).toBe(200);
		const firstBody = await first.json<{ data: { nextCursor: string } }>();
		expect(firstBody.data.nextCursor).toContain("delegation:1");

		const second = await handleRotatePublisherEncryption(
			request({ afterCursor: firstBody.data.nextCursor, limit: 1 }),
			"race-page-2",
			rotating,
			{ publisherDid: PUBLISHER_DID },
			ADMIN,
		);
		expect(second.status).toBe(200);
		const secondBody = await second.json<{
			data: { complete: boolean; nextCursor: string | null };
		}>();
		expect(secondBody.data).toMatchObject({ complete: false, nextCursor: "rescan" });

		const rescan = await handleRotatePublisherEncryption(
			request({ afterCursor: secondBody.data.nextCursor, limit: 10 }),
			"race-rescan",
			rotating,
			{ publisherDid: PUBLISHER_DID },
			ADMIN,
		);
		expect(rescan.status).toBe(200);
		await expect(rescan.json()).resolves.toMatchObject({
			data: { complete: false, nextCursor: null, rotated: 1, raced: 0 },
		});

		const cleanRescan = await handleRotatePublisherEncryption(
			request({ afterCursor: null, limit: 10 }),
			"race-clean-rescan",
			rotating,
			{ publisherDid: PUBLISHER_DID },
			ADMIN,
		);
		expect(cleanRescan.status).toBe(200);
		await expect(cleanRescan.json()).resolves.toMatchObject({
			data: { complete: true, nextCursor: null, rotated: 0, raced: 0 },
		});
	});

	it("rotates an approver identity transaction without returning ciphertext", async () => {
		const initial = await loadConfiguration(TEST_BINDINGS);
		const now = Date.now();
		const context = {
			purpose: "oauth-approver-transaction",
			objectClass: "ApproverDurableObject",
			table: "identity_transactions",
			primaryKey: STATE_HASH,
			ownerDid: APPROVER_DID,
		} as const;
		const encrypted = await initial.encryption.encrypt(
			new TextEncoder().encode("approver-plaintext"),
			context,
		);
		const approver = env.APPROVER_DO.getByName(APPROVER_DID);
		await approver.putIdentityTransaction({
			approverDid: APPROVER_DID,
			stateHash: STATE_HASH,
			encryptedState: encrypted.envelope,
			encryptionKeyVersion: encrypted.keyVersion,
			clientKeyId: initial.oauth.activeAssertionKeyId,
			redirectTarget: "/approvals/example",
			expiresAt: now + 60_000,
			now,
		});

		const response = await handleRotateApproverEncryption(
			request({ afterCursor: null, limit: 10 }),
			"request-approver",
			await loadConfiguration(bindings(KEYRING_V2)),
			{ approverDid: APPROVER_DID },
			ADMIN,
		);
		expect(response.status).toBe(200);
		const text = await response.text();
		expect(text).not.toContain(encrypted.envelope);
		expect(text).not.toContain("approver-plaintext");
		expect(JSON.parse(text)).toMatchObject({
			data: { ownerDid: APPROVER_DID, targetKeyVersion: 2, rotated: 1, nextCursor: null },
		});
	});

	it("fails closed when a retained key is missing", async () => {
		const initial = await loadConfiguration(TEST_BINDINGS);
		const context = {
			purpose: "oauth-session",
			objectClass: "PublisherDurableObject",
			table: "delegation",
			primaryKey: "1",
			ownerDid: PUBLISHER_DID,
		} as const;
		const encrypted = await initial.encryption.encrypt(
			new TextEncoder().encode("retained-authority"),
			context,
		);
		await env.PUBLISHER_DO.getByName(PUBLISHER_DID).putDelegation({
			publisherDid: PUBLISHER_DID,
			releaseNsid: initial.oauth.releaseNsid,
			scope: initial.oauth.releaseScope,
			clientKeyId: initial.oauth.activeAssertionKeyId,
			encryptedSession: encrypted.envelope,
			encryptionKeyVersion: encrypted.keyVersion,
			issuer: "https://authorization.example.com",
			pdsUrl: "https://pds.example.com",
			expiresAt: null,
			refreshBefore: null,
			expectedVersion: null,
		});

		const response = await handleRotatePublisherEncryption(
			request({ afterCursor: null, limit: 10 }),
			"request-missing-key",
			await loadConfiguration(bindings(KEYRING_V2_RETIRED)),
			{ publisherDid: PUBLISHER_DID },
			ADMIN,
		);
		expect(response.status).toBe(409);
		await expect(response.json()).resolves.toMatchObject({
			error: { code: "ENCRYPTION_OPERATION_FAILED" },
		});
	});

	it("rejects a resume cursor from another shard type", async () => {
		const response = await handleRotatePublisherEncryption(
			request({ afterCursor: `identity-transaction:${STATE_HASH}`, limit: 10 }),
			"request-invalid-cursor",
			await loadConfiguration(bindings(KEYRING_V2)),
			{ publisherDid: PUBLISHER_DID },
			ADMIN,
		);
		expect(response.status).toBe(400);
		await expect(response.json()).resolves.toMatchObject({ error: { code: "INVALID_REQUEST" } });
	});
});
