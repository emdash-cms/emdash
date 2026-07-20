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
const CONTEXT = {
	purpose: "oauth-session",
	table: "publisher_delegations",
	primaryKey: "01JABCDEFGHJKMNPQRSTVWXYZ",
	ownerDid: "did:plc:publisher",
} satisfies EncryptionContext;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

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

describe("envelope encryption", () => {
	it.each(["", "plain text", "こんにちは世界", JSON.stringify({ token: "secret" })])(
		"round trips UTF-8 plaintext",
		async (plaintext) => {
			const encryption = createEnvelopeEncryption(KEYRING);
			const encrypted = await encryption.encrypt(encoder.encode(plaintext), CONTEXT);

			expect(encrypted.keyVersion).toBe(2);
			expect(encrypted.envelope).not.toContain(plaintext || "secret");
			expect(decoder.decode(await encryption.decrypt(encrypted.envelope, CONTEXT))).toBe(plaintext);
		},
	);

	it("decrypts the persisted version 1 compatibility vector", async () => {
		const encryption = createEnvelopeEncryption(KEYRING);
		const envelope =
			'{"v":1,"k":1,"n":"AAECAwQFBgcICQoL","c":"HdFw4nM5jJCXNGp4JXOQJEGstFPca4NiixkzLzDR2RA"}';

		expect(decoder.decode(await encryption.decrypt(envelope, CONTEXT))).toBe("persisted secret");
	});

	it("uses a fresh nonce for every encryption", async () => {
		const encryption = createEnvelopeEncryption(KEYRING);
		const plaintext = encoder.encode("same secret");
		const first = await encryption.encrypt(plaintext, CONTEXT);
		const second = await encryption.encrypt(plaintext, CONTEXT);

		expect(first.envelope).not.toBe(second.envelope);
	});

	it("round trips arbitrary binary data", async () => {
		const encryption = createEnvelopeEncryption(KEYRING);
		const plaintext = Uint8Array.from([0, 255, 128, 1, 127]);
		const encrypted = await encryption.encrypt(plaintext, CONTEXT);

		expect(await encryption.decrypt(encrypted.envelope, CONTEXT)).toEqual(plaintext);
	});

	it("copies mutable plaintext before asynchronous key derivation", async () => {
		const encryption = createEnvelopeEncryption(KEYRING);
		const plaintext = encoder.encode("original");
		const pending = encryption.encrypt(plaintext, CONTEXT);
		plaintext.fill(0);
		const encrypted = await pending;

		expect(decoder.decode(await encryption.decrypt(encrypted.envelope, CONTEXT))).toBe("original");
	});

	it("supports pre-identity transactions with an explicit unowned context", async () => {
		const encryption = createEnvelopeEncryption(KEYRING);
		const context = {
			purpose: "oauth-transaction",
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
		const encryption = createEnvelopeEncryption(KEYRING);
		const context = {
			purpose: "oauth-transaction",
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
		const encryption = createEnvelopeEncryption(KEYRING);
		const ownedContext: EncryptionContext = { ...CONTEXT };
		Object.assign(ownedContext, { ownerDid: null });
		const unownedContext: EncryptionContext = {
			purpose: "confidential-client-private-key",
			table: "service_keys",
			primaryKey: "current-client-key",
			ownerDid: null,
		};
		Object.assign(unownedContext, { ownerDid: "did:plc:publisher" });

		for (const context of [ownedContext, unownedContext]) {
			await expect(encryption.encrypt(encoder.encode("secret"), context)).rejects.toSatisfy(
				expectEncryptionError("ENCRYPTION_CONTEXT_INVALID"),
			);
		}
	});

	it("snapshots mutable context before asynchronous key derivation", async () => {
		const encryption = createEnvelopeEncryption(KEYRING);
		const context: EncryptionContext = { ...CONTEXT };
		const pending = encryption.encrypt(encoder.encode("secret"), context);
		context.primaryKey = "mutated-row";
		context.ownerDid = "did:plc:mutated";
		const encrypted = await pending;

		expect(decoder.decode(await encryption.decrypt(encrypted.envelope, CONTEXT))).toBe("secret");
	});

	it.each([
		["purpose", { ...CONTEXT, purpose: "dpop-private-key" }],
		["table", { ...CONTEXT, table: "oauth_transactions" }],
		["primary key", { ...CONTEXT, primaryKey: "other-row" }],
		["owner DID", { ...CONTEXT, ownerDid: "did:plc:other" }],
	] satisfies ReadonlyArray<readonly [string, EncryptionContext]>)(
		"binds ciphertext to its %s",
		async (_name, changedContext) => {
			const encryption = createEnvelopeEncryption(KEYRING);
			const encrypted = await encryption.encrypt(encoder.encode("secret"), CONTEXT);

			await expect(encryption.decrypt(encrypted.envelope, changedContext)).rejects.toSatisfy(
				expectEncryptionError("DECRYPTION_FAILED"),
			);
		},
	);

	it.each([
		["malformed JSON", "not-json", "ENCRYPTED_VALUE_INVALID"],
		[
			"additional property",
			'{"v":1,"k":2,"n":"AAAAAAAAAAAAAAAA","c":"AAAAAAAAAAAAAAAAAAAAAA","x":1}',
			"ENCRYPTED_VALUE_INVALID",
		],
		[
			"unsupported envelope version",
			'{"v":2,"k":2,"n":"AAAAAAAAAAAAAAAA","c":"AAAAAAAAAAAAAAAAAAAAAA"}',
			"ENCRYPTED_VALUE_UNSUPPORTED",
		],
		[
			"padded nonce",
			'{"v":1,"k":2,"n":"AAAAAAAAAAAAAAAA=","c":"AAAAAAAAAAAAAAAAAAAAAA"}',
			"ENCRYPTED_VALUE_INVALID",
		],
		[
			"short nonce",
			'{"v":1,"k":2,"n":"AAAA","c":"AAAAAAAAAAAAAAAAAAAAAA"}',
			"ENCRYPTED_VALUE_INVALID",
		],
		[
			"short ciphertext",
			'{"v":1,"k":2,"n":"AAAAAAAAAAAAAAAA","c":"AAAA"}',
			"ENCRYPTED_VALUE_INVALID",
		],
		[
			"non-canonical serialization",
			'{ "v":1,"k":2,"n":"AAAAAAAAAAAAAAAA","c":"AAAAAAAAAAAAAAAAAAAAAA"}',
			"ENCRYPTED_VALUE_INVALID",
		],
		[
			"duplicate property",
			'{"v":1,"v":1,"k":2,"n":"AAAAAAAAAAAAAAAA","c":"AAAAAAAAAAAAAAAAAAAAAA"}',
			"ENCRYPTED_VALUE_INVALID",
		],
	])("rejects a %s", async (_name, envelope, code) => {
		const encryption = createEnvelopeEncryption(KEYRING);

		await expect(encryption.decrypt(envelope, CONTEXT)).rejects.toSatisfy(
			expectEncryptionError(code),
		);
	});

	it("rejects ciphertext modification without leaking the crypto exception", async () => {
		const encryption = createEnvelopeEncryption(KEYRING);
		const encrypted = await encryption.encrypt(encoder.encode("secret marker"), CONTEXT);
		const parsed = JSON.parse(encrypted.envelope) as { c: string };
		parsed.c = mutateBase64Url(parsed.c);

		await expect(encryption.decrypt(JSON.stringify(parsed), CONTEXT)).rejects.toSatisfy(
			expectEncryptionError("DECRYPTION_FAILED"),
		);
	});

	it("rejects nonce modification", async () => {
		const encryption = createEnvelopeEncryption(KEYRING);
		const encrypted = await encryption.encrypt(encoder.encode("secret"), CONTEXT);
		const parsed = JSON.parse(encrypted.envelope) as { n: string };
		parsed.n = mutateBase64Url(parsed.n);

		await expect(encryption.decrypt(JSON.stringify(parsed), CONTEXT)).rejects.toSatisfy(
			expectEncryptionError("DECRYPTION_FAILED"),
		);
	});

	it("reads old keys, writes the current key, and rotates idempotently", async () => {
		const oldEncryption = createEnvelopeEncryption(
			JSON.stringify({ current: 1, keys: [{ version: 1, key: KEY_1 }] }),
		);
		const oldValue = await oldEncryption.encrypt(encoder.encode("rotate me"), CONTEXT);
		const encryption = createEnvelopeEncryption(KEYRING);

		expect(encryption.needsRotation(oldValue.envelope)).toBe(true);
		expect(decoder.decode(await encryption.decrypt(oldValue.envelope, CONTEXT))).toBe("rotate me");

		const rotated = await encryption.rotate(oldValue.envelope, CONTEXT);
		expect(rotated.keyVersion).toBe(2);
		expect(rotated.envelope).not.toBe(oldValue.envelope);
		expect(decoder.decode(await encryption.decrypt(rotated.envelope, CONTEXT))).toBe("rotate me");
		expect(encryption.needsRotation(rotated.envelope)).toBe(false);
		expect(await encryption.rotate(rotated.envelope, CONTEXT)).toEqual(rotated);
	});

	it("authenticates a current-version envelope before treating rotation as complete", async () => {
		const encryption = createEnvelopeEncryption(KEYRING);
		const encrypted = await encryption.encrypt(encoder.encode("secret"), CONTEXT);
		const parsed = JSON.parse(encrypted.envelope) as { c: string };
		parsed.c = mutateBase64Url(parsed.c);

		await expect(encryption.rotate(JSON.stringify(parsed), CONTEXT)).rejects.toSatisfy(
			expectEncryptionError("DECRYPTION_FAILED"),
		);
	});

	it("rejects oversized plaintext before encryption", async () => {
		const encryption = createEnvelopeEncryption(KEYRING);

		await expect(encryption.encrypt(new Uint8Array(1024 * 1024 + 1), CONTEXT)).rejects.toSatisfy(
			expectEncryptionError("ENCRYPTION_FAILED"),
		);
	});

	it("fails closed when an old key is unavailable", async () => {
		const oldEncryption = createEnvelopeEncryption(
			JSON.stringify({ current: 1, keys: [{ version: 1, key: KEY_1 }] }),
		);
		const oldValue = await oldEncryption.encrypt(encoder.encode("old secret"), CONTEXT);
		const currentEncryption = createEnvelopeEncryption(
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
	])("rejects %s", (_name, keyring) => {
		expect(() => createEnvelopeEncryption(keyring)).toThrowError(
			expect.objectContaining({ code: "ENCRYPTION_CONFIGURATION_INVALID" }),
		);
	});

	it("does not expose key material in configuration errors", () => {
		const marker = "private-key-marker";

		try {
			createEnvelopeEncryption(JSON.stringify({ current: 1, keys: [{ version: 1, key: marker }] }));
			expect.unreachable();
		} catch (error) {
			expect(String(error)).not.toContain(marker);
			expect(error).not.toHaveProperty("cause");
		}
	});
});
