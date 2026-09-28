import { base64url, decodeProtectedHeader } from "jose";
import { describe, expect, it } from "vitest";

import {
	EncryptionError,
	createEnvelopeEncryption,
	type EncryptionContext,
} from "../src/crypto/encryption.js";

const KEY_1 = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";
const KEY_2 = "ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8";
const KEYRING = JSON.stringify({
	current: 2,
	keys: [
		{ version: 1, key: KEY_1 },
		{ version: 2, key: KEY_2 },
	],
});
const DEPLOYMENT_ID = "test-release-service";
const CONTEXT = {
	purpose: "oauth-session",
	objectClass: "PublisherDurableObject",
	table: "publisher_delegations",
	primaryKey: "01JABCDEFGHJKMNPQRSTVWXYZ",
	ownerDid: "did:plc:publisher",
} satisfies EncryptionContext;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function createTestEncryption(keyring = KEYRING, deploymentId = DEPLOYMENT_ID) {
	return createEnvelopeEncryption(keyring, deploymentId);
}

function expectEncryptionError(code: string) {
	return (error: unknown) => {
		expect(error).toBeInstanceOf(EncryptionError);
		expect(error).toMatchObject({ code });
		return true;
	};
}

function mutateBase64Url(value: string): string {
	return `${value.startsWith("A") ? "B" : "A"}${value.slice(1)}`;
}

function mutateCompactSegment(envelope: string, index: number): string {
	const segments = envelope.split(".");
	const segment = segments[index];
	if (!segment) throw new Error("Expected a populated compact JWE segment");
	segments[index] = mutateBase64Url(segment);
	return segments.join(".");
}

function replaceProtectedHeader(
	envelope: string,
	mutate: (header: Record<string, unknown>) => void,
): string {
	const segments = envelope.split(".");
	const header: Record<string, unknown> = { ...decodeProtectedHeader(envelope) };
	mutate(header);
	segments[0] = base64url.encode(JSON.stringify(header));
	return segments.join(".");
}

describe("envelope encryption", () => {
	it.each(["", "plain text", "こんにちは世界", JSON.stringify({ token: "secret" })])(
		"round trips UTF-8 plaintext",
		async (plaintext) => {
			const encryption = createTestEncryption();
			const encrypted = await encryption.encrypt(encoder.encode(plaintext), CONTEXT);

			expect(encrypted.keyVersion).toBe(2);
			expect(encrypted.envelope).not.toContain(plaintext || "secret");
			expect(decoder.decode(await encryption.decrypt(encrypted.envelope, CONTEXT))).toBe(plaintext);
		},
	);

	it("writes the required compact JWE profile and a wrapped content key", async () => {
		const encryption = createTestEncryption();
		const encrypted = await encryption.encrypt(encoder.encode("secret"), CONTEXT);
		const segments = encrypted.envelope.split(".");

		expect(segments).toHaveLength(5);
		expect(segments[1]).not.toBe("");
		expect(decodeProtectedHeader(encrypted.envelope)).toMatchObject({
			alg: "A256GCMKW",
			enc: "A256GCM",
			kid: "2",
			crit: ["emdash_v", "emdash_ctx"],
			emdash_v: 1,
			emdash_ctx: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
			iv: expect.stringMatching(/^[A-Za-z0-9_-]{16}$/),
			tag: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/),
		});
	});

	it("uses a fresh content key and nonce for every encryption", async () => {
		const encryption = createTestEncryption();
		const plaintext = encoder.encode("same secret");
		const first = await encryption.encrypt(plaintext, CONTEXT);
		const second = await encryption.encrypt(plaintext, CONTEXT);
		const firstSegments = first.envelope.split(".");
		const secondSegments = second.envelope.split(".");

		expect(first.envelope).not.toBe(second.envelope);
		expect(firstSegments[1]).not.toBe(secondSegments[1]);
		expect(firstSegments[2]).not.toBe(secondSegments[2]);
	});

	it("round trips arbitrary binary data", async () => {
		const encryption = createTestEncryption();
		const plaintext = Uint8Array.from([0, 255, 128, 1, 127]);
		const encrypted = await encryption.encrypt(plaintext, CONTEXT);

		expect(await encryption.decrypt(encrypted.envelope, CONTEXT)).toEqual(plaintext);
	});

	it("copies mutable plaintext before asynchronous key derivation", async () => {
		const encryption = createTestEncryption();
		const plaintext = encoder.encode("original");
		const pending = encryption.encrypt(plaintext, CONTEXT);
		plaintext.fill(0);
		const encrypted = await pending;

		expect(decoder.decode(await encryption.decrypt(encrypted.envelope, CONTEXT))).toBe("original");
	});

	it("supports pre-identity transactions with an explicit unowned context", async () => {
		const encryption = createTestEncryption();
		const context = {
			purpose: "oauth-transaction",
			objectClass: "PublisherDurableObject",
			table: "oauth_transactions",
			primaryKey: "transaction-id",
			ownerDid: null,
		} as const satisfies EncryptionContext;
		const encrypted = await encryption.encrypt(encoder.encode("oauth state"), context);

		expect(decoder.decode(await encryption.decrypt(encrypted.envelope, context))).toBe(
			"oauth state",
		);
	});

	it("binds known-identity OAuth transactions to their expected DID", async () => {
		const encryption = createTestEncryption();
		const context = {
			purpose: "oauth-transaction",
			objectClass: "PublisherDurableObject",
			table: "oauth_transactions",
			primaryKey: "transaction-id",
			ownerDid: "did:plc:expected",
		} as const satisfies EncryptionContext;
		const encrypted = await encryption.encrypt(encoder.encode("oauth state"), context);

		await expect(
			encryption.decrypt(encrypted.envelope, { ...context, ownerDid: "did:plc:other" }),
		).rejects.toSatisfy(expectEncryptionError("DECRYPTION_FAILED"));
	});

	it("rejects owner semantics that do not match the purpose", async () => {
		const encryption = createTestEncryption();
		const ownedContext: EncryptionContext = { ...CONTEXT };
		Object.assign(ownedContext, { ownerDid: null });
		const unownedContext: EncryptionContext = {
			purpose: "confidential-client-private-key",
			objectClass: "ReleaseService",
			table: "service_keys",
			primaryKey: "current-client-key",
			ownerDid: null,
		};
		Object.assign(unownedContext, { ownerDid: "did:plc:publisher" });
		const contextWithExtraProperty: EncryptionContext = { ...CONTEXT };
		Object.assign(contextWithExtraProperty, { extra: true });

		for (const context of [ownedContext, unownedContext, contextWithExtraProperty]) {
			await expect(encryption.encrypt(encoder.encode("secret"), context)).rejects.toSatisfy(
				expectEncryptionError("ENCRYPTION_CONTEXT_INVALID"),
			);
		}
	});

	it("snapshots mutable context before asynchronous key derivation", async () => {
		const encryption = createTestEncryption();
		const context: EncryptionContext = { ...CONTEXT };
		const pending = encryption.encrypt(encoder.encode("secret"), context);
		context.primaryKey = "mutated-row";
		context.ownerDid = "did:plc:mutated";
		const encrypted = await pending;

		expect(decoder.decode(await encryption.decrypt(encrypted.envelope, CONTEXT))).toBe("secret");
	});

	it.each([
		["purpose", { ...CONTEXT, purpose: "dpop-private-key" }],
		["object class", { ...CONTEXT, objectClass: "ApproverDurableObject" }],
		["table", { ...CONTEXT, table: "oauth_transactions" }],
		["primary key", { ...CONTEXT, primaryKey: "other-row" }],
		["owner DID", { ...CONTEXT, ownerDid: "did:plc:other" }],
	] satisfies ReadonlyArray<readonly [string, EncryptionContext]>)(
		"binds ciphertext to its %s",
		async (_name, changedContext) => {
			const encryption = createTestEncryption();
			const encrypted = await encryption.encrypt(encoder.encode("secret"), CONTEXT);

			await expect(encryption.decrypt(encrypted.envelope, changedContext)).rejects.toSatisfy(
				expectEncryptionError("DECRYPTION_FAILED"),
			);
		},
	);

	it("binds ciphertext to its deployment", async () => {
		const encryption = createTestEncryption();
		const otherDeployment = createTestEncryption(KEYRING, "other-release-service");
		const encrypted = await encryption.encrypt(encoder.encode("secret"), CONTEXT);

		await expect(otherDeployment.decrypt(encrypted.envelope, CONTEXT)).rejects.toSatisfy(
			expectEncryptionError("DECRYPTION_FAILED"),
		);
	});

	it.each(["not-jwe", "a.b.c.d.e.f", "a.b.c.d.="])(
		"rejects malformed compact input %j",
		async (envelope) => {
			const encryption = createTestEncryption();

			await expect(encryption.decrypt(envelope, CONTEXT)).rejects.toSatisfy(
				expectEncryptionError("ENCRYPTED_VALUE_INVALID"),
			);
		},
	);

	it.each([
		["key management algorithm", (header) => (header["alg"] = "dir")],
		["content encryption algorithm", (header) => (header["enc"] = "A128GCM")],
		["profile version", (header) => (header["emdash_v"] = 2)],
		["critical header contract", (header) => (header["crit"] = ["emdash_v"])],
	] satisfies ReadonlyArray<readonly [string, (header: Record<string, unknown>) => void]>)(
		"rejects an unsupported %s",
		async (_name, mutateHeader) => {
			const encryption = createTestEncryption();
			const encrypted = await encryption.encrypt(encoder.encode("secret"), CONTEXT);
			const unsupported = replaceProtectedHeader(encrypted.envelope, mutateHeader);

			await expect(encryption.decrypt(unsupported, CONTEXT)).rejects.toSatisfy(
				expectEncryptionError("ENCRYPTED_VALUE_UNSUPPORTED"),
			);
		},
	);

	it.each([
		["additional protected field", (header) => (header["extra"] = true)],
		["non-canonical key ID", (header) => (header["kid"] = "02")],
	] satisfies ReadonlyArray<readonly [string, (header: Record<string, unknown>) => void]>)(
		"rejects an invalid %s",
		async (_name, mutateHeader) => {
			const encryption = createTestEncryption();
			const encrypted = await encryption.encrypt(encoder.encode("secret"), CONTEXT);
			const invalid = replaceProtectedHeader(encrypted.envelope, mutateHeader);

			await expect(encryption.decrypt(invalid, CONTEXT)).rejects.toSatisfy(
				expectEncryptionError("ENCRYPTED_VALUE_INVALID"),
			);
		},
	);

	it("rejects ciphertext modification without leaking the crypto exception", async () => {
		const encryption = createTestEncryption();
		const encrypted = await encryption.encrypt(encoder.encode("secret marker"), CONTEXT);
		const modified = mutateCompactSegment(encrypted.envelope, 3);

		await expect(encryption.decrypt(modified, CONTEXT)).rejects.toSatisfy(
			expectEncryptionError("DECRYPTION_FAILED"),
		);
	});

	it("rejects content nonce modification", async () => {
		const encryption = createTestEncryption();
		const encrypted = await encryption.encrypt(encoder.encode("secret"), CONTEXT);
		const modified = mutateCompactSegment(encrypted.envelope, 2);

		await expect(encryption.decrypt(modified, CONTEXT)).rejects.toSatisfy(
			expectEncryptionError("DECRYPTION_FAILED"),
		);
	});

	it("rejects wrapped-key metadata modification", async () => {
		const encryption = createTestEncryption();
		const encrypted = await encryption.encrypt(encoder.encode("secret"), CONTEXT);
		const modified = replaceProtectedHeader(encrypted.envelope, (header) => {
			if (typeof header["iv"] !== "string") throw new Error("Expected a key-wrap IV");
			header["iv"] = mutateBase64Url(header["iv"]);
		});

		await expect(encryption.decrypt(modified, CONTEXT)).rejects.toSatisfy(
			expectEncryptionError("DECRYPTION_FAILED"),
		);
	});

	it("reads old keys, writes the current key, and rotates idempotently", async () => {
		const oldEncryption = createTestEncryption(
			JSON.stringify({ current: 1, keys: [{ version: 1, key: KEY_1 }] }),
		);
		const oldValue = await oldEncryption.encrypt(encoder.encode("rotate me"), CONTEXT);
		const encryption = createTestEncryption();

		expect(encryption.needsRotation(oldValue.envelope)).toBe(true);
		expect(decoder.decode(await encryption.decrypt(oldValue.envelope, CONTEXT))).toBe("rotate me");

		const rotated = await encryption.rotate(oldValue.envelope, CONTEXT);
		expect(rotated.keyVersion).toBe(2);
		expect(decodeProtectedHeader(oldValue.envelope)["kid"]).toBe("1");
		expect(decodeProtectedHeader(rotated.envelope)["kid"]).toBe("2");
		expect(rotated.envelope).not.toBe(oldValue.envelope);
		expect(decoder.decode(await encryption.decrypt(rotated.envelope, CONTEXT))).toBe("rotate me");
		expect(encryption.needsRotation(rotated.envelope)).toBe(false);
		expect(await encryption.rotate(rotated.envelope, CONTEXT)).toEqual(rotated);
	});

	it("authenticates a current-version envelope before treating rotation as complete", async () => {
		const encryption = createTestEncryption();
		const encrypted = await encryption.encrypt(encoder.encode("secret"), CONTEXT);
		const modified = mutateCompactSegment(encrypted.envelope, 3);

		await expect(encryption.rotate(modified, CONTEXT)).rejects.toSatisfy(
			expectEncryptionError("DECRYPTION_FAILED"),
		);
	});

	it("rejects oversized plaintext before encryption", async () => {
		const encryption = createTestEncryption();

		await expect(encryption.encrypt(new Uint8Array(1024 * 1024 + 1), CONTEXT)).rejects.toSatisfy(
			expectEncryptionError("ENCRYPTION_FAILED"),
		);
	});

	it("fails closed when an old key is unavailable", async () => {
		const oldEncryption = createTestEncryption(
			JSON.stringify({ current: 1, keys: [{ version: 1, key: KEY_1 }] }),
		);
		const oldValue = await oldEncryption.encrypt(encoder.encode("old secret"), CONTEXT);
		const currentEncryption = createTestEncryption(
			JSON.stringify({ current: 2, keys: [{ version: 2, key: KEY_2 }] }),
		);

		await expect(currentEncryption.decrypt(oldValue.envelope, CONTEXT)).rejects.toSatisfy(
			expectEncryptionError("ENCRYPTION_KEY_UNAVAILABLE"),
		);
	});
});

describe("encryption configuration", () => {
	it.each([
		["malformed JSON", "{"],
		["additional property", JSON.stringify({ current: 1, keys: [], extra: true })],
		["no keys", JSON.stringify({ current: 1, keys: [] })],
		["missing current key", JSON.stringify({ current: 2, keys: [{ version: 1, key: KEY_1 }] })],
		[
			"duplicate versions",
			JSON.stringify({
				current: 1,
				keys: [
					{ version: 1, key: KEY_1 },
					{ version: 1, key: KEY_2 },
				],
			}),
		],
		["short key", JSON.stringify({ current: 1, keys: [{ version: 1, key: "AAAA" }] })],
		["padded key", JSON.stringify({ current: 1, keys: [{ version: 1, key: `${KEY_1}=` }] })],
		[
			"too many keys",
			JSON.stringify({
				current: 1,
				keys: Array.from({ length: 33 }, (_, index) => ({ version: index + 1, key: KEY_1 })),
			}),
		],
	])("rejects %s", (_name, keyring) => {
		expect(() => createTestEncryption(keyring)).toThrowError(
			expect.objectContaining({ code: "ENCRYPTION_CONFIGURATION_INVALID" }),
		);
	});

	it.each(["", "spaces are invalid", "-leading-hyphen"])(
		"rejects invalid deployment ID %j",
		(deploymentId) => {
			expect(() => createTestEncryption(KEYRING, deploymentId)).toThrowError(
				expect.objectContaining({ code: "ENCRYPTION_CONFIGURATION_INVALID" }),
			);
		},
	);

	it("does not expose key material in configuration errors", () => {
		const marker = "private-key-marker";

		try {
			createTestEncryption(JSON.stringify({ current: 1, keys: [{ version: 1, key: marker }] }));
			expect.unreachable();
		} catch (error) {
			expect(String(error)).not.toContain(marker);
			expect(error).not.toHaveProperty("cause");
		}
	});
});
