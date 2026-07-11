import { readFileSync } from "node:fs";

import { encode, toBytes } from "@atcute/cbor";
import { P256PrivateKey, P256PublicKey, parsePublicMultikey } from "@atcute/crypto";
import { fromBase64Url } from "@atcute/multibase";
import { verifySignature } from "@atproto/crypto";
import { describe, expect, it } from "vitest";

import {
	createLabelSigner,
	encodeSignedLabel,
	InvalidLabelSignatureError,
	parseSignedLabel,
	verifyAndEvaluateReleaseModeration,
	verifyLabel,
	verifyLabelWithPublicKey,
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

async function publicKey(): Promise<P256PublicKey> {
	const parsed = parsePublicMultikey(fixture.multikey);
	if (parsed.type !== "p256") throw new TypeError("fixture must contain a P-256 key");
	return P256PublicKey.importRaw(parsed.publicKeyBytes);
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
	it("parses unknown signed labels through strict canonical reconstruction", async () => {
		const signed = await signedLabel();
		const inherited = Object.create({ val: signed.val }) as Record<string, unknown>;
		Object.assign(inherited, signed);
		delete inherited.val;
		expect(() => parseSignedLabel(inherited)).toThrow("label.val");

		let accessed = false;
		const accessor = { ...signed };
		Object.defineProperty(accessor, "val", {
			enumerable: true,
			get() {
				accessed = true;
				return signed.val;
			},
		});
		expect(() => parseSignedLabel(accessor)).toThrow("label.val");
		expect(accessed).toBe(false);

		const parsed = parseSignedLabel({ ...signed, neg: false });
		expect(parsed).toEqual(signed);
		expect(parsed.sig).not.toBe(signed.sig);
		expect("neg" in parsed).toBe(false);
	});

	it("isolates parsed and encoded labels from caller signature mutation", () => {
		const originalSignature = Uint8Array.from({ length: 64 }, (_, index) => index);
		const signed = { ...fixture.label, sig: Buffer.from(originalSignature) };
		const parsed = parseSignedLabel(signed);
		const encoded = encodeSignedLabel(parsed);

		signed.sig.fill(0xff);

		expect(parsed.sig).not.toBe(signed.sig);
		expect(parsed.sig.constructor).toBe(Uint8Array);
		expect(Buffer.isBuffer(parsed.sig)).toBe(false);
		expect(parsed.sig).toEqual(originalSignature);
		expect(encodeSignedLabel(parsed)).toEqual(encoded);
	});

	it("encodes stable canonical CBOR for the complete signed label", () => {
		const signed = {
			...fixture.label,
			sig: Uint8Array.from({ length: 64 }, (_, index) => index),
		};
		const canonical = encodeSignedLabel(signed);

		expect(encodeSignedLabel({ ...signed, neg: false })).toEqual(canonical);
		expect(encodeSignedLabel(parseSignedLabel(signed))).toEqual(canonical);
		const { sig, ...unsigned } = parseSignedLabel(signed);
		expect(canonical).toEqual(encode({ ...unsigned, sig: toBytes(sig) }));
		expect(canonical).not.toEqual(unsignedBytes(unsigned));
		expect(Buffer.from(canonical).toString("hex")).toBe(
			"a763636964783b6261666b72656966346f61796d756d3534693571656662776f626c7274357a6173666a68707968797661637073657174656869337175656577356d636374737818323032362d30372d31305431323a30303a30302e3030305a637369675840000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f63737263736469643a6578616d706c653a6c6162656c657263757269783061743a2f2f6469643a6578616d706c653a7075626c69736865722f636f6d2e6578616d706c652e72656c656173652f316376616c716173736573736d656e742d7061737365646376657201",
		);
	});

	it("distinguishes only cryptographic mismatches from other verification failures", async () => {
		const signed = await signedLabel();
		const key = await publicKey();
		const error = new InvalidLabelSignatureError("label signature is invalid");
		expect(error).toBeInstanceOf(TypeError);
		expect(error.name).toBe("InvalidLabelSignatureError");
		expect(error.message).toBe("label signature is invalid");

		await expect(
			verifyLabelWithPublicKey({
				label: signed,
				expectedSource: "did:example:other",
				publicKey: key,
			}),
		).rejects.not.toBeInstanceOf(InvalidLabelSignatureError);
		await expect(
			verifyLabelWithPublicKey({
				label: { ...signed, sig: new Uint8Array(63) },
				expectedSource: signed.src,
				publicKey: key,
			}),
		).rejects.not.toBeInstanceOf(InvalidLabelSignatureError);
		await expect(
			verifyLabelWithPublicKey({
				label: { ...signed, sig: new Uint8Array(64) },
				expectedSource: signed.src,
				publicKey: key,
			}),
		).rejects.toBeInstanceOf(InvalidLabelSignatureError);
	});

	it("verifies with a resolved public key identically to DID-based verification", async () => {
		const signed = await signedLabel();
		const direct = await verifyLabelWithPublicKey({
			label: signed,
			expectedSource: fixture.label.src,
			publicKey: await publicKey(),
		});

		expect(direct).toEqual(await verify(signed));
	});

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
		const privateKey = await P256PrivateKey.importRaw(fromBase64Url(fixture.privateKey));
		const digestSignature = await privateKey.sign(digest);

		expect(await verifySignature(`did:key:${fixture.multikey}`, bytes, signed.sig)).toBe(true);
		expect(await verifySignature(`did:key:${fixture.multikey}`, digest, signed.sig)).toBe(false);
		await expect(
			verifyLabelWithPublicKey({
				label: { ...signed, sig: digestSignature },
				expectedSource: signed.src,
				publicKey: await publicKey(),
			}),
		).rejects.toBeInstanceOf(InvalidLabelSignatureError);
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
		const key = await publicKey();
		for (const label of [
			{ ...signed, sig: asHighS(signed.sig) },
			{ ...signed, val: "assessment-pending" },
		]) {
			await expect(
				verifyLabelWithPublicKey({ label, expectedSource: signed.src, publicKey: key }),
			).rejects.toBeInstanceOf(InvalidLabelSignatureError);
		}
		await expect(
			verifyLabelWithPublicKey({
				label: { ...signed, sig: new Uint8Array(70) },
				expectedSource: signed.src,
				publicKey: key,
			}),
		).rejects.not.toBeInstanceOf(InvalidLabelSignatureError);
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
