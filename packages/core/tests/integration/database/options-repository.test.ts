/**
 * OptionsRepository.setIfAbsent — atomic write-once semantics.
 *
 * Used by routes that must never overwrite a stored value once set
 * (e.g. the setup wizard's emdash:site_url write). Correctness under
 * concurrent writes is a security property: a non-atomic read-then-write
 * lets a second caller win the race and poison the value.
 */

import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { OptionsRepository } from "../../../src/database/repositories/options.js";
import type { Database } from "../../../src/database/types.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

describe("OptionsRepository.setIfAbsent", () => {
	let db: Kysely<Database>;
	let repo: OptionsRepository;

	beforeEach(async () => {
		db = await setupTestDatabase();
		repo = new OptionsRepository(db);
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	it("inserts when no row exists and returns true", async () => {
		const inserted = await repo.setIfAbsent("emdash:site_url", "https://example.com");
		expect(inserted).toBe(true);
		expect(await repo.get("emdash:site_url")).toBe("https://example.com");
	});

	it("does not overwrite an existing value and returns false", async () => {
		await repo.set("emdash:site_url", "https://real.example");
		const inserted = await repo.setIfAbsent("emdash:site_url", "https://attacker.example");
		expect(inserted).toBe(false);
		expect(await repo.get("emdash:site_url")).toBe("https://real.example");
	});

	it("treats an empty string as present (does not overwrite)", async () => {
		await repo.set("emdash:site_url", "");
		const inserted = await repo.setIfAbsent("emdash:site_url", "https://attacker.example");
		expect(inserted).toBe(false);
		expect(await repo.get("emdash:site_url")).toBe("");
	});

	it("treats a stored null as present (does not overwrite)", async () => {
		await repo.set("emdash:site_url", null);
		const inserted = await repo.setIfAbsent("emdash:site_url", "https://attacker.example");
		expect(inserted).toBe(false);
		expect(await repo.get("emdash:site_url")).toBeNull();
	});

	it("is atomic under concurrent callers — only one insert succeeds", async () => {
		const results = await Promise.all([
			repo.setIfAbsent("emdash:site_url", "https://a.example"),
			repo.setIfAbsent("emdash:site_url", "https://b.example"),
			repo.setIfAbsent("emdash:site_url", "https://c.example"),
		]);

		// Exactly one caller inserted; the others saw the existing row.
		expect(results.filter((r) => r === true)).toHaveLength(1);
		expect(results.filter((r) => r === false)).toHaveLength(2);

		// And whichever value landed first now sticks.
		const final = await repo.get("emdash:site_url");
		expect(["https://a.example", "https://b.example", "https://c.example"]).toContain(final);
	});
});
