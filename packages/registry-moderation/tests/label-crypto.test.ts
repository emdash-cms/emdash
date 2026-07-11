import { readFileSync } from "node:fs";

import { encode } from "@atcute/cbor";
import { verifySignature } from "@atproto/crypto";
import { describe, expect, it } from "vitest";

import {
	createLabelSigner,
	verifyAndEvaluateReleaseModeration,
	verifyLabel,
	type LabelDidDocument,
	type SignedLabel,
	type UnsignedLabel,
} from "../src/index.js";

const fixture = JSON.parse(
	readFileSync(new URL("./fixtures/label-crypto.json", import.meta.url), "utf8"),
) as {
	privateKey: string;
	multikey: string;
	otherMultikey: string;
	nonP256Multikey: string;
	label: UnsignedLabel;
};

function document(
	options: Partial<LabelDidDocument> & { methods?: LabelDidDocument["verificationMethod"] } = {},
): LabelDidDocument {
	return {
		id: fixture.label.src,
		verificationMethod: options.methods ?? [
			{
				id: "#atproto_label",
				type: "Multikey",
				controller: fixture.label.src,
				publicKeyMultibase: fixture.multikey,
			},
		],
		...options,
	};
}

function signingLabel(): Omit<UnsignedLabel, "src"> {
	const { src: _src, ...label } = fixture.label;
	return label;
}

async function signer(didDocument = document()) {
	return createLabelSigner({
		issuerDid: fixture.label.src,
		privateKey: fixture.privateKey,
		resolveDid: async () => didDocument,
	});
}

async function signedLabel(): Promise<SignedLabel> {
	return (await signer()).sign(signingLabel());
}

async function verify(label: SignedLabel, didDocument = document()) {
	return verifyLabel({ label, resolveDid: async () => didDocument });
}

function unsignedBytes(label: UnsignedLabel): Uint8Array {
	const { neg: _neg, ...withoutNeg } = label;
	return encode(withoutNeg);
}

function asHighS(signature: Uint8Array): Uint8Array {
	const order = BigInt("0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551");
	let s = 0n;
	for (const byte of signature.slice(32)) s = (s << 8n) | BigInt(byte);
	const high = order - s;
	const result = signature.slice();
	for (let index = 63; index >= 32; index--) {
		result[index] = Number((high >> BigInt((63 - index) * 8)) & 0xffn);
	}
	return result;
}

describe("ATProto label v1 crypto", () => {
	it("binds a signer to #atproto_label and signs canonical label CBOR", async () => {
		const signed = await signedLabel();
		const verified = await verify(signed);

		const { neg: _neg, ...expected } = fixture.label;
		expect(verified).toEqual(expected);
		expect("neg" in verified).toBe(false);
		expect(
			await verifySignature(
				`did:key:${fixture.multikey}`,
				unsignedBytes(fixture.label),
				signed.sig,
			),
		).toBe(true);
	});

	it("passes canonical bytes directly rather than a digest", async () => {
		const signed = await signedLabel();
		const bytes = unsignedBytes(fixture.label);
		const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));

		expect(await verifySignature(`did:key:${fixture.multikey}`, bytes, signed.sig)).toBe(true);
		expect(await verifySignature(`did:key:${fixture.multikey}`, digest, signed.sig)).toBe(false);
	});

	it("rejects unsupported fields, invalid dates, and values exceeding 128 UTF-8 bytes", async () => {
		const boundSigner = await signer();
		await expect(
			boundSigner.sign({ ...signingLabel(), $type: "com.atproto.label.defs#label" }),
		).rejects.toThrow("unsupported field");
		await expect(
			boundSigner.sign({ ...signingLabel(), cts: "2026-02-30T12:00:00Z" }),
		).rejects.toThrow("valid RFC 3339");
		await expect(boundSigner.sign({ ...signingLabel(), val: "😀".repeat(33) })).rejects.toThrow(
			"128 UTF-8 bytes",
		);
	});

	it("preserves DID and ATProto URI grammar without ambiguous colon matching", async () => {
		const boundSigner = await signer();
		for (const uri of [
			"did:plc:abc123",
			"did:web:example.com",
			"did:example::leading-empty",
			"did:example:doubled::segment",
			"did:example:trailing:",
			"at://did:example::leading-empty/com.example.collection/record",
			"at://did:example:doubled::segment/com.example.collection/record:1",
			"at://example.com/com.example.collection/record:1",
			"at://example.com/com.example.collection",
		]) {
			await expect(boundSigner.sign({ ...signingLabel(), uri })).resolves.toMatchObject({ uri });
		}

		for (const uri of [
			"did:example:",
			"did:Example:value",
			"did:example-method:value",
			"did:example:value/path",
			"did:example:value?query",
			"at://did:example:/com.example.collection/record",
			"at://example.com//record",
			"at://example.com/com.example.collection/",
			`at://did:example:${"%:".repeat(100_000)}!/com.example.collection/record`,
		]) {
			await expect(boundSigner.sign({ ...signingLabel(), uri })).rejects.toThrow(
				"label.uri must be an at:// URI or DID",
			);
		}
	});

	it("rejects non-canonical, zero, and out-of-range private scalar forms", async () => {
		for (const privateKey of [
			fixture.privateKey + "=",
			"AA",
			"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
		]) {
			await expect(
				createLabelSigner({
					issuerDid: fixture.label.src,
					privateKey,
					resolveDid: async () => document(),
				}),
			).rejects.toThrow("privateKey");
		}
	});

	it("requires the exact normalized #atproto_label method without fallback", async () => {
		const signed = await signedLabel();
		await expect(
			verify(
				signed,
				document({
					methods: [
						{ ...document().verificationMethod![0]!, id: `${fixture.label.src}#atproto_label` },
					],
				}),
			),
		).resolves.toEqual(expect.objectContaining({ src: fixture.label.src }));
		await expect(
			verify(
				signed,
				document({ methods: [{ ...document().verificationMethod![0]!, id: "#atproto" }] }),
			),
		).rejects.toThrow("no #atproto_label");
	});

	it("rejects malformed configured signer DID key material", async () => {
		const baseMethod = document().verificationMethod![0]!;
		for (const didDocument of [
			document({ methods: [] }),
			document({ methods: [{ ...baseMethod, id: "#atproto" }] }),
			document({
				methods: [baseMethod, { ...baseMethod, id: `${fixture.label.src}#atproto_label` }],
			}),
			document({ methods: [{ ...baseMethod, controller: "did:example:other" }] }),
			document({ methods: [{ ...baseMethod, publicKeyMultibase: fixture.nonP256Multikey }] }),
			document({ methods: [{ ...baseMethod, publicKeyMultibase: fixture.otherMultikey }] }),
		]) {
			await expect(signer(didDocument)).rejects.toThrow(TypeError);
		}
	});

	it("rejects malleable, DER, and altered signatures or labels", async () => {
		const signed = await signedLabel();
		await expect(verify({ ...signed, sig: asHighS(signed.sig) })).rejects.toThrow(
			"signature is invalid",
		);
		await expect(verify({ ...signed, sig: new Uint8Array(70) })).rejects.toThrow("64-byte compact");
		await expect(verify({ ...signed, val: "assessment-pending" })).rejects.toThrow(
			"signature is invalid",
		);
	});

	it("verifies labels before evaluating their moderation effect", async () => {
		const result = await verifyAndEvaluateReleaseModeration({
			acceptedLabelers: [{ did: fixture.label.src, redact: false }],
			context: {
				publisherDid: "did:example:publisher",
				package: {
					uri: "at://did:example:publisher/com.example.package/profile",
					cid: "package-cid",
				},
				release: { uri: fixture.label.uri, cid: fixture.label.cid! },
			},
			evaluatedAt: "2026-07-10T13:00:00.000Z",
			labels: [await signedLabel()],
			resolveDid: async () => document(),
		});
		expect(result.eligibility).toBe("eligible");
	});
});
