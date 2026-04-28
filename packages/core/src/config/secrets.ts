/**
 * Centralized secrets module
 *
 * Single source of truth for site-level cryptographic secrets:
 *
 * - `EMDASH_ENCRYPTION_KEY` — primary key for encrypting plugin secrets at
 *   rest. Multi-key (comma-separated) for rotation forward-compat. v1 ships
 *   single-key. Format: `emdash_enc_v1_<43 base64url chars>` representing
 *   32 random bytes. **Operator-provided; never stored in the database.**
 *   Losing the key means losing every secret encrypted with it.
 * - `EMDASH_IP_SALT` (optional) / DB-stored `emdash:ip_salt` — site-specific
 *   salt for hashing commenter IPs. Generated and persisted on first need
 *   if no env override is set. Replaces the previous hardcoded
 *   `"emdash-ip-salt"` constant which was correlatable across installs.
 * - `EMDASH_PREVIEW_SECRET` (optional) / DB-stored `emdash:preview_secret` —
 *   HMAC secret for signing preview URLs. Generated and persisted on first
 *   need if no env override is set. Replaces the previous empty-string
 *   fallback which silently disabled preview-token verification.
 *
 * The `EMDASH_AUTH_SECRET` env var is consulted only as a legacy fallback
 * source for the IP salt — that's the only path the prior code actually
 * read it from. New deployments don't need to set it.
 *
 * Modeled on `resolveS3Config` in `../storage/s3.ts`.
 */

import type { Kysely } from "kysely";

import { OptionsRepository } from "../database/repositories/options.js";
import type { Database } from "../database/types.js";
import { decodeBase64url, encodeBase64url } from "../utils/base64.js";

/** v1 encryption key prefix. Bumping requires a separate KDF version. */
export const ENCRYPTION_KEY_PREFIX = "emdash_enc_v1_";

/** 32 random bytes encoded as unpadded base64url = 43 chars. */
const ENCRYPTION_KEY_BODY_LENGTH = 43;

const REGEX_META_PATTERN = /[.*+?^${}()|[\]\\]/g;

/**
 * Built from the prefix constant via interpolation. The prefix has no regex
 * metacharacters today (`emdash_enc_v1_`), but escaping is cheap defense
 * against anyone changing the prefix in a future bump without remembering.
 */
const ENCRYPTION_KEY_PATTERN = new RegExp(
	`^${ENCRYPTION_KEY_PREFIX.replace(REGEX_META_PATTERN, "\\$&")}[A-Za-z0-9_-]{${ENCRYPTION_KEY_BODY_LENGTH}}$`,
);

/** Options-table key for the persisted commenter-IP salt. */
export const IP_SALT_OPTION_KEY = "emdash:ip_salt";

/** Options-table key for the persisted preview HMAC secret. */
export const PREVIEW_SECRET_OPTION_KEY = "emdash:preview_secret";

/** Length in bytes of generated values. 32 bytes = 256 bits. */
const GENERATED_SECRET_BYTES = 32;

/**
 * A parsed encryption key with its kid (key id) fingerprint.
 *
 * `kid` is the first 8 chars of `sha256(rawKey)` (lowercase hex), used to
 * tag envelopes so the decryptor can pick the right key during rotation.
 */
export interface ParsedEncryptionKey {
	/** 8-char lowercase hex fingerprint derived from the raw key string. */
	kid: string;
	/** The 32 raw key bytes, ready for `crypto.subtle.importKey`. */
	key: Uint8Array;
	/** The original env-var-formatted string (kept for re-emit; never log). */
	raw: string;
}

/** Resolved site secrets. */
export interface ResolvedSecrets {
	/**
	 * Parsed encryption keys (first entry is primary for new writes), or
	 * `null` if `EMDASH_ENCRYPTION_KEY` is unset. Plugin-secret encryption
	 * is opt-in — operators set the env var to enable it.
	 */
	encryptionKeys: ParsedEncryptionKey[] | null;
	/** HMAC secret for preview URLs. Always non-empty after resolution. */
	previewSecret: string;
	/**
	 * Source of `previewSecret`. Useful for diagnostics; never expose the
	 * value itself, only the source.
	 */
	previewSecretSource: "env" | "db";
	/** Salt for hashing commenter IPs. Always non-empty after resolution. */
	ipSalt: string;
	/** Source of `ipSalt`. */
	ipSaltSource: "env" | "db";
}

/** Inputs for `resolveSecrets`. */
export interface ResolveSecretsOptions {
	/**
	 * The Kysely DB used to persist (and read back) generated salt/preview
	 * secret values. Required — these values must be stable across requests
	 * within a deployment.
	 */
	db: Kysely<Database>;
	/**
	 * Optional explicit env override map. When omitted, falls back to
	 * `import.meta.env` via the global accessor below. Tests pass an
	 * explicit map to avoid leaking process state.
	 */
	env?: SecretsEnv;
	/**
	 * @internal Test seam: inject a custom OptionsRepository to exercise
	 * the lost-race re-read branch. Production callers never set this.
	 */
	_repo?: OptionsRepository;
}

/** Environment-variable shape consulted by the resolver. */
export interface SecretsEnv {
	EMDASH_ENCRYPTION_KEY?: string;
	EMDASH_PREVIEW_SECRET?: string;
	/** Legacy alias; new docs point at EMDASH_PREVIEW_SECRET. */
	PREVIEW_SECRET?: string;
	EMDASH_IP_SALT?: string;
	/**
	 * Legacy fallback. Prior code derived the IP salt from
	 * `EMDASH_AUTH_SECRET || AUTH_SECRET || "emdash-ip-salt"`. We preserve
	 * the env-var fallback (so existing installs keep their stable salt)
	 * but no longer read it from `import.meta.env` in route handlers.
	 */
	EMDASH_AUTH_SECRET?: string;
	/** Legacy alias. */
	AUTH_SECRET?: string;
}

/**
 * Class of validation failures raised by this module.
 *
 * Errors here are operator-facing config problems (malformed key, etc.).
 * They are thrown rather than soft-skipped so misconfiguration fails loudly
 * at startup instead of silently degrading at request time.
 */
export class EmDashSecretsError extends Error {
	override readonly name = "EmDashSecretsError";
	readonly code: string;

	constructor(message: string, code: string) {
		super(message);
		this.code = code;
	}
}

// ---------------------------------------------------------------------------
// Encryption key parsing
// ---------------------------------------------------------------------------

/**
 * Parse the `EMDASH_ENCRYPTION_KEY` env var.
 *
 * Accepts a single key or a comma-separated list. The first entry is the
 * primary (used for new writes); all entries are tried for decryption,
 * matched by `kid`. Whitespace around commas is tolerated. Empty entries
 * (e.g. trailing comma) are ignored.
 *
 * Returns `null` for an unset/empty input. Throws `EmDashSecretsError` on
 * any malformed entry — silent skipping would mask deployment mistakes.
 */
export async function parseEncryptionKeys(
	raw: string | undefined,
): Promise<ParsedEncryptionKey[] | null> {
	if (!raw) return null;

	const entries = raw
		.split(",")
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);

	if (entries.length === 0) return null;

	const parsed: ParsedEncryptionKey[] = [];
	const seenKids = new Set<string>();

	for (const entry of entries) {
		if (!ENCRYPTION_KEY_PATTERN.test(entry)) {
			throw new EmDashSecretsError(
				`EMDASH_ENCRYPTION_KEY entry is malformed (expected "${ENCRYPTION_KEY_PREFIX}" followed by ${ENCRYPTION_KEY_BODY_LENGTH} base64url chars). Generate one with \`emdash secrets generate\`.`,
				"INVALID_ENCRYPTION_KEY",
			);
		}

		const body = entry.slice(ENCRYPTION_KEY_PREFIX.length);
		const key = decodeBase64urlStrict(body);
		if (!key) {
			throw new EmDashSecretsError(
				"EMDASH_ENCRYPTION_KEY body is not valid base64url",
				"INVALID_ENCRYPTION_KEY",
			);
		}
		if (key.length !== GENERATED_SECRET_BYTES) {
			throw new EmDashSecretsError(
				`EMDASH_ENCRYPTION_KEY must decode to ${GENERATED_SECRET_BYTES} bytes, got ${key.length}`,
				"INVALID_ENCRYPTION_KEY",
			);
		}

		// Reject non-canonical base64url. 43 chars decode to 32 bytes but
		// the last char only carries 2 information bits — multiple raw
		// strings can decode to the same bytes. Forcing canonical form
		// guarantees `kid` (derived from bytes) is stable per key
		// material, regardless of how the operator pasted it.
		const canonical = encodeBase64url(key);
		if (canonical !== body) {
			throw new EmDashSecretsError(
				"EMDASH_ENCRYPTION_KEY body is not canonical base64url. Generate one with `emdash secrets generate`.",
				"INVALID_ENCRYPTION_KEY",
			);
		}

		const kid = await fingerprintKeyBytes(key);
		if (seenKids.has(kid)) {
			// Duplicate keys are user error (paste mistake during rotation).
			// We dedupe rather than throw — the rotation flow is forgiving.
			continue;
		}
		seenKids.add(kid);
		parsed.push({ kid, key, raw: entry });
	}

	// `parsed` always has at least one entry here: `entries` was non-empty
	// after filtering, the loop runs at least once, the first iteration
	// always passes the empty-`seenKids` check.
	return parsed;
}

/**
 * Compute the kid for a raw key string (the env-var form including the
 * `emdash_enc_v1_` prefix). Public so the CLI's `fingerprint` subcommand
 * and admin endpoints can show kids without exposing raw keys.
 *
 * The kid is derived from the decoded key **bytes**, not the raw string,
 * so admin endpoints / future rotation flows can match envelope kids
 * against bytes regardless of how the env var was originally spelled.
 * (`parseEncryptionKeys` rejects non-canonical base64url, so the raw
 * string is canonical 1:1 with the bytes anyway — the byte-derivation
 * is the architecturally cleaner choice.)
 *
 * Throws `EmDashSecretsError` for malformed input.
 */
export async function fingerprintKey(raw: string): Promise<string> {
	if (!raw.startsWith(ENCRYPTION_KEY_PREFIX)) {
		throw new EmDashSecretsError(
			`Key must start with "${ENCRYPTION_KEY_PREFIX}"`,
			"INVALID_ENCRYPTION_KEY",
		);
	}
	const body = raw.slice(ENCRYPTION_KEY_PREFIX.length);
	const bytes = decodeBase64urlStrict(body);
	if (!bytes || bytes.length !== GENERATED_SECRET_BYTES) {
		throw new EmDashSecretsError(
			`Key body must decode to ${GENERATED_SECRET_BYTES} bytes`,
			"INVALID_ENCRYPTION_KEY",
		);
	}
	return fingerprintKeyBytes(bytes);
}

/**
 * Internal: kid derivation from raw key bytes. The single source of truth
 * for what makes two keys "the same key" — used by both `parseEncryptionKeys`
 * and `fingerprintKey`.
 */
async function fingerprintKeyBytes(key: Uint8Array): Promise<string> {
	// `crypto.subtle.digest` requires a `BufferSource` whose underlying
	// buffer is `ArrayBuffer` (not `SharedArrayBuffer`). `decodeBase64url`
	// can return a `Uint8Array<ArrayBufferLike>` depending on platform, so
	// copy into a fresh ArrayBuffer-backed view to satisfy the type.
	const copy = new Uint8Array(key.byteLength);
	copy.set(key);
	const buf = await crypto.subtle.digest("SHA-256", copy);
	const hex = Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
	return hex.slice(0, 8);
}

/**
 * Generate a fresh `EMDASH_ENCRYPTION_KEY` value. Used by the CLI's
 * `secrets generate` subcommand and by `create-emdash` scaffolding.
 */
export function generateEncryptionKey(): string {
	const bytes = new Uint8Array(GENERATED_SECRET_BYTES);
	crypto.getRandomValues(bytes);
	return `${ENCRYPTION_KEY_PREFIX}${encodeBase64url(bytes)}`;
}

// ---------------------------------------------------------------------------
// Site-secret resolution (DB-backed with env override)
// ---------------------------------------------------------------------------

/**
 * Resolve all site secrets. Reads env vars; for IP salt and preview secret,
 * falls back to a DB-stored value, generating one atomically on first need.
 *
 * Idempotent. Concurrent callers race on the atomic `setIfAbsent`; whichever
 * wins, all callers converge on the same stored value.
 *
 * The encryption-key path is env-only (operators provision it). A missing
 * env var is not an error here — encryption is opt-in.
 */
export async function resolveSecrets(options: ResolveSecretsOptions): Promise<ResolvedSecrets> {
	const env = options.env ?? readDefaultEnv();
	const repo = options._repo ?? new OptionsRepository(options.db);

	const encryptionKeys = await parseEncryptionKeys(env.EMDASH_ENCRYPTION_KEY);

	const previewEnvOverride = pickFirstNonEmpty(env.EMDASH_PREVIEW_SECRET, env.PREVIEW_SECRET);
	const ipSaltEnvOverride = pickFirstNonEmpty(
		env.EMDASH_IP_SALT,
		env.EMDASH_AUTH_SECRET,
		env.AUTH_SECRET,
	);

	const [previewSecret, ipSalt] = await Promise.all([
		previewEnvOverride !== null
			? Promise.resolve({ value: previewEnvOverride, source: "env" as const })
			: ensureGeneratedOption(repo, PREVIEW_SECRET_OPTION_KEY),
		ipSaltEnvOverride !== null
			? Promise.resolve({ value: ipSaltEnvOverride, source: "env" as const })
			: ensureGeneratedOption(repo, IP_SALT_OPTION_KEY),
	]);

	return {
		encryptionKeys,
		previewSecret: previewSecret.value,
		previewSecretSource: previewSecret.source,
		ipSalt: ipSalt.value,
		ipSaltSource: ipSalt.source,
	};
}

/**
 * Per-DB cache of resolved secrets, keyed by Kysely instance identity.
 *
 * The resolved values are stable for the lifetime of the deployment (env
 * vars don't change without a restart, and DB-stored values are written
 * once via `setIfAbsent`). Caching avoids one options-table read per
 * request on the hot paths (preview verification, comment hashing).
 *
 * Lives on `globalThis` so module-duplication during SSR bundling can't
 * fragment the cache. See `request-context.ts` for the same pattern.
 */
// Versioned to prevent cache fragmentation if `ResolvedSecrets`'s shape
// ever changes. Bump the suffix on incompatible changes so a co-resident
// older build doesn't read a newer-shape value.
const SECRETS_CACHE_KEY = Symbol.for("@emdash-cms/core/secrets-cache@1");

interface SecretsCacheHolder {
	cache: WeakMap<Kysely<Database>, Promise<ResolvedSecrets>>;
}

function getSecretsCache(): WeakMap<Kysely<Database>, Promise<ResolvedSecrets>> {
	// eslint-disable-next-line typescript-eslint(no-unsafe-type-assertion) -- globalThis singleton pattern
	const holder = globalThis as Record<symbol, SecretsCacheHolder | undefined>;
	let entry = holder[SECRETS_CACHE_KEY];
	if (!entry) {
		entry = { cache: new WeakMap() };
		holder[SECRETS_CACHE_KEY] = entry;
	}
	return entry.cache;
}

/**
 * Memoized wrapper around `resolveSecrets`. Use this from request-time hot
 * paths (preview verification, comment IP hashing) so they don't reread
 * env / re-query options on every request.
 *
 * The cache is keyed by `Kysely` instance, so playground / per-DO / per-test
 * databases each get their own resolution.
 */
export function resolveSecretsCached(db: Kysely<Database>): Promise<ResolvedSecrets> {
	const cache = getSecretsCache();
	const cached = cache.get(db);
	if (cached) return cached;
	const promise = resolveSecrets({ db }).catch((error) => {
		// Don't poison the cache on transient failure; next caller retries.
		cache.delete(db);
		throw error;
	});
	cache.set(db, promise);
	return promise;
}

/**
 * Test-only helper: clear the secrets cache. Tests that mutate env between
 * cases need this so a stale resolution doesn't leak across cases.
 *
 * @internal
 */
export function _clearSecretsCacheForTesting(): void {
	// eslint-disable-next-line typescript-eslint(no-unsafe-type-assertion) -- globalThis singleton pattern
	const holder = globalThis as Record<symbol, SecretsCacheHolder | undefined>;
	holder[SECRETS_CACHE_KEY] = undefined;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Read or generate-and-persist a random base64url secret stored in the
 * options table.
 *
 * Concurrency: `setIfAbsent` is an atomic INSERT...ON CONFLICT DO NOTHING.
 * On race, the loser re-reads to converge on the winner's value.
 */
async function ensureGeneratedOption(
	repo: OptionsRepository,
	optionKey: string,
): Promise<{ value: string; source: "db" }> {
	const existing = await repo.get<string>(optionKey);
	if (typeof existing === "string" && existing.length > 0) {
		return { value: existing, source: "db" };
	}

	const generated = generateRandomSecret();
	const inserted = await repo.setIfAbsent(optionKey, generated);
	if (inserted) {
		return { value: generated, source: "db" };
	}

	// Lost the race — another process inserted first. Re-read to pick up
	// the winner. If the row is somehow still missing or empty, treat that
	// as a real error rather than looping.
	const winner = await repo.get<string>(optionKey);
	if (typeof winner !== "string" || winner.length === 0) {
		throw new EmDashSecretsError(
			`Failed to persist generated secret for "${optionKey}"`,
			"SECRET_PERSIST_FAILED",
		);
	}
	return { value: winner, source: "db" };
}

/** Generate 32 random bytes encoded as unpadded base64url. */
function generateRandomSecret(): string {
	const bytes = new Uint8Array(GENERATED_SECRET_BYTES);
	crypto.getRandomValues(bytes);
	return encodeBase64url(bytes);
}

/** Return the first non-empty string from `values`, or `null` if all are empty. */
function pickFirstNonEmpty(...values: (string | undefined)[]): string | null {
	for (const value of values) {
		if (typeof value === "string" && value.length > 0) {
			return value;
		}
	}
	return null;
}

const BASE64URL_CHARSET_PATTERN = /^[A-Za-z0-9_-]+$/;

/**
 * Validate base64url shape and decode. Returns `null` on malformed input
 * (rather than throwing) so the caller can produce a config-specific error.
 */
function decodeBase64urlStrict(input: string): Uint8Array | null {
	// `decodeBase64url` accepts padded input too; the env-var format is
	// strictly unpadded base64url, so we do a charset check first.
	if (!BASE64URL_CHARSET_PATTERN.test(input)) return null;
	try {
		return decodeBase64url(input);
	} catch {
		return null;
	}
}

/**
 * Default env reader.
 *
 * Note: this is the **only** code path in core that reads both
 * `import.meta.env` and `process.env`. Route handlers should not — they
 * always run inside the Astro/Vite bundle where `import.meta.env` is
 * the correct source. This resolver is shared with the CLI surface (via
 * `cli/commands/secrets.ts`) which runs outside the bundle, so we
 * deliberately consult both. `import.meta.env` wins so build-time
 * substitutions are honored when present.
 *
 * The convention documented in AGENTS.md ("import.meta.env.EMDASH_X ||
 * import.meta.env.X") is the route-handler convention; this is the
 * shared-with-CLI exception.
 */
function readDefaultEnv(): SecretsEnv {
	// eslint-disable-next-line typescript-eslint(no-unsafe-type-assertion) -- import.meta.env is loose by design
	const meta = (import.meta.env ?? {}) as Record<string, string | undefined>;
	const proc = typeof process !== "undefined" && process.env ? process.env : {};

	return {
		EMDASH_ENCRYPTION_KEY: meta.EMDASH_ENCRYPTION_KEY ?? proc.EMDASH_ENCRYPTION_KEY,
		EMDASH_PREVIEW_SECRET: meta.EMDASH_PREVIEW_SECRET ?? proc.EMDASH_PREVIEW_SECRET,
		PREVIEW_SECRET: meta.PREVIEW_SECRET ?? proc.PREVIEW_SECRET,
		EMDASH_IP_SALT: meta.EMDASH_IP_SALT ?? proc.EMDASH_IP_SALT,
		EMDASH_AUTH_SECRET: meta.EMDASH_AUTH_SECRET ?? proc.EMDASH_AUTH_SECRET,
		AUTH_SECRET: meta.AUTH_SECRET ?? proc.AUTH_SECRET,
	};
}
