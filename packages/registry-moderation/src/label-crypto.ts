import { encode, toBytes } from "@atcute/cbor";
import { P256PrivateKey, P256PublicKey, parsePublicMultikey } from "@atcute/crypto";
import { fromBase64Url, toBase64Url } from "@atcute/multibase";

import { PROFILE_COLLECTION, RELEASE_COLLECTION, type ListingLabelEvent } from "./labels.js";
import { assertCanonicalCid, assertDid, isDid, parseAtUri, parseInstant } from "./validation.js";

export interface SignedListingLabel extends ListingLabelEvent {
	sig: Uint8Array;
}

const verifiedListingLabel = Symbol("verifiedListingLabel");
const verifiedListingLabels = new WeakSet<object>();

export type VerifiedListingLabel = Readonly<ListingLabelEvent> & {
	readonly [verifiedListingLabel]: true;
};

export interface DidVerificationMethod {
	id: string;
	type: string;
	controller: string;
	publicKeyMultibase: string;
}

export interface LabelDidDocument {
	id: string;
	verificationMethod?: readonly DidVerificationMethod[];
}

export type LabelDidResolver = (did: string) => Promise<LabelDidDocument>;

export interface CreateListingLabelSignerInput {
	issuerDid: string;
	privateKey: string;
	resolveDid: LabelDidResolver;
}

export interface ListingLabelSigner {
	readonly issuerDid: string;
	sign(label: Omit<ListingLabelEvent, "src">): Promise<SignedListingLabel>;
}

export interface ListingLabelVerificationInput {
	label: SignedListingLabel;
	resolveDid: LabelDidResolver;
}

export class InvalidListingLabelSignatureError extends TypeError {
	constructor(message: string) {
		super(message);
		this.name = "InvalidListingLabelSignatureError";
	}
}

const P256_ORDER = BigInt("0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551");
const LABEL_FIELDS = new Set(["ver", "src", "uri", "cid", "val", "neg", "cts", "exp"]);
const SIGNED_LABEL_FIELDS = new Set([...LABEL_FIELDS, "sig"]);
const PRINTABLE_LABEL_VALUE = /^[^\p{Cc}]{1,128}$/u;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

function scalarToBigInt(bytes: Uint8Array): bigint {
	let value = 0n;
	for (const byte of bytes) value = (value << 8n) | BigInt(byte);
	return value;
}

function utf8Length(value: string): number {
	let length = 0;
	for (let index = 0; index < value.length; index++) {
		const codeUnit = value.charCodeAt(index);
		if (codeUnit <= 0x7f) length++;
		else if (codeUnit <= 0x7ff) length += 2;
		else if (
			codeUnit >= 0xd800 &&
			codeUnit <= 0xdbff &&
			value.charCodeAt(index + 1) >= 0xdc00 &&
			value.charCodeAt(index + 1) <= 0xdfff
		) {
			length += 4;
			index++;
		} else length += 3;
	}
	return length;
}

function validateLabelValue(value: unknown): asserts value is string {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		!PRINTABLE_LABEL_VALUE.test(value) ||
		utf8Length(value) > 128
	) {
		throw new TypeError(
			"label.val must be a non-empty printable string of at most 128 UTF-8 bytes",
		);
	}
}

function validateLabelUri(value: unknown): asserts value is string {
	if (isDid(value)) return;
	const subject = parseAtUri(value, "label.uri");
	if (subject.collection !== PROFILE_COLLECTION && subject.collection !== RELEASE_COLLECTION) {
		throw new TypeError("label.uri must identify a plugin profile or release record");
	}
}

function getField(value: object, field: string): unknown {
	return Object.getOwnPropertyDescriptor(value, field)?.value;
}

function validateLabelObject(value: unknown, signed: true): SignedListingLabel;
function validateLabelObject(value: unknown, signed: false): ListingLabelEvent;
function validateLabelObject(
	value: unknown,
	signed: boolean,
): SignedListingLabel | ListingLabelEvent {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new TypeError("label must be an object");
	}
	const fields = signed ? SIGNED_LABEL_FIELDS : LABEL_FIELDS;
	for (const field of Object.keys(value)) {
		if (!fields.has(field)) throw new TypeError(`label contains unsupported field: ${field}`);
	}
	if (getField(value, "ver") !== 1) throw new TypeError("label.ver must be 1");
	const src = getField(value, "src");
	const uri = getField(value, "uri");
	const cid = getField(value, "cid");
	const val = getField(value, "val");
	const neg = getField(value, "neg");
	const cts = getField(value, "cts");
	const exp = getField(value, "exp");
	assertDid(src, "label.src");
	validateLabelUri(uri);
	validateLabelValue(val);
	if (typeof cts !== "string") throw new TypeError("label.cts must be a valid RFC 3339 timestamp");
	parseInstant(cts, "label.cts");
	if (cid !== undefined) assertCanonicalCid(cid, "label.cid");
	if (isDid(uri) && cid !== undefined) throw new TypeError("DID-scoped labels must not have a CID");
	if (neg !== undefined && typeof neg !== "boolean") {
		throw new TypeError("label.neg must be a boolean");
	}
	if (exp !== undefined) {
		if (typeof exp !== "string") {
			throw new TypeError("label.exp must be a valid RFC 3339 timestamp");
		}
		parseInstant(exp, "label.exp");
	}
	const canonical = {
		ver: 1 as const,
		src,
		uri,
		...(cid === undefined ? {} : { cid }),
		val,
		...(neg === true ? { neg: true } : {}),
		cts,
		...(exp === undefined ? {} : { exp }),
	};
	if (!signed) return canonical;
	const sig = getField(value, "sig");
	if (!(sig instanceof Uint8Array) || sig.length !== 64) {
		throw new TypeError("label.sig must be a 64-byte compact P-256 signature");
	}
	return { ...canonical, sig: Uint8Array.from(sig) };
}

function canonicalLabelBytes(label: ListingLabelEvent): Uint8Array {
	return encode(validateLabelObject(label, false));
}

export function parseListingLabel(value: unknown): ListingLabelEvent {
	return validateLabelObject(value, false);
}

export function parseSignedListingLabel(value: unknown): SignedListingLabel {
	return validateLabelObject(value, true);
}

export function encodeSignedListingLabel(label: SignedListingLabel): Uint8Array {
	const { sig, ...unsigned } = parseSignedListingLabel(label);
	return encode({ ...unsigned, sig: toBytes(sig) });
}

function importPrivateScalar(value: string): Promise<P256PrivateKey> {
	if (!BASE64URL.test(value)) {
		throw new TypeError("privateKey must be canonical unpadded base64url");
	}
	let bytes: Uint8Array;
	try {
		bytes = fromBase64Url(value);
	} catch {
		throw new TypeError("privateKey must be canonical unpadded base64url");
	}
	if (bytes.length !== 32 || toBase64Url(bytes) !== value) {
		throw new TypeError("privateKey must be canonical unpadded base64url for exactly 32 bytes");
	}
	const scalar = scalarToBigInt(bytes);
	if (scalar === 0n || scalar >= P256_ORDER) {
		throw new TypeError("privateKey must be in the P-256 scalar range");
	}
	return P256PrivateKey.importRaw(bytes);
}

function normalizedMethodId(documentId: string, methodId: string): string {
	return methodId.startsWith("#") ? `${documentId}${methodId}` : methodId;
}

async function resolveLabelPublicKey(
	did: string,
	resolveDid: LabelDidResolver,
): Promise<P256PublicKey> {
	const document = await resolveDid(did);
	assertDid(document.id, "DID document id");
	if (document.id !== did) throw new TypeError("DID document id does not match label source");
	const ids = new Set<string>();
	let signingMethod: DidVerificationMethod | undefined;
	for (const method of document.verificationMethod ?? []) {
		const id = normalizedMethodId(document.id, method.id);
		if (ids.has(id)) throw new TypeError("DID document has duplicate verification method ids");
		ids.add(id);
		if (id === `${did}#atproto_label`) signingMethod = { ...method, id };
	}
	if (!signingMethod) throw new TypeError("DID document has no #atproto_label verification method");
	if (signingMethod.type !== "Multikey" || signingMethod.controller !== did) {
		throw new TypeError("#atproto_label verification method must be a controller-owned Multikey");
	}
	let parsed: ReturnType<typeof parsePublicMultikey>;
	try {
		parsed = parsePublicMultikey(signingMethod.publicKeyMultibase);
	} catch {
		throw new TypeError("#atproto_label verification method has an invalid Multikey");
	}
	if (
		parsed.type !== "p256" ||
		parsed.publicKeyBytes.length !== 33 ||
		![2, 3].includes(parsed.publicKeyBytes[0]!)
	) {
		throw new TypeError("#atproto_label verification method must contain a compressed P-256 key");
	}
	const key = await P256PublicKey.importRaw(parsed.publicKeyBytes);
	if ((await key.exportPublicKey("multikey")) !== signingMethod.publicKeyMultibase) {
		throw new TypeError("#atproto_label verification method uses a non-canonical P-256 Multikey");
	}
	return key;
}

export async function createListingLabelSigner(
	input: CreateListingLabelSignerInput,
): Promise<ListingLabelSigner> {
	assertDid(input.issuerDid, "issuerDid");
	const key = await importPrivateScalar(input.privateKey);
	const resolved = await resolveLabelPublicKey(input.issuerDid, input.resolveDid);
	if ((await key.exportPublicKey("multikey")) !== (await resolved.exportPublicKey("multikey"))) {
		throw new TypeError(
			"privateKey does not match the issuer DID #atproto_label verification method",
		);
	}
	return {
		issuerDid: input.issuerDid,
		async sign(label) {
			const unsigned = validateLabelObject({ ...label, src: input.issuerDid }, false);
			return { ...unsigned, sig: await key.sign(canonicalLabelBytes(unsigned)) };
		},
	};
}

function brandVerifiedListingLabel(label: ListingLabelEvent): VerifiedListingLabel {
	const verified: VerifiedListingLabel = { ...label, [verifiedListingLabel]: true };
	Object.defineProperty(verified, verifiedListingLabel, { value: true, enumerable: false });
	Object.freeze(verified);
	verifiedListingLabels.add(verified);
	return verified;
}

export function isVerifiedListingLabel(value: unknown): value is VerifiedListingLabel {
	return (
		typeof value === "object" &&
		value !== null &&
		verifiedListingLabels.has(value) &&
		Object.getOwnPropertyDescriptor(value, verifiedListingLabel)?.value === true
	);
}

export async function verifyListingLabelWithPublicKey(input: {
	label: SignedListingLabel;
	expectedSource: string;
	publicKey: P256PublicKey;
}): Promise<VerifiedListingLabel> {
	assertDid(input.expectedSource, "expectedSource");
	const label = parseSignedListingLabel(input.label);
	if (label.src !== input.expectedSource) {
		throw new TypeError("label.src does not match expectedSource");
	}
	const { sig, ...unsigned } = label;
	if (!(await input.publicKey.verify(sig, canonicalLabelBytes(unsigned)))) {
		throw new InvalidListingLabelSignatureError("label signature is invalid");
	}
	return brandVerifiedListingLabel(unsigned);
}

export async function verifyListingLabel(
	input: ListingLabelVerificationInput,
): Promise<VerifiedListingLabel> {
	const label = parseSignedListingLabel(input.label);
	const publicKey = await resolveLabelPublicKey(label.src, input.resolveDid);
	return verifyListingLabelWithPublicKey({
		label,
		expectedSource: label.src,
		publicKey,
	});
}
