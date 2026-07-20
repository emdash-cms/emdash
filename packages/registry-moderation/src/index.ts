import { encode, toBytes } from "@atcute/cbor";
import { fromString as cidFromString, toString as cidToString } from "@atcute/cid";
import { P256PrivateKey, P256PublicKey, parsePublicMultikey } from "@atcute/crypto";
import { fromBase64Url, toBase64Url } from "@atcute/multibase";

import { DID } from "./did.js";

export {
	InvalidAcceptLabelersHeaderError,
	parseAcceptLabelersHeader,
	serializeContentLabelersHeader,
} from "./labeler-headers.js";

export type ModerationLabelValue =
	| "assessment-error"
	| "assessment-overridden"
	| "assessment-passed"
	| "assessment-pending"
	| "artifact-integrity-failure"
	| "broken-release"
	| "content-warning"
	| "credential-harvesting"
	| "critical-vulnerability"
	| "data-exfiltration"
	| "explicit-imagery"
	| "graphic-violence"
	| "hateful-imagery"
	| "impersonation"
	| "invalid-bundle"
	| "low-quality"
	| "malware"
	| "misleading-metadata"
	| "obfuscated-code"
	| "package-disputed"
	| "privacy-risk"
	| "publisher-compromised"
	| "security-yanked"
	| "supply-chain-compromise"
	| "suspicious-code"
	| "undeclared-access"
	| "!takedown";

/** The ATProto label fields used to reduce a signed label stream. */
export interface ModerationLabel {
	ver: 1;
	src: string;
	uri: string;
	val: ModerationLabelValue | (string & {});
	cts: string;
	cid?: string;
	neg?: boolean;
	exp?: string;
}

/** An ATProto label before its detached P-256 signature is added. */
export interface UnsignedLabel {
	ver: 1;
	src: string;
	uri: string;
	val: string;
	cts: string;
	cid?: string;
	neg?: boolean;
	exp?: string;
}

/** An ATProto label v1 with its compact P-256 signature. */
export interface SignedLabel extends UnsignedLabel {
	sig: Uint8Array;
}

const verifiedModerationLabel = Symbol("verifiedModerationLabel");

/** A label whose signature and source DID key have been verified by this package. */
export type VerifiedModerationLabel = ModerationLabel & {
	readonly [verifiedModerationLabel]: true;
};

export interface CreateLabelSignerInput {
	issuerDid: string;
	/** A canonical, unpadded base64url encoding of the 32-byte P-256 scalar. */
	privateKey: string;
	resolveDid: LabelDidResolver;
}

export interface LabelSigner {
	readonly issuerDid: string;
	sign(label: Omit<UnsignedLabel, "src">): Promise<SignedLabel>;
}

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

/** Resolves the DID document used exclusively for a label signature check. */
export type LabelDidResolver = (did: string) => Promise<LabelDidDocument>;

export interface LabelVerificationInput {
	label: SignedLabel;
	resolveDid: LabelDidResolver;
}

/** Indicates that a valid, correctly sourced label failed cryptographic verification. */
export class InvalidLabelSignatureError extends TypeError {
	constructor(message: string) {
		super(message);
		this.name = "InvalidLabelSignatureError";
	}
}

export interface AcceptedLabelerPolicy {
	did: string;
	redact: boolean;
}

export interface ReleaseSubjectContext {
	publisherDid: string;
	package: {
		uri: string;
		cid: string;
	};
	release: {
		uri: string;
		cid: string;
	};
}

export interface EvaluateReleaseModerationInput {
	acceptedLabelers: AcceptedLabelerPolicy[];
	context: ReleaseSubjectContext;
	evaluatedAt: Date | string;
	labels: VerifiedModerationLabel[];
}

export interface VerifyAndEvaluateReleaseModerationInput extends Omit<
	EvaluateReleaseModerationInput,
	"labels"
> {
	labels: SignedLabel[];
	resolveDid: LabelDidResolver;
}

export interface EvaluateHydratedReleaseModerationInput extends Omit<
	EvaluateReleaseModerationInput,
	"labels"
> {
	labels: ModerationLabel[];
}

export type ReleaseEligibility = "eligible" | "pending" | "error" | "blocked";

export interface ReleaseModeration {
	eligibility: ReleaseEligibility;
	reasonCodes: string[];
	blockingLabels: string[];
	stateLabels: string[];
	warningLabels: string[];
	suppressedLabels: string[];
	applicableLabels: ModerationLabel[];
	redacted: boolean;
}

/** Label values the labeler policy classifies as `automated-block`; each
 * hard-blocks a release. MUST stay in lock-step with the labeler policy
 * fixture's `automated-block` category (`apps/labeler/fixtures/moderation-policy.json`) --
 * a value the labeler can issue but this set omits is not enforced. */
export const AUTOMATED_BLOCKS: ReadonlySet<string> = new Set<string>([
	"malware",
	"data-exfiltration",
	"credential-harvesting",
	"supply-chain-compromise",
	"critical-vulnerability",
	"artifact-integrity-failure",
	"invalid-bundle",
	"impersonation",
	"hateful-imagery",
	"explicit-imagery",
	"graphic-violence",
]);

/** Label values the labeler policy classifies with `officialEffect: "warn"`;
 * non-blocking. MUST stay in lock-step with the labeler policy fixture's
 * warn-effect labels. */
export const WARNINGS: ReadonlySet<string> = new Set<string>([
	"suspicious-code",
	"obfuscated-code",
	"privacy-risk",
	"misleading-metadata",
	"low-quality",
	"broken-release",
	"content-warning",
	"package-disputed",
	"undeclared-access",
]);

const RELEASE_VALUES = new Set<string>([
	"assessment-error",
	"assessment-overridden",
	"assessment-passed",
	"assessment-pending",
	"security-yanked",
	"!takedown",
	...AUTOMATED_BLOCKS,
	...WARNINGS,
]);

/** Values that hard-block at package or publisher scope; search excludes subjects carrying them. */
export const PACKAGE_SCOPE_BLOCK_VALUES: readonly string[] = ["!takedown", "publisher-compromised"];
/** Values that make an individual release ineligible under official policy. */
export const RELEASE_BLOCK_VALUES: readonly string[] = [
	...AUTOMATED_BLOCKS,
	"security-yanked",
	"!takedown",
];

interface ParsedInstant {
	seconds: bigint;
	fraction: string;
}

interface LabelReduction {
	active: ModerationLabel[];
	collisions: ModerationLabel[][];
}

const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/;
const P256_ORDER = BigInt("0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551");
const LABEL_FIELDS = new Set(["ver", "src", "uri", "cid", "val", "neg", "cts", "exp"]);
const SIGNED_LABEL_FIELDS = new Set([...LABEL_FIELDS, "sig"]);
const PRINTABLE_LABEL_VALUE = /^[^\p{Cc}]{1,128}$/u;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const ATPROTO_URI =
	/^at:\/\/(?:did:[a-z0-9]+:[A-Za-z0-9._:%-]+|[A-Za-z0-9.-]+)\/[A-Za-z0-9.-]+(?:\/[A-Za-z0-9._~:%-]+)?$/;

function daysFromCivil(year: bigint, month: bigint, day: bigint): bigint {
	const adjustedYear = year - (month <= 2n ? 1n : 0n);
	const era = (adjustedYear >= 0n ? adjustedYear : adjustedYear - 399n) / 400n;
	const yearOfEra = adjustedYear - era * 400n;
	const shiftedMonth = month + (month > 2n ? -3n : 9n);
	const dayOfYear = (153n * shiftedMonth + 2n) / 5n + day - 1n;
	const dayOfEra = yearOfEra * 365n + yearOfEra / 4n - yearOfEra / 100n + dayOfYear;
	return era * 146_097n + dayOfEra - 719_468n;
}

function isLeapYear(year: number): boolean {
	return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function parseInstant(value: Date | string, field: string): ParsedInstant {
	if (value instanceof Date) {
		if (Number.isNaN(value.getTime()))
			throw new TypeError(`${field} must be a valid RFC 3339 timestamp`);
		return {
			seconds: BigInt(Math.floor(value.getTime() / 1000)),
			fraction: `${value.getMilliseconds()}`.padStart(3, "0"),
		};
	}
	const match = RFC3339.exec(value);
	if (!match) throw new TypeError(`${field} must be a valid RFC 3339 timestamp`);
	const [, yearText, monthText, dayText, hourText, minuteText, secondText, fraction = "", zone] =
		match;
	const year = Number(yearText);
	const month = Number(monthText);
	const day = Number(dayText);
	const hour = Number(hourText);
	const minute = Number(minuteText);
	const second = Number(secondText);
	const zoneText = zone!;
	const daysInMonth = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
	if (
		year === 0 ||
		month < 1 ||
		month > 12 ||
		day < 1 ||
		day > daysInMonth[month - 1]! ||
		hour > 23 ||
		minute > 59 ||
		second > 59
	) {
		throw new TypeError(`${field} must be a valid RFC 3339 timestamp`);
	}
	let offsetSeconds = 0n;
	if (zoneText !== "Z") {
		const offsetHour = Number(zoneText.slice(1, 3));
		const offsetMinute = Number(zoneText.slice(4, 6));
		if (
			(offsetHour === 0 && offsetMinute === 0 && zoneText[0] === "-") ||
			offsetHour > 23 ||
			offsetMinute > 59
		)
			throw new TypeError(`${field} must be a valid RFC 3339 timestamp`);
		offsetSeconds =
			BigInt(offsetHour * 3600 + offsetMinute * 60) * (zoneText[0] === "+" ? 1n : -1n);
	}
	return {
		seconds:
			daysFromCivil(BigInt(year), BigInt(month), BigInt(day)) * 86_400n +
			BigInt(hour * 3600 + minute * 60 + second) -
			offsetSeconds,
		fraction,
	};
}

function compareInstants(left: ParsedInstant, right: ParsedInstant): number {
	if (left.seconds !== right.seconds) return left.seconds < right.seconds ? -1 : 1;
	const length = Math.max(left.fraction.length, right.fraction.length);
	for (let index = 0; index < length; index++) {
		const leftDigit = left.fraction[index] ?? "0";
		const rightDigit = right.fraction[index] ?? "0";
		if (leftDigit !== rightDigit) return leftDigit < rightDigit ? -1 : 1;
	}
	return 0;
}

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

function validateDid(value: unknown, field: string): asserts value is string {
	if (typeof value !== "string" || !DID.test(value))
		throw new TypeError(`${field} must be a valid DID`);
}

function validateCid(value: unknown): asserts value is string {
	if (typeof value !== "string") throw new TypeError("label.cid must be a valid CID");
	try {
		const cid = cidFromString(value);
		if (cidToString(cid) !== value) throw new TypeError("label.cid must be a valid CID");
	} catch {
		throw new TypeError("label.cid must be a valid CID");
	}
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
	if (typeof value !== "string" || value.length === 0)
		throw new TypeError("label.uri must be a URI");
	if (DID.test(value)) return;
	if (!ATPROTO_URI.test(value)) throw new TypeError("label.uri must be an at:// URI or DID");
}

function getField(value: object, field: string): unknown {
	return Object.getOwnPropertyDescriptor(value, field)?.value;
}

function validateLabelObject(value: unknown, signed: true): SignedLabel;
function validateLabelObject(value: unknown, signed: false): UnsignedLabel;
function validateLabelObject(value: unknown, signed: boolean): SignedLabel | UnsignedLabel {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new TypeError("label must be an object");
	const fields = signed ? SIGNED_LABEL_FIELDS : LABEL_FIELDS;
	for (const field of Object.keys(value)) {
		if (!fields.has(field)) throw new TypeError(`label contains unsupported field: ${field}`);
	}
	if (getField(value, "ver") !== 1) throw new TypeError("label.ver must be 1");
	const src = getField(value, "src");
	const uri = getField(value, "uri");
	const val = getField(value, "val");
	const cts = getField(value, "cts");
	const cid = getField(value, "cid");
	const neg = getField(value, "neg");
	const exp = getField(value, "exp");
	validateDid(src, "label.src");
	validateLabelUri(uri);
	validateLabelValue(val);
	if (typeof cts !== "string") throw new TypeError("label.cts must be a valid RFC 3339 timestamp");
	parseInstant(cts, "label.cts");
	if (exp !== undefined) {
		if (typeof exp !== "string")
			throw new TypeError("label.exp must be a valid RFC 3339 timestamp");
		parseInstant(exp, "label.exp");
	}
	if (cid !== undefined) validateCid(cid);
	if (neg !== undefined && typeof neg !== "boolean")
		throw new TypeError("label.neg must be a boolean");
	const sig = getField(value, "sig");

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
	if (!(sig instanceof Uint8Array) || sig.length !== 64)
		throw new TypeError("label.sig must be a 64-byte compact P-256 signature");
	return { ...canonical, sig: Uint8Array.from(sig) };
}

function canonicalLabelBytes(label: UnsignedLabel): Uint8Array {
	return encode(validateLabelObject(label, false));
}

/** Parses and canonically reconstructs an unknown signed ATProto label v1 value. */
export function parseSignedLabel(value: unknown): SignedLabel {
	return validateLabelObject(value, true);
}

/** Parses and canonically reconstructs an unknown unsigned ATProto label v1 value. */
export function parseModerationLabel(value: unknown): ModerationLabel {
	return validateLabelObject(value, false);
}

/**
 * Encodes a complete signed label as deterministic canonical CBOR for digest
 * or identity use after successful verification. Encoding alone does not
 * authenticate a label.
 */
export function encodeSignedLabel(label: SignedLabel): Uint8Array {
	const { sig, ...unsigned } = parseSignedLabel(label);
	return encode({ ...unsigned, sig: toBytes(sig) });
}

function importPrivateScalar(value: string): Promise<P256PrivateKey> {
	if (!BASE64URL.test(value))
		throw new TypeError("privateKey must be canonical unpadded base64url");
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
	if (scalar === 0n || scalar >= P256_ORDER)
		throw new TypeError("privateKey must be in the P-256 scalar range");
	return P256PrivateKey.importRaw(bytes);
}

function normalizedMethodId(documentId: string, methodId: string): string {
	if (methodId.startsWith("#")) return `${documentId}${methodId}`;
	return methodId;
}

async function resolveLabelPublicKey(
	did: string,
	resolveDid: LabelDidResolver,
): Promise<P256PublicKey> {
	const document = await resolveDid(did);
	validateDid(document.id, "DID document id");
	if (document.id !== did) throw new TypeError("DID document id does not match label source");
	const methods = document.verificationMethod ?? [];
	const ids = new Set<string>();
	let signingMethod: DidVerificationMethod | undefined;
	for (const method of methods) {
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

/** Creates a signer whose scalar is bound to the issuer DID's exact `#atproto_label` key. */
export async function createLabelSigner(input: CreateLabelSignerInput): Promise<LabelSigner> {
	validateDid(input.issuerDid, "issuerDid");
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

/** Verifies a signed label against an expected source and resolved P-256 public key. */
export async function verifyLabelWithPublicKey(input: {
	label: SignedLabel;
	expectedSource: string;
	publicKey: P256PublicKey;
}): Promise<VerifiedModerationLabel> {
	validateDid(input.expectedSource, "expectedSource");
	const label = parseSignedLabel(input.label);
	if (label.src !== input.expectedSource)
		throw new TypeError("label.src does not match expectedSource");
	const { sig, ...verified } = label;
	if (!(await input.publicKey.verify(sig, canonicalLabelBytes(verified))))
		throw new InvalidLabelSignatureError("label signature is invalid");
	const verifiedLabel: VerifiedModerationLabel = { ...verified, [verifiedModerationLabel]: true };
	Object.defineProperty(verifiedLabel, verifiedModerationLabel, { enumerable: false });
	return verifiedLabel;
}

/** Verifies a signed label against the source DID's exact `#atproto_label` P-256 key. */
export async function verifyLabel(input: LabelVerificationInput): Promise<VerifiedModerationLabel> {
	const label = parseSignedLabel(input.label);
	const publicKey = await resolveLabelPublicKey(label.src, input.resolveDid);
	return verifyLabelWithPublicKey({ label, expectedSource: label.src, publicKey });
}

function streamKey(label: ModerationLabel): string {
	return `${label.src}\u0000${label.uri}\u0000${label.val}`;
}

function isSameEvent(left: ModerationLabel, right: ModerationLabel): boolean {
	return (
		left.ver === right.ver &&
		left.src === right.src &&
		left.uri === right.uri &&
		left.cid === right.cid &&
		left.val === right.val &&
		(left.neg === true) === (right.neg === true) &&
		left.cts === right.cts &&
		left.exp === right.exp
	);
}

/**
 * Reduces each `(src, uri, val)` label stream to its current winner. CID is
 * deliberately excluded from the key so a CID-bearing negation replaces it.
 */
function reduceLabels(labels: ModerationLabel[], evaluatedAt: Date | string): LabelReduction {
	const now = parseInstant(evaluatedAt, "evaluatedAt");
	const streams = new Map<
		string,
		{ label: ModerationLabel; cts: ParsedInstant; exp?: ParsedInstant }[]
	>();

	for (const label of labels) {
		const entry = {
			label,
			cts: parseInstant(label.cts, "label.cts"),
			exp: label.exp === undefined ? undefined : parseInstant(label.exp, "label.exp"),
		};
		const key = streamKey(label);
		const entries = streams.get(key);
		if (entries) entries.push(entry);
		else streams.set(key, [entry]);
	}

	const active: ModerationLabel[] = [];
	const collisions: ModerationLabel[][] = [];
	for (const entries of streams.values()) {
		const first = entries[0];
		if (!first) continue;
		const winners = entries.filter((entry) =>
			entries.every((other) => compareInstants(entry.cts, other.cts) >= 0),
		);
		const winner = winners[0];
		if (!winner) continue;

		if (winners.some((entry) => !isSameEvent(winner.label, entry.label))) {
			collisions.push(winners.map((entry) => entry.label));
			continue;
		}
		if (
			winner.label.neg === true ||
			(winner.exp !== undefined && compareInstants(winner.exp, now) <= 0)
		) {
			continue;
		}
		active.push(winner.label);
	}

	return { active, collisions };
}

function appliesToContext(label: ModerationLabel, context: ReleaseSubjectContext): boolean {
	if (label.uri === context.release.uri) {
		if (!RELEASE_VALUES.has(label.val)) return false;
		if (label.cid !== undefined) return label.cid === context.release.cid;
		return label.val === "security-yanked" || label.val === "!takedown";
	}
	if (label.uri === context.package.uri) {
		if (label.val !== "!takedown" && label.val !== "package-disputed") return false;
		if (label.cid !== undefined) return label.cid === context.package.cid;
		return true;
	}
	return (
		label.uri === context.publisherDid &&
		label.cid === undefined &&
		(label.val === "!takedown" || label.val === "publisher-compromised")
	);
}

function collisionAppliesToContext(
	labels: ModerationLabel[],
	context: ReleaseSubjectContext,
): boolean {
	return labels.some((label) => appliesToContext(label, context));
}

function orderedValues(labels: ModerationLabel[]): string[] {
	const values: string[] = [];
	new Set(labels.map((label) => label.val)).forEach((value) => values.push(value));
	return values.toSorted();
}

interface EvaluateReleaseModerationCoreInput extends Omit<
	EvaluateReleaseModerationInput,
	"labels"
> {
	labels: ModerationLabel[];
}

/**
 * Shared reduction/evaluation body for both the branded (`verifyLabel`) and
 * hydrated entry points. Callers must validate `input.labels` -- by runtime
 * brand or by structural parse -- before calling this.
 */
function evaluateReleaseModerationCore(
	input: EvaluateReleaseModerationCoreInput,
): ReleaseModeration {
	const policies = new Map<string, AcceptedLabelerPolicy>();
	for (const policy of input.acceptedLabelers) {
		const existing = policies.get(policy.did);
		policies.set(policy.did, {
			did: policy.did,
			redact: existing?.redact === true || policy.redact,
		});
	}
	const unacceptedLabelsIgnored = input.labels.some((label) => !policies.has(label.src));
	const reduction = reduceLabels(
		input.labels.filter((label) => policies.has(label.src)),
		input.evaluatedAt,
	);
	const applicableLabels = reduction.active
		.filter((label) => appliesToContext(label, input.context))
		.toSorted((left, right) => streamKey(left).localeCompare(streamKey(right)));
	const collisions = reduction.collisions.filter((labels) =>
		collisionAppliesToContext(labels, input.context),
	);

	const manualBlocks = applicableLabels.filter(
		(label) =>
			label.val === "!takedown" ||
			label.val === "security-yanked" ||
			label.val === "publisher-compromised",
	);
	const warnings = applicableLabels.filter((label) => WARNINGS.has(label.val));
	const suppressed: ModerationLabel[] = [];
	const unsuppressedStates: ModerationLabel[] = [];
	const unsuppressedBlocks: ModerationLabel[] = [];
	const passSources = new Set<string>();
	const overrideSources = new Set<string>();

	for (const [source] of policies) {
		const sourceLabels = applicableLabels.filter((label) => label.src === source);
		const hasPass = sourceLabels.some((label) => label.val === "assessment-passed");
		const hasOverride = sourceLabels.some((label) => label.val === "assessment-overridden");
		const override = hasPass && hasOverride;
		if (override) overrideSources.add(source);
		else if (hasPass) passSources.add(source);

		for (const label of sourceLabels) {
			if (label.val === "assessment-pending" || label.val === "assessment-error") {
				if (override) suppressed.push(label);
				else unsuppressedStates.push(label);
			} else if (AUTOMATED_BLOCKS.has(label.val)) {
				if (override) suppressed.push(label);
				else unsuppressedBlocks.push(label);
			}
		}
	}

	const reasonCodes: string[] = [];
	let eligibility: ReleaseEligibility;
	if (manualBlocks.length > 0) {
		eligibility = "blocked";
		reasonCodes.push("manual-block");
	} else if (collisions.length > 0) {
		eligibility = "error";
		reasonCodes.push("label-state-collision");
	} else if (unsuppressedStates.some((label) => label.val === "assessment-error")) {
		eligibility = "error";
		reasonCodes.push("assessment-error");
	} else if (unsuppressedStates.some((label) => label.val === "assessment-pending")) {
		eligibility = "pending";
		reasonCodes.push("assessment-pending");
	} else if (unsuppressedBlocks.length > 0) {
		eligibility = "blocked";
		reasonCodes.push("automated-block");
	} else if (passSources.size === 0 && overrideSources.size === 0) {
		eligibility = "blocked";
		reasonCodes.push("missing-assessment-pass");
	} else {
		eligibility = "eligible";
		reasonCodes.push(
			overrideSources.size > 0 ? "eligible-manual-override" : "eligible-assessment-pass",
		);
		if (warnings.length > 0) reasonCodes.push("warning-labels");
	}
	if (unacceptedLabelsIgnored) reasonCodes.push("unaccepted-labels-ignored");

	return {
		eligibility,
		reasonCodes,
		blockingLabels: orderedValues([...manualBlocks, ...unsuppressedBlocks]),
		stateLabels: orderedValues(unsuppressedStates),
		warningLabels: orderedValues(warnings),
		suppressedLabels: orderedValues(suppressed),
		applicableLabels,
		redacted: applicableLabels.some(
			(label) => label.val === "!takedown" && policies.get(label.src)?.redact === true,
		),
	};
}

/** Evaluates accepted, current label state for one exact package release. */
export function evaluateReleaseModeration(
	input: EvaluateReleaseModerationInput,
): ReleaseModeration {
	for (const label of input.labels) {
		if (
			typeof label !== "object" ||
			label === null ||
			Object.getOwnPropertyDescriptor(label, verifiedModerationLabel)?.value !== true
		) {
			throw new TypeError("labels must be verified by verifyLabel before moderation evaluation");
		}
	}
	return evaluateReleaseModerationCore(input);
}

/**
 * Evaluates release moderation from unsigned labels an aggregator response has already
 * hydrated, trusting the aggregator for the content itself but not for label authenticity.
 * MUST NOT be used to satisfy a positive-assessment requirement -- that gate requires labels
 * verified through `verifyLabel`.
 */
export function evaluateHydratedReleaseModeration(
	input: EvaluateHydratedReleaseModerationInput,
): ReleaseModeration {
	const labels = input.labels.map((label) => parseModerationLabel(label));
	return evaluateReleaseModerationCore({ ...input, labels });
}

/**
 * The single install/serve blocking predicate for enforcement consumers
 * during the pre-positive-assessment phase. Blocks on an applicable
 * blocking label, a redact-flagged takedown, or a label-state collision
 * (the ratified fail-closed state: an ambiguous block/negation stream must
 * not resolve open). Deliberately NOT keyed on `eligibility`, which ranks
 * pending/error above blocks and reports missing-assessment-pass as
 * "blocked".
 */
export function isModerationBlocking(moderation: ReleaseModeration): boolean {
	return (
		moderation.blockingLabels.length > 0 ||
		moderation.redacted ||
		moderation.reasonCodes.includes("label-state-collision")
	);
}

/** Verifies labels before evaluating their moderation effect for one release. */
export async function verifyAndEvaluateReleaseModeration(
	input: VerifyAndEvaluateReleaseModerationInput,
): Promise<ReleaseModeration> {
	const labels = await Promise.all(
		input.labels.map((label) => verifyLabel({ label, resolveDid: input.resolveDid })),
	);
	return evaluateReleaseModeration({ ...input, labels });
}
