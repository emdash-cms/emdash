import { createHash } from "node:crypto";

import { encode } from "@atcute/cbor";
import { fromBase64Url } from "@atcute/multibase";
import { P256Keypair, verifySignature } from "@atproto/crypto";
import { describe, expect, it } from "vitest";

import vector from "../../../.opencode/plans/plugin-registry-labelling-service/gate-0/fixtures/crypto/p256-label-v1.json" with { type: "json" };

function fromHex(value: string): Uint8Array {
	return Uint8Array.from(value.match(/.{2}/g) ?? [], (byte) => Number.parseInt(byte, 16));
}

function toHex(value: Uint8Array): string {
	return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

describe("ATProto label crypto vector generation", () => {
	it("reproduces the reference vector and independently verifies the workerd signature", async () => {
		const canonicalBytes = encode(vector.label);
		const keypair = await P256Keypair.import(fromBase64Url(vector.key.testPrivateKeyRawBase64Url), {
			exportable: true,
		});
		const referenceSignature = await keypair.sign(canonicalBytes);

		expect(toHex(canonicalBytes)).toBe(vector.canonicalCborHex);
		expect(createHash("sha256").update(canonicalBytes).digest("hex")).toBe(vector.sha256Hex);
		expect(keypair.did()).toBe(vector.key.publicKeyDid);
		expect(keypair.did().slice("did:key:".length)).toBe(vector.key.publicKeyMultikey);
		expect(vector.didDocument.verificationMethod[0]?.publicKeyMultibase).toBe(
			keypair.did().slice("did:key:".length),
		);
		expect(toHex(keypair.publicKeyBytes())).toBe(vector.key.publicKeyRawHex);
		expect(toHex(referenceSignature)).toBe(vector.signatures.atprotoReferenceHex);
		expect(await verifySignature(vector.key.publicKeyDid, canonicalBytes, referenceSignature)).toBe(
			true,
		);
		expect(
			await verifySignature(
				vector.key.publicKeyDid,
				canonicalBytes,
				fromHex(vector.signatures.atcuteWebcryptoHex),
			),
		).toBe(true);

		const digest = createHash("sha256").update(canonicalBytes).digest();
		expect(await verifySignature(vector.key.publicKeyDid, digest, referenceSignature)).toBe(false);
	});
});
