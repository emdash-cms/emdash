import type { Kysely } from "kysely";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import {
	EmDashSecretsError,
	IP_SALT_OPTION_KEY,
	PREVIEW_SECRET_OPTION_KEY,
	_clearSecretsCacheForTesting,
	fingerprintKey,
	generateEncryptionKey,
	parseEncryptionKeys,
	resolveSecrets,
	resolveSecretsCached,
	validateEncryptionKeyAtStartup,
} from "../../../src/config/secrets.js";
import { OptionsRepository } from "../../../src/database/repositories/options.js";
import type { Database } from "../../../src/database/types.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

describe("config/secrets", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		db = await setupTestDatabase();
		_clearSecretsCacheForTesting();
	});

	afterEach(async () => {
		_clearSecretsCacheForTesting();
		await teardownTestDatabase(db);
	});

	describe("generateEncryptionKey", () => {
		it("emits the v1 prefix and a base64url body", () => {
			const key = generateEncryptionKey();
			expect(key.startsWith("emdash_enc_v1_")).toBe(true);
			const body = key.slice("emdash_enc_v1_".length);
			expect(body).toHaveLength(43);
			expect(body).toMatch(/^[A-Za-z0-9_-]+$/);
		});

		it("produces unique values across calls", () => {
			const a = generateEncryptionKey();
			const b = generateEncryptionKey();
			expect(a).not.toBe(b);
		});
	});

	describe("parseEncryptionKeys", () => {
		it("returns null for unset / empty input", async () => {
			expect(await parseEncryptionKeys(undefined)).toBeNull();
			expect(await parseEncryptionKeys("")).toBeNull();
			expect(await parseEncryptionKeys(",,,")).toBeNull();
			expect(await parseEncryptionKeys("   ")).toBeNull();
		});

		it("parses a single valid key into a {kid, key, raw} entry", async () => {
			const raw = generateEncryptionKey();
			const parsed = await parseEncryptionKeys(raw);
			expect(parsed).toHaveLength(1);
			expect(parsed?.[0]?.raw).toBe(raw);
			expect(parsed?.[0]?.key).toBeInstanceOf(Uint8Array);
			expect(parsed?.[0]?.key.byteLength).toBe(32);
			expect(parsed?.[0]?.kid).toMatch(/^[0-9a-f]{8}$/);
		});

		it("kid is stable across repeated calls and matches fingerprintKey()", async () => {
			// Kid is derived from decoded key bytes (canonicality is enforced
			// upstream, so raw <-> bytes is 1:1). Repeated parses of the same
			// canonical raw string must yield the same kid, and the standalone
			// fingerprintKey() helper must agree with parseEncryptionKeys().
			const raw = generateEncryptionKey();
			const a = await parseEncryptionKeys(raw);
			const b = await parseEncryptionKeys(raw);
			expect(a?.[0]?.kid).toBe(b?.[0]?.kid);
			expect(await fingerprintKey(raw)).toBe(a?.[0]?.kid);
		});

		it("parses comma-separated multi-key with whitespace tolerance", async () => {
			const a = generateEncryptionKey();
			const b = generateEncryptionKey();
			const parsed = await parseEncryptionKeys(` ${a} ,  ${b}  ,`);
			expect(parsed).toHaveLength(2);
			expect(parsed?.[0]?.raw).toBe(a);
			expect(parsed?.[1]?.raw).toBe(b);
		});

		it("dedupes keys with the same kid (paste mistakes)", async () => {
			const raw = generateEncryptionKey();
			const parsed = await parseEncryptionKeys(`${raw},${raw}`);
			expect(parsed).toHaveLength(1);
		});

		it("throws on a malformed prefix", async () => {
			await expect(parseEncryptionKeys("not_a_key")).rejects.toBeInstanceOf(EmDashSecretsError);
		});

		it("throws on a malformed body (too short)", async () => {
			await expect(parseEncryptionKeys("emdash_enc_v1_tooShort")).rejects.toBeInstanceOf(
				EmDashSecretsError,
			);
		});

		it("throws on a malformed body (non base64url chars)", async () => {
			// 43 chars with a bad character
			const bad = "emdash_enc_v1_" + "!".repeat(43);
			await expect(parseEncryptionKeys(bad)).rejects.toBeInstanceOf(EmDashSecretsError);
		});

		it("throws if any entry in a multi-key list is malformed", async () => {
			const good = generateEncryptionKey();
			await expect(parseEncryptionKeys(`${good},not_a_key`)).rejects.toBeInstanceOf(
				EmDashSecretsError,
			);
		});

		it("rejects non-canonical base64url so kid stays stable per key material", async () => {
			// 32-byte keys encode to 43 base64url chars. The 43rd char encodes
			// 4 bits of which only the high 2 are meaningful — the low 2 bits
			// must be zero in canonical encoding. Letters whose 6-bit value
			// has zero low-2-bits: A(0), E(4), I(8), M(12), Q(16), U(20),
			// Y(24), c(28), g(32), k(36), o(40), s(44), w(48), 0(52), 4(56),
			// 8(60). Anything else in the last position encodes bits that
			// canonical encoding would set to zero — same decoded bytes,
			// different raw string. We reject these to keep kid 1:1 with
			// key material.
			//
			// "A".repeat(43) is canonical (all-zero key). Replace the last
			// char with "B" (value 1) to get a non-canonical string with
			// the same decoded bytes.
			const canonical = `emdash_enc_v1_${"A".repeat(43)}`;
			const nonCanonical = `emdash_enc_v1_${"A".repeat(42)}B`;

			// Both have the right shape so we know we're testing the
			// canonical check, not the regex.
			expect(canonical).toMatch(/^emdash_enc_v1_[A-Za-z0-9_-]{43}$/);
			expect(nonCanonical).toMatch(/^emdash_enc_v1_[A-Za-z0-9_-]{43}$/);

			// Canonical form parses fine.
			await expect(parseEncryptionKeys(canonical)).resolves.toBeTruthy();

			// Non-canonical form is rejected.
			await expect(parseEncryptionKeys(nonCanonical)).rejects.toThrow(EmDashSecretsError);
		});
	});

	describe("resolveSecrets", () => {
		it("default path generates and persists IP salt + preview secret", async () => {
			const result = await resolveSecrets({ db, env: {} });

			expect(result.ipSaltSource).toBe("db");
			expect(result.previewSecretSource).toBe("db");
			expect(result.ipSalt.length).toBeGreaterThan(0);
			expect(result.previewSecret.length).toBeGreaterThan(0);

			const repo = new OptionsRepository(db);
			expect(await repo.get<string>(IP_SALT_OPTION_KEY)).toBe(result.ipSalt);
			expect(await repo.get<string>(PREVIEW_SECRET_OPTION_KEY)).toBe(result.previewSecret);
		});

		it("does not consult EMDASH_ENCRYPTION_KEY (a malformed key cannot break preview/comments)", async () => {
			// Regression: previously a malformed EMDASH_ENCRYPTION_KEY was
			// parsed inside resolveSecrets and the throw propagated through
			// request-context middleware as a 500 to anonymous visitors with
			// stale `?_preview=` URLs. The key is validated separately at
			// startup now; resolveSecrets must not gate on it.
			const result = await resolveSecrets({
				db,
				env: { EMDASH_ENCRYPTION_KEY: "not_a_valid_key" },
			});
			expect(result.previewSecret.length).toBeGreaterThan(0);
			expect(result.ipSalt.length).toBeGreaterThan(0);
		});

		it("env override wins for preview secret and ip salt", async () => {
			const result = await resolveSecrets({
				db,
				env: {
					EMDASH_PREVIEW_SECRET: "env-preview",
					EMDASH_IP_SALT: "env-ip-salt",
				},
			});
			expect(result.previewSecret).toBe("env-preview");
			expect(result.previewSecretSource).toBe("env");
			expect(result.ipSalt).toBe("env-ip-salt");
			expect(result.ipSaltSource).toBe("env");

			// And nothing was written to the options table on the env path.
			const repo = new OptionsRepository(db);
			expect(await repo.get<string>(IP_SALT_OPTION_KEY)).toBeNull();
			expect(await repo.get<string>(PREVIEW_SECRET_OPTION_KEY)).toBeNull();
		});

		it("legacy PREVIEW_SECRET fallback works (unprefixed name)", async () => {
			const result = await resolveSecrets({
				db,
				env: { PREVIEW_SECRET: "legacy-preview" },
			});
			expect(result.previewSecret).toBe("legacy-preview");
			expect(result.previewSecretSource).toBe("env");
		});

		it("legacy EMDASH_AUTH_SECRET fallback for IP salt is honored", async () => {
			// Prior code derived the IP salt from EMDASH_AUTH_SECRET. Existing
			// installs that have only EMDASH_AUTH_SECRET set must keep the
			// same salt — otherwise their existing IP-bucket rate-limit data
			// rotates uselessly on upgrade.
			const result = await resolveSecrets({
				db,
				env: { EMDASH_AUTH_SECRET: "legacy-auth" },
			});
			expect(result.ipSalt).toBe("legacy-auth");
			expect(result.ipSaltSource).toBe("env");
		});

		it("EMDASH_IP_SALT wins over EMDASH_AUTH_SECRET fallback", async () => {
			const result = await resolveSecrets({
				db,
				env: {
					EMDASH_IP_SALT: "explicit-salt",
					EMDASH_AUTH_SECRET: "legacy-auth",
				},
			});
			expect(result.ipSalt).toBe("explicit-salt");
		});

		it("idempotent: repeated calls return the same DB-stored values", async () => {
			const a = await resolveSecrets({ db, env: {} });
			const b = await resolveSecrets({ db, env: {} });
			expect(a.ipSalt).toBe(b.ipSalt);
			expect(a.previewSecret).toBe(b.previewSecret);
		});

		it("repeated first-resolves are idempotent (sequential test of convergence)", async () => {
			// Five sequential first-resolves on a fresh DB should converge.
			// Note: better-sqlite3 is synchronous, so this doesn't exercise
			// genuine cross-process concurrency. The cross-process atomicity
			// is provided by `INSERT ... ON CONFLICT DO NOTHING` at the DB
			// layer; see the lost-race test below for in-process coverage
			// of the re-read path.
			const promises: Promise<Awaited<ReturnType<typeof resolveSecrets>>>[] = [];
			for (let i = 0; i < 5; i++) {
				promises.push(resolveSecrets({ db, env: {} }));
			}
			const results = await Promise.all(promises);
			const ipSalts = new Set(results.map((r) => r.ipSalt));
			const previews = new Set(results.map((r) => r.previewSecret));
			expect(ipSalts.size).toBe(1);
			expect(previews.size).toBe(1);
		});

		it("returns the existing row when first-read finds one already populated", async () => {
			// Pre-populate the row, then resolve. Exercises the early-return
			// branch in `ensureGeneratedOption` where the first read hits.
			const winnerSalt = "row-already-populated";
			const repo = new OptionsRepository(db);
			await repo.set(IP_SALT_OPTION_KEY, winnerSalt);

			const result = await resolveSecrets({ db, env: {} });
			expect(result.ipSalt).toBe(winnerSalt);
			expect(result.ipSaltSource).toBe("db");
		});

		it("converges via lost-race re-read when setIfAbsent reports no insert", async () => {
			// Simulate a genuine cross-process race: caller A reads (no row),
			// caller B inserts the winner, caller A's setIfAbsent loses
			// (returns false). A then re-reads and converges on B's value.
			//
			// We stub `setIfAbsent` to inject the "concurrent process won"
			// behavior on the IP-salt key specifically (the resolver also
			// does this for preview secret in parallel; we need to target
			// one to assert).
			const winnerSalt = "concurrent-process-won";
			const realRepo = new OptionsRepository(db);
			const stubRepo = Object.create(realRepo) as OptionsRepository;
			stubRepo.setIfAbsent = async <T>(name: string, value: T) => {
				if (name === IP_SALT_OPTION_KEY) {
					// Simulate "winner" inserting first; tell our caller the
					// insert didn't take so it falls through to the re-read.
					await realRepo.set(name, winnerSalt);
					return false;
				}
				return realRepo.setIfAbsent(name, value);
			};

			const result = await resolveSecrets({ db, env: {}, _repo: stubRepo });
			expect(result.ipSalt).toBe(winnerSalt);
			expect(result.ipSaltSource).toBe("db");
		});

		it("throws SECRET_PERSIST_FAILED when setIfAbsent loses but the row is empty after re-read", async () => {
			// Pathological case: setIfAbsent says "didn't insert" but the
			// row is still missing. This shouldn't happen in practice with
			// a sane DB, but the resolver guards against it rather than
			// looping forever or returning an empty string.
			const realRepo = new OptionsRepository(db);
			const stubRepo = Object.create(realRepo) as OptionsRepository;
			stubRepo.setIfAbsent = async () => false; // Always claim no-op, no row appears.

			await expect(resolveSecrets({ db, env: {}, _repo: stubRepo })).rejects.toThrow(
				/SECRET_PERSIST_FAILED|Failed to persist/,
			);
		});
	});

	describe("validateEncryptionKeyAtStartup", () => {
		it("returns true for an unset key", async () => {
			expect(await validateEncryptionKeyAtStartup({})).toBe(true);
		});

		it("returns true for a valid key", async () => {
			const key = generateEncryptionKey();
			expect(await validateEncryptionKeyAtStartup({ EMDASH_ENCRYPTION_KEY: key })).toBe(true);
		});

		it("returns false (and does not throw) for a malformed key, logging an operator-facing message", async () => {
			const errors: unknown[][] = [];
			const original = console.error;
			console.error = (...args: unknown[]) => {
				errors.push(args);
			};
			try {
				const result = await validateEncryptionKeyAtStartup({
					EMDASH_ENCRYPTION_KEY: "not_a_valid_key",
				});
				expect(result).toBe(false);
				expect(errors).toHaveLength(1);
				expect(String(errors[0]?.[0])).toMatch(/EMDASH_ENCRYPTION_KEY is invalid/);
			} finally {
				console.error = original;
			}
		});
	});

	describe("fingerprintKey", () => {
		it("agrees with parseEncryptionKeys on canonical input", async () => {
			const raw = generateEncryptionKey();
			const parsed = await parseEncryptionKeys(raw);
			expect(await fingerprintKey(raw)).toBe(parsed?.[0]?.kid);
		});

		it("rejects non-canonical base64url (so the CLI can't print kids the runtime would refuse)", async () => {
			const nonCanonical = `emdash_enc_v1_${"A".repeat(42)}B`;
			await expect(fingerprintKey(nonCanonical)).rejects.toBeInstanceOf(EmDashSecretsError);
		});

		it("rejects a malformed prefix", async () => {
			await expect(fingerprintKey("not_a_key")).rejects.toBeInstanceOf(EmDashSecretsError);
		});

		it("rejects bodies of the wrong length", async () => {
			await expect(fingerprintKey("emdash_enc_v1_tooShort")).rejects.toBeInstanceOf(
				EmDashSecretsError,
			);
		});
	});

	describe("resolveSecretsCached", () => {
		it("memoizes per-db so multiple callers share one resolution promise", async () => {
			// First caller starts the resolution; second caller piggybacks.
			// We can verify they share a value (and the cache key is the db
			// instance) by comparing against a freshly cleared cache.
			const a = await resolveSecretsCached(db);
			const b = await resolveSecretsCached(db);
			expect(a).toBe(b);

			_clearSecretsCacheForTesting();
			const c = await resolveSecretsCached(db);
			// Different cache entry, but same persisted DB values.
			expect(c).not.toBe(a);
			expect(c.ipSalt).toBe(a.ipSalt);
			expect(c.previewSecret).toBe(a.previewSecret);
		});
	});
});
