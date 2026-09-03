import { base64url, CompactEncrypt, compactDecrypt, decodeProtectedHeader } from "jose";

const ENVELOPE_PROFILE_VERSION = 1;
const KEY_MANAGEMENT_ALGORITHM = "A256GCMKW";
const CONTENT_ENCRYPTION_ALGORITHM = "A256GCM";
const PROFILE_VERSION_HEADER = "emdash_v";
const CONTEXT_DIGEST_HEADER = "emdash_ctx";
const KEY_WRAP_IV_BYTES = 12;
const AUTHENTICATION_TAG_BYTES = 16;
const CONTEXT_DIGEST_BYTES = 32;
const MAX_PLAINTEXT_BYTES = 1024 * 1024;
const MAX_ENVELOPE_CHARS = 1_500_000;
const MAX_KEYRING_CHARS = 64 * 1024;
const MAX_KEYRING_KEYS = 32;
const MAX_KEY_VERSION = 2_147_483_647;
const DID_PATTERN = /^did:[a-z0-9]+:[A-Za-z0-9._:%-]+$/;
const TABLE_PATTERN = /^[a-z][a-z0-9_]{0,127}$/;
const OBJECT_CLASS_PATTERN = /^[A-Z][A-Za-z0-9]{0,127}$/;
const DEPLOYMENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const KEY_VERSION_PATTERN = /^[1-9][0-9]{0,9}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const BASE64URL_SEGMENT_PATTERN = /^[A-Za-z0-9_-]*$/;
const EXPECTED_PROTECTED_HEADER_KEYS = [
	"alg",
	"enc",
	"kid",
	"crit",
	PROFILE_VERSION_HEADER,
	CONTEXT_DIGEST_HEADER,
	"iv",
	"tag",
] as const;
const CRITICAL_HEADERS = {
	[PROFILE_VERSION_HEADER]: true,
	[CONTEXT_DIGEST_HEADER]: true,
} as const;
const OWNED_PURPOSES: ReadonlySet<unknown> = new Set<OwnedEncryptionPurpose>([
	"oauth-session",
	"dpop-private-key",
	"email-address",
	"webhook-destination",
	"webhook-secret",
	"csrf-secret",
	"publisher-snapshot",
]);
const UNOWNED_PURPOSES: ReadonlySet<unknown> = new Set<UnownedEncryptionPurpose>([
	"confidential-client-private-key",
]);
const OPTIONAL_OWNER_PURPOSES: ReadonlySet<unknown> = new Set<OptionalOwnerEncryptionPurpose>([
	"oauth-transaction",
	"oauth-console-transaction",
	"oauth-approver-transaction",
	"oauth-delegation-transaction",
]);

export type OwnedEncryptionPurpose =
	| "oauth-session"
	| "dpop-private-key"
	| "email-address"
	| "webhook-destination"
	| "webhook-secret"
	| "csrf-secret"
	| "publisher-snapshot";

export type OptionalOwnerEncryptionPurpose =
	| "oauth-transaction"
	| "oauth-console-transaction"
	| "oauth-approver-transaction"
	| "oauth-delegation-transaction";

export type UnownedEncryptionPurpose = "confidential-client-private-key";

export type EncryptionPurpose =
	| OwnedEncryptionPurpose
	| OptionalOwnerEncryptionPurpose
	| UnownedEncryptionPurpose;

interface EncryptionContextBase {
	objectClass: string;
	table: string;
	primaryKey: string;
}

export type EncryptionContext = EncryptionContextBase &
	(
		| { purpose: OwnedEncryptionPurpose; ownerDid: string }
		| { purpose: OptionalOwnerEncryptionPurpose; ownerDid: string | null }
		| { purpose: UnownedEncryptionPurpose; ownerDid: null }
	);

export interface EncryptedValue {
	envelope: string;
	keyVersion: number;
}

export type EncryptionErrorCode =
	| "ENCRYPTION_CONFIGURATION_INVALID"
	| "ENCRYPTION_CONTEXT_INVALID"
	| "ENCRYPTED_VALUE_INVALID"
	| "ENCRYPTED_VALUE_UNSUPPORTED"
	| "ENCRYPTION_KEY_UNAVAILABLE"
	| "ENCRYPTION_FAILED"
	| "DECRYPTION_FAILED";

const ERROR_MESSAGES: Record<EncryptionErrorCode, string> = {
	ENCRYPTION_CONFIGURATION_INVALID: "Invalid encryption configuration",
	ENCRYPTION_CONTEXT_INVALID: "Invalid encryption context",
	ENCRYPTED_VALUE_INVALID: "Invalid encrypted value",
	ENCRYPTED_VALUE_UNSUPPORTED: "Unsupported encrypted value",
	ENCRYPTION_KEY_UNAVAILABLE: "Encryption key is unavailable",
	ENCRYPTION_FAILED: "Encryption failed",
	DECRYPTION_FAILED: "Decryption failed",
};

export class EncryptionError extends Error {
	readonly code: EncryptionErrorCode;

	constructor(code: EncryptionErrorCode) {
		super(ERROR_MESSAGES[code]);
		this.name = "EncryptionError";
		this.code = code;
	}
}

interface EncryptionKeyring {
	currentVersion: number;
	keys: ReadonlyMap<number, Uint8Array>;
}

interface ParsedEnvelope {
	keyVersion: number;
	contextDigest: string;
}

export interface EnvelopeEncryption {
	readonly currentKeyVersion: number;
	readonly availableKeyVersions: readonly number[];
	encrypt(plaintext: Uint8Array, context: EncryptionContext): Promise<EncryptedValue>;
	decrypt(envelope: string, context: EncryptionContext): Promise<Uint8Array<ArrayBuffer>>;
	needsRotation(envelope: string): boolean;
	rotate(envelope: string, context: EncryptionContext): Promise<EncryptedValue>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(record: Record<string, unknown>, expected: readonly string[]): boolean {
	const keys = Object.keys(record);
	return keys.length === expected.length && keys.every((key) => expected.includes(key));
}

function isKeyVersion(value: unknown): value is number {
	return Number.isInteger(value) && Number(value) >= 1 && Number(value) <= MAX_KEY_VERSION;
}

function decodeCanonicalBase64Url(value: unknown, expectedBytes?: number): Uint8Array | null {
	if (typeof value !== "string" || value.length === 0 || !BASE64URL_PATTERN.test(value)) {
		return null;
	}
	try {
		const decoded = base64url.decode(value);
		return (expectedBytes === undefined || decoded.length === expectedBytes) &&
			base64url.encode(decoded) === value
			? decoded
			: null;
	} catch {
		return null;
	}
}

function invalidConfiguration(): never {
	throw new EncryptionError("ENCRYPTION_CONFIGURATION_INVALID");
}

function parseKeyring(value: string): EncryptionKeyring {
	if (typeof value !== "string" || value.length === 0 || value.length > MAX_KEYRING_CHARS) {
		invalidConfiguration();
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		invalidConfiguration();
	}
	if (!isRecord(parsed) || !hasExactKeys(parsed, ["current", "keys"])) {
		invalidConfiguration();
	}
	const current = parsed["current"];
	const entries = parsed["keys"];
	if (
		!isKeyVersion(current) ||
		!Array.isArray(entries) ||
		entries.length === 0 ||
		entries.length > MAX_KEYRING_KEYS
	) {
		invalidConfiguration();
	}
	const keys = new Map<number, Uint8Array>();
	for (const entry of entries) {
		if (!isRecord(entry) || !hasExactKeys(entry, ["version", "key"])) {
			invalidConfiguration();
		}
		const version = entry["version"];
		const key = decodeCanonicalBase64Url(entry["key"], 32);
		if (!isKeyVersion(version) || !key || keys.has(version)) {
			invalidConfiguration();
		}
		keys.set(version, key);
	}
	if (!keys.has(current)) invalidConfiguration();
	return { currentVersion: current, keys };
}

function invalidEncryptedValue(): never {
	throw new EncryptionError("ENCRYPTED_VALUE_INVALID");
}

function parseEnvelope(value: string): ParsedEnvelope {
	if (typeof value !== "string" || value.length === 0 || value.length > MAX_ENVELOPE_CHARS) {
		invalidEncryptedValue();
	}
	const segments = value.split(".");
	if (
		segments.length !== 5 ||
		segments.some((segment) => !BASE64URL_SEGMENT_PATTERN.test(segment)) ||
		segments[0]?.length === 0 ||
		segments[1]?.length === 0 ||
		segments[2]?.length === 0 ||
		segments[4]?.length === 0
	) {
		invalidEncryptedValue();
	}
	let header: unknown;
	try {
		header = decodeProtectedHeader(value);
	} catch {
		invalidEncryptedValue();
	}
	if (!isRecord(header) || !hasExactKeys(header, EXPECTED_PROTECTED_HEADER_KEYS)) {
		invalidEncryptedValue();
	}
	if (typeof header["alg"] !== "string" || typeof header["enc"] !== "string") {
		invalidEncryptedValue();
	}
	if (
		header["alg"] !== KEY_MANAGEMENT_ALGORITHM ||
		header["enc"] !== CONTENT_ENCRYPTION_ALGORITHM
	) {
		throw new EncryptionError("ENCRYPTED_VALUE_UNSUPPORTED");
	}
	const profileVersion = header[PROFILE_VERSION_HEADER];
	if (!Number.isInteger(profileVersion)) invalidEncryptedValue();
	if (profileVersion !== ENVELOPE_PROFILE_VERSION) {
		throw new EncryptionError("ENCRYPTED_VALUE_UNSUPPORTED");
	}
	const critical = header["crit"];
	if (!Array.isArray(critical) || !critical.every((name) => typeof name === "string")) {
		invalidEncryptedValue();
	}
	if (
		critical.length !== 2 ||
		!critical.includes(PROFILE_VERSION_HEADER) ||
		!critical.includes(CONTEXT_DIGEST_HEADER)
	) {
		throw new EncryptionError("ENCRYPTED_VALUE_UNSUPPORTED");
	}
	const keyId = header["kid"];
	if (typeof keyId !== "string" || !KEY_VERSION_PATTERN.test(keyId)) {
		invalidEncryptedValue();
	}
	const keyVersion = Number(keyId);
	const contextDigest = header[CONTEXT_DIGEST_HEADER];
	if (
		!isKeyVersion(keyVersion) ||
		typeof contextDigest !== "string" ||
		!decodeCanonicalBase64Url(contextDigest, CONTEXT_DIGEST_BYTES) ||
		!decodeCanonicalBase64Url(header["iv"], KEY_WRAP_IV_BYTES) ||
		!decodeCanonicalBase64Url(header["tag"], AUTHENTICATION_TAG_BYTES)
	) {
		invalidEncryptedValue();
	}
	return { keyVersion, contextDigest };
}

function snapshotContext(context: EncryptionContext): EncryptionContext {
	if (
		!isRecord(context) ||
		!hasExactKeys(context, ["purpose", "objectClass", "table", "primaryKey", "ownerDid"])
	) {
		throw new EncryptionError("ENCRYPTION_CONTEXT_INVALID");
	}
	const purpose = context["purpose"];
	const hasOwnedPurpose = OWNED_PURPOSES.has(purpose);
	const hasUnownedPurpose = UNOWNED_PURPOSES.has(purpose);
	const hasOptionalOwnerPurpose = OPTIONAL_OWNER_PURPOSES.has(purpose);
	const hasValidDid =
		typeof context.ownerDid === "string" &&
		context.ownerDid.length <= 2048 &&
		DID_PATTERN.test(context.ownerDid);
	if (
		(!hasOwnedPurpose && !hasUnownedPurpose && !hasOptionalOwnerPurpose) ||
		typeof context.objectClass !== "string" ||
		!OBJECT_CLASS_PATTERN.test(context.objectClass) ||
		typeof context.table !== "string" ||
		!TABLE_PATTERN.test(context.table) ||
		typeof context.primaryKey !== "string" ||
		context.primaryKey.length === 0 ||
		context.primaryKey.length > 512 ||
		(hasOwnedPurpose && !hasValidDid) ||
		(hasUnownedPurpose && context.ownerDid !== null) ||
		(hasOptionalOwnerPurpose && context.ownerDid !== null && !hasValidDid)
	) {
		throw new EncryptionError("ENCRYPTION_CONTEXT_INVALID");
	}
	return { ...context };
}

async function createContextDigest(
	deploymentId: string,
	keyVersion: number,
	context: EncryptionContext,
): Promise<string> {
	const encoded = new TextEncoder().encode(
		JSON.stringify([
			"emdash-release-service",
			"encryption-context",
			ENVELOPE_PROFILE_VERSION,
			deploymentId,
			context.objectClass,
			context.ownerDid,
			context.table,
			context.primaryKey,
			context.purpose,
			keyVersion,
		]),
	);
	return base64url.encode(new Uint8Array(await crypto.subtle.digest("SHA-256", encoded)));
}

class JoseEnvelopeEncryption implements EnvelopeEncryption {
	readonly currentKeyVersion: number;
	readonly availableKeyVersions: readonly number[];
	readonly #keys: ReadonlyMap<number, Uint8Array>;
	readonly #deploymentId: string;

	constructor(keyring: EncryptionKeyring, deploymentId: string) {
		if (!DEPLOYMENT_ID_PATTERN.test(deploymentId)) {
			throw new EncryptionError("ENCRYPTION_CONFIGURATION_INVALID");
		}
		this.currentKeyVersion = keyring.currentVersion;
		this.availableKeyVersions = Object.freeze([...keyring.keys.keys()].toSorted((a, b) => a - b));
		this.#keys = keyring.keys;
		this.#deploymentId = deploymentId;
	}

	async encrypt(plaintext: Uint8Array, context: EncryptionContext): Promise<EncryptedValue> {
		const contextSnapshot = snapshotContext(context);
		if (!(plaintext instanceof Uint8Array) || plaintext.length > MAX_PLAINTEXT_BYTES) {
			throw new EncryptionError("ENCRYPTION_FAILED");
		}
		const keyVersion = this.currentKeyVersion;
		const key = this.#keys.get(keyVersion);
		if (!key) throw new EncryptionError("ENCRYPTION_KEY_UNAVAILABLE");
		const plaintextCopy = Uint8Array.from(plaintext);
		try {
			const contextDigest = await createContextDigest(
				this.#deploymentId,
				keyVersion,
				contextSnapshot,
			);
			const envelope = await new CompactEncrypt(plaintextCopy)
				.setProtectedHeader({
					alg: KEY_MANAGEMENT_ALGORITHM,
					enc: CONTENT_ENCRYPTION_ALGORITHM,
					kid: String(keyVersion),
					crit: [PROFILE_VERSION_HEADER, CONTEXT_DIGEST_HEADER],
					[PROFILE_VERSION_HEADER]: ENVELOPE_PROFILE_VERSION,
					[CONTEXT_DIGEST_HEADER]: contextDigest,
				})
				.encrypt(key, { crit: CRITICAL_HEADERS });
			if (envelope.length > MAX_ENVELOPE_CHARS) {
				throw new EncryptionError("ENCRYPTION_FAILED");
			}
			return { envelope, keyVersion };
		} catch {
			throw new EncryptionError("ENCRYPTION_FAILED");
		}
	}

	async decrypt(envelope: string, context: EncryptionContext): Promise<Uint8Array<ArrayBuffer>> {
		const contextSnapshot = snapshotContext(context);
		const parsed = parseEnvelope(envelope);
		const key = this.#keys.get(parsed.keyVersion);
		if (!key) throw new EncryptionError("ENCRYPTION_KEY_UNAVAILABLE");
		try {
			const { plaintext, protectedHeader } = await compactDecrypt(envelope, key, {
				crit: CRITICAL_HEADERS,
				keyManagementAlgorithms: [KEY_MANAGEMENT_ALGORITHM],
				contentEncryptionAlgorithms: [CONTENT_ENCRYPTION_ALGORITHM],
			});
			const expectedContextDigest = await createContextDigest(
				this.#deploymentId,
				parsed.keyVersion,
				contextSnapshot,
			);
			if (
				plaintext.length > MAX_PLAINTEXT_BYTES ||
				protectedHeader[CONTEXT_DIGEST_HEADER] !== expectedContextDigest
			) {
				throw new EncryptionError("DECRYPTION_FAILED");
			}
			return Uint8Array.from(plaintext);
		} catch {
			throw new EncryptionError("DECRYPTION_FAILED");
		}
	}

	needsRotation(envelope: string): boolean {
		return parseEnvelope(envelope).keyVersion !== this.currentKeyVersion;
	}

	async rotate(envelope: string, context: EncryptionContext): Promise<EncryptedValue> {
		const contextSnapshot = snapshotContext(context);
		const parsed = parseEnvelope(envelope);
		const plaintext = await this.decrypt(envelope, contextSnapshot);
		if (parsed.keyVersion === this.currentKeyVersion) {
			return { envelope, keyVersion: parsed.keyVersion };
		}
		return this.encrypt(plaintext, contextSnapshot);
	}
}

export function createEnvelopeEncryption(
	keyring: string,
	deploymentId: string,
): EnvelopeEncryption {
	return new JoseEnvelopeEncryption(parseKeyring(keyring), deploymentId);
}
