import { encode } from "@atcute/cbor";
import { P256PrivateKey, P256PublicKey, parsePublicMultikey } from "@atcute/crypto";
import { isCid, isDatetime, isDid, isGenericUri } from "@atcute/lexicons/syntax";
import { fromBase64Url, toBase64Url } from "@atcute/multibase";
import { describe, expect, it } from "vitest";

import vector from "../../../.opencode/plans/plugin-registry-labelling-service/gate-0/fixtures/crypto/p256-label-v1.json" with { type: "json" };

const ALLOWED_UNSIGNED_V1_FIELDS = new Set([
	"ver",
	"src",
	"uri",
	"cid",
	"val",
	"neg",
	"cts",
	"exp",
]);

const P256_ORDER = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;

interface UnsignedLabelV1 {
	ver: 1;
	src: string;
	uri: string;
	cid?: string;
	val: string;
	neg?: boolean;
	cts: string;
	exp?: string;
}

function constructUnsignedLabelV1(input: Record<string, unknown>): UnsignedLabelV1 {
	for (const field of Object.keys(input)) {
		if (!ALLOWED_UNSIGNED_V1_FIELDS.has(field)) {
			throw new TypeError(`unexpected label field: ${field}`);
		}
	}

	if (input.ver !== 1) throw new TypeError("label ver must be 1");
	const src = requireDid(input.src);
	const uri = requireUri(input.uri);
	const cid = optionalCid(input.cid);
	const val = requireLabelValue(input.val);
	const neg = optionalBoolean(input.neg, "neg");
	const cts = requireDatetime(input.cts, "cts");
	const exp = optionalDatetime(input.exp, "exp");

	return {
		ver: 1,
		src,
		uri,
		...(cid === undefined ? {} : { cid }),
		val,
		...(neg === true ? { neg: true } : {}),
		cts,
		...(exp === undefined ? {} : { exp }),
	};
}

function requireDid(value: unknown): string {
	if (!isDid(value)) throw new TypeError("label src must be a DID");
	return value;
}

function requireUri(value: unknown): string {
	if (!isGenericUri(value)) throw new TypeError("label uri must be a URI");
	return value;
}

function optionalCid(value: unknown): string | undefined {
	if (value !== undefined && !isCid(value)) throw new TypeError("label cid must be a CID");
	return value;
}

function requireLabelValue(value: unknown): string {
	if (typeof value !== "string") throw new TypeError("label val must be a string");
	const length = new TextEncoder().encode(value).length;
	if (length < 1 || length > 128)
		throw new TypeError("label val must contain 1 to 128 UTF-8 bytes");
	return value;
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
	if (value !== undefined && typeof value !== "boolean") {
		throw new TypeError(`label ${field} must be a boolean`);
	}
	return value;
}

function requireDatetime(value: unknown, field: string): string {
	if (!isDatetime(value) || !hasValidCalendarDate(value)) {
		throw new TypeError(`label ${field} must be an RFC3339 datetime`);
	}
	return value;
}

function optionalDatetime(value: unknown, field: string): string | undefined {
	if (value !== undefined && (!isDatetime(value) || !hasValidCalendarDate(value))) {
		throw new TypeError(`label ${field} must be an RFC3339 datetime`);
	}
	return value;
}

function hasValidCalendarDate(value: string): boolean {
	const match = /^(\d{4})-(\d{2})-(\d{2})T/.exec(value);
	if (!match) return false;
	const year = Number(match[1]);
	const month = Number(match[2]);
	const day = Number(match[3]);
	return day <= new Date(Date.UTC(year, month, 0)).getUTCDate() && !Number.isNaN(Date.parse(value));
}

function decodePrivateScalar(value: string): Uint8Array {
	if (!/^[A-Za-z0-9_-]+$/.test(value)) {
		throw new TypeError("private scalar must be unpadded base64url");
	}

	const bytes = fromBase64Url(value);
	if (toBase64Url(bytes) !== value)
		throw new TypeError("private scalar must use canonical base64url");
	if (bytes.length !== 32) throw new TypeError("private scalar must be exactly 32 bytes");

	const scalar = BigInt(`0x${toHex(bytes)}`);
	if (scalar < 1n || scalar >= P256_ORDER)
		throw new TypeError("private scalar is outside P-256 range");
	return bytes;
}

interface DidVerificationMethod {
	id: string;
	type: string;
	controller: string;
	publicKeyMultibase: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function getLabelVerificationMethod(
	document: unknown,
	issuerDid: string,
	signerPublicMultikey: string,
): Promise<DidVerificationMethod> {
	if (!isDid(issuerDid)) throw new TypeError("issuer must be a DID");
	if (!isRecord(document)) throw new TypeError("invalid DID document");
	if (document.id !== issuerDid) throw new TypeError("DID document does not belong to issuer");
	if (!Array.isArray(document.verificationMethod)) {
		throw new TypeError("DID document verificationMethod must be an array");
	}
	const id = `${issuerDid}#atproto_label`;
	const matches = document.verificationMethod.filter(
		(method): method is Record<string, unknown> =>
			isRecord(method) && (method.id === "#atproto_label" || method.id === id),
	);
	if (matches.length !== 1)
		throw new TypeError("DID document must contain exactly one #atproto_label key");

	const method = matches[0];
	if (!method) throw new TypeError("missing #atproto_label key");
	if (method.type !== "Multikey") throw new TypeError("#atproto_label must use Multikey");
	if (method.controller !== issuerDid)
		throw new TypeError("#atproto_label controller must equal issuer DID");
	if (typeof method.publicKeyMultibase !== "string") {
		throw new TypeError("#atproto_label must contain publicKeyMultibase");
	}
	const parsed = parsePublicMultikey(method.publicKeyMultibase);
	if (parsed.type !== "p256")
		throw new TypeError("#atproto_label must use the P-256 multikey codec");
	if (
		parsed.publicKeyBytes.length !== 33 ||
		![0x02, 0x03].includes(parsed.publicKeyBytes[0] ?? 0)
	) {
		throw new TypeError("#atproto_label must contain a compressed P-256 public key");
	}
	await P256PublicKey.importRaw(parsed.publicKeyBytes);
	if (method.publicKeyMultibase !== signerPublicMultikey) {
		throw new TypeError("#atproto_label public key must match the signer-derived multikey");
	}
	return {
		id,
		type: method.type,
		controller: method.controller,
		publicKeyMultibase: method.publicKeyMultibase,
	};
}

function fromHex(value: string): Uint8Array {
	if (!/^(?:[0-9a-f]{2})+$/i.test(value)) throw new TypeError("invalid hex bytes");
	return Uint8Array.from(value.match(/.{2}/g) ?? [], (byte) => Number.parseInt(byte, 16));
}

function toHex(value: Uint8Array): string {
	return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function highSEquivalent(signature: Uint8Array): Uint8Array {
	const highS = P256_ORDER - BigInt(`0x${toHex(signature.slice(32))}`);
	const result = signature.slice();
	result.set(fromHex(highS.toString(16).padStart(64, "0")), 32);
	return result;
}

function compactToDer(signature: Uint8Array): Uint8Array {
	const integer = (value: Uint8Array): Uint8Array => {
		let offset = 0;
		while (offset < value.length - 1 && value[offset] === 0) offset++;
		const bytes = value.slice(offset);
		const needsPositivePrefix = ((bytes[0] ?? 0) & 0x80) !== 0;
		return Uint8Array.of(
			0x02,
			bytes.length + (needsPositivePrefix ? 1 : 0),
			...(needsPositivePrefix ? [0] : []),
			...bytes,
		);
	};
	const r = integer(signature.slice(0, 32));
	const s = integer(signature.slice(32));
	return Uint8Array.of(0x30, r.length + s.length, ...r, ...s);
}

describe("ATProto label v1 crypto interoperability", () => {
	it("constructs deterministic DRISL bytes and SHA-256 hash", async () => {
		const label = constructUnsignedLabelV1(vector.label);
		const canonicalBytes = encode(label);

		expect(toHex(canonicalBytes)).toBe(vector.canonicalCborHex);
		expect(toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", canonicalBytes)))).toBe(
			vector.sha256Hex,
		);
	});

	it("signs and verifies locally in workerd with P-256", async () => {
		const label = constructUnsignedLabelV1(vector.label);
		const canonicalBytes = encode(label);
		const privateKey = await P256PrivateKey.importRaw(
			decodePrivateScalar(vector.key.testPrivateKeyRawBase64Url),
		);
		const signature = await privateKey.sign(canonicalBytes);

		expect(signature).toHaveLength(64);
		expect(await privateKey.exportPublicKey("did")).toBe(vector.key.publicKeyDid);
		expect(await privateKey.exportPublicKey("multikey")).toBe(vector.key.publicKeyMultikey);
		expect(await privateKey.verify(signature, canonicalBytes)).toBe(true);
	});

	it("does not double-hash by passing the protocol digest to the high-level API", async () => {
		const canonicalBytes = encode(constructUnsignedLabelV1(vector.label));
		const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", canonicalBytes));
		const privateKey = await P256PrivateKey.importRaw(
			decodePrivateScalar(vector.key.testPrivateKeyRawBase64Url),
		);
		const doubleHashedSignature = await privateKey.sign(digest);

		expect(await privateKey.verify(doubleHashedSignature, digest)).toBe(true);
		expect(await privateKey.verify(doubleHashedSignature, canonicalBytes)).toBe(false);
	});

	it("verifies the independently signed @atproto/crypto vector", async () => {
		const publicKey = await P256PublicKey.importRaw(fromHex(vector.key.publicKeyRawHex));
		const canonicalBytes = encode(constructUnsignedLabelV1(vector.label));

		expect(
			await publicKey.verify(fromHex(vector.signatures.atprotoReferenceHex), canonicalBytes),
		).toBe(true);
	});

	it("retains the workerd signature verified by the independent implementation", async () => {
		const publicKey = await P256PublicKey.importRaw(fromHex(vector.key.publicKeyRawHex));
		const canonicalBytes = encode(constructUnsignedLabelV1(vector.label));

		expect(
			await publicKey.verify(fromHex(vector.signatures.atcuteWebcryptoHex), canonicalBytes),
		).toBe(true);
	});

	it("requires the exact P-256 #atproto_label DID verification method", async () => {
		const method = await getLabelVerificationMethod(
			vector.didDocument,
			vector.label.src,
			vector.key.publicKeyMultikey,
		);
		expect(method.id).toBe(`${vector.label.src}#atproto_label`);
		expect(method.publicKeyMultibase).toBe(vector.key.publicKeyMultikey);

		const relativeMethod = await getLabelVerificationMethod(
			{ ...vector.didDocument, verificationMethod: [{ ...method, id: "#atproto_label" }] },
			vector.label.src,
			vector.key.publicKeyMultikey,
		);
		expect(relativeMethod.id).toBe(`${vector.label.src}#atproto_label`);
		expect(relativeMethod.publicKeyMultibase).toBe(vector.key.publicKeyMultikey);
		const relative = { ...method, id: "#atproto_label" };
		for (const verificationMethod of [
			[method, relative],
			[relative, method],
			[method, method],
		]) {
			await expect(
				getLabelVerificationMethod(
					{ ...vector.didDocument, verificationMethod },
					vector.label.src,
					vector.key.publicKeyMultikey,
				),
			).rejects.toThrow("exactly one #atproto_label key");
		}
		await expect(
			getLabelVerificationMethod(
				{ ...vector.didDocument, verificationMethod: [{ ...method, type: "JsonWebKey2020" }] },
				vector.label.src,
				vector.key.publicKeyMultikey,
			),
		).rejects.toThrow("must use Multikey");
		await expect(
			getLabelVerificationMethod(
				{
					...vector.didDocument,
					verificationMethod: [{ ...method, controller: "did:web:other.test" }],
				},
				vector.label.src,
				vector.key.publicKeyMultikey,
			),
		).rejects.toThrow("controller must equal issuer DID");
		await expect(
			getLabelVerificationMethod(
				{
					...vector.didDocument,
					verificationMethod: [{ ...method, publicKeyMultibase: undefined as unknown as string }],
				},
				vector.label.src,
				vector.key.publicKeyMultikey,
			),
		).rejects.toThrow("must contain publicKeyMultibase");
		await expect(
			getLabelVerificationMethod(
				{
					...vector.didDocument,
					verificationMethod: [
						{ ...method, publicKeyMultibase: "zQ3shqwJEJyMBsBXCWyCBpUBMqxcon9oHB7mCvx4sSpMdLJwc" },
					],
				},
				vector.label.src,
				vector.key.publicKeyMultikey,
			),
		).rejects.toThrow("must use the P-256 multikey codec");
		await expect(
			getLabelVerificationMethod(
				{
					...vector.didDocument,
					verificationMethod: [{ ...method, id: `${vector.label.src}#atproto` }],
				},
				vector.label.src,
				vector.key.publicKeyMultikey,
			),
		).rejects.toThrow("exactly one #atproto_label key");

		const otherKey = await P256PrivateKey.importRaw(
			fromHex("0000000000000000000000000000000000000000000000000000000000000002"),
		);
		const otherMultikey = await otherKey.exportPublicKey("multikey");
		await expect(
			getLabelVerificationMethod(
				{
					...vector.didDocument,
					verificationMethod: [{ ...method, publicKeyMultibase: otherMultikey }],
				},
				vector.label.src,
				vector.key.publicKeyMultikey,
			),
		).rejects.toThrow("must match the signer-derived multikey");
		await expect(
			getLabelVerificationMethod(
				vector.didDocument,
				"did:web:other.test",
				vector.key.publicKeyMultikey,
			),
		).rejects.toThrow("DID document does not belong to issuer");
		await expect(
			getLabelVerificationMethod(
				{ id: vector.label.src },
				vector.label.src,
				vector.key.publicKeyMultikey,
			),
		).rejects.toThrow("verificationMethod must be an array");
		await expect(
			getLabelVerificationMethod(null, vector.label.src, vector.key.publicKeyMultikey),
		).rejects.toThrow("invalid DID document");
	});

	it.each(["sig", "$type", "purpose"])("rejects the extra %s field before encoding", (field) => {
		expect(() => constructUnsignedLabelV1({ ...vector.label, [field]: "not-allowed" })).toThrow(
			`unexpected label field: ${field}`,
		);
	});

	it("rejects malformed allowed fields before encoding", () => {
		expect(() => constructUnsignedLabelV1({ ...vector.label, ver: 2 })).toThrow(
			"label ver must be 1",
		);
		expect(() => constructUnsignedLabelV1({ ...vector.label, src: "not-a-did" })).toThrow(
			"label src must be a DID",
		);
		expect(() => constructUnsignedLabelV1({ ...vector.label, uri: "not a uri" })).toThrow(
			"label uri must be a URI",
		);
		expect(() => constructUnsignedLabelV1({ ...vector.label, cid: "not-a-cid" })).toThrow(
			"label cid must be a CID",
		);
		expect(() => constructUnsignedLabelV1({ ...vector.label, val: "" })).toThrow(
			"1 to 128 UTF-8 bytes",
		);
		expect(() => constructUnsignedLabelV1({ ...vector.label, val: "é".repeat(65) })).toThrow(
			"1 to 128 UTF-8 bytes",
		);
		expect(() => constructUnsignedLabelV1({ ...vector.label, neg: "true" })).toThrow(
			"label neg must be a boolean",
		);
		expect(() => constructUnsignedLabelV1({ ...vector.label, cts: "2026-07-10" })).toThrow(
			"label cts must be an RFC3339 datetime",
		);
		expect(() =>
			constructUnsignedLabelV1({ ...vector.label, cts: "2026-02-31T12:34:56Z" }),
		).toThrow("label cts must be an RFC3339 datetime");
		expect(() => constructUnsignedLabelV1({ ...vector.label, exp: "tomorrow" })).toThrow(
			"label exp must be an RFC3339 datetime",
		);

		const withFalse = constructUnsignedLabelV1({ ...vector.label, neg: false });
		expect(withFalse).not.toHaveProperty("neg");
		expect(encode(withFalse)).toEqual(encode(constructUnsignedLabelV1(vector.label)));
	});

	it("strictly decodes an in-range canonical 32-byte private scalar", () => {
		expect(toBase64Url(decodePrivateScalar(vector.key.testPrivateKeyRawBase64Url))).toBe(
			vector.key.testPrivateKeyRawBase64Url,
		);
		expect(() => decodePrivateScalar(`${vector.key.testPrivateKeyRawBase64Url}=`)).toThrow(
			"unpadded base64url",
		);
		expect(() => decodePrivateScalar("not+base64url")).toThrow("unpadded base64url");
		expect(() =>
			decodePrivateScalar(`${vector.key.testPrivateKeyRawBase64Url.slice(0, -1)}F`),
		).toThrow("canonical base64url");
		expect(() => decodePrivateScalar(toBase64Url(new Uint8Array(31).fill(1)))).toThrow(
			"exactly 32 bytes",
		);
		expect(() => decodePrivateScalar(toBase64Url(new Uint8Array(32)))).toThrow(
			"outside P-256 range",
		);
		expect(() => decodePrivateScalar(toBase64Url(fromHex(P256_ORDER.toString(16))))).toThrow(
			"outside P-256 range",
		);
	});

	it("rejects a wrong key, changed payload, and malformed signatures", async () => {
		const canonicalBytes = encode(constructUnsignedLabelV1(vector.label));
		const signature = fromHex(vector.signatures.atprotoReferenceHex);
		const wrongKey = await P256PrivateKey.importRaw(
			fromHex("0000000000000000000000000000000000000000000000000000000000000002"),
		);
		const publicKey = await P256PublicKey.importRaw(fromHex(vector.key.publicKeyRawHex));
		const changedBytes = encode(
			constructUnsignedLabelV1({ ...vector.label, val: "assessment-warning" }),
		);
		const changedSignature = signature.slice();
		changedSignature[0] = (changedSignature[0] ?? 0) ^ 0x01;
		const highS = highSEquivalent(signature);
		const der = compactToDer(signature);

		expect(await wrongKey.verify(signature, canonicalBytes)).toBe(false);
		expect(await publicKey.verify(signature, changedBytes)).toBe(false);
		expect(await publicKey.verify(signature, Uint8Array.of(0xff))).toBe(false);
		expect(await publicKey.verify(changedSignature, canonicalBytes)).toBe(false);
		expect(highS).toHaveLength(64);
		expect(await publicKey.verify(highS, canonicalBytes)).toBe(false);
		expect(der.length).toBeGreaterThan(64);
		expect(await publicKey.verify(der, canonicalBytes)).toBe(false);
		expect(await publicKey.verify(signature.slice(0, 63), canonicalBytes)).toBe(false);
		expect(await publicKey.verify(new Uint8Array(65), canonicalBytes)).toBe(false);
	});
});
