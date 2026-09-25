import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const MIGRATIONS_DIR = join(
	dirname(fileURLToPath(import.meta.url)),
	"../../../src/database/migrations",
);

/**
 * What a migration may import.
 *
 * `runner.ts` statically imports every migration, so anything a migration
 * imports is pulled into the runner's bundle chunk. Reaching for a module that
 * the rest of the source also imports makes the bundler place the two in chunks
 * that import each other, and the shared rolldown runtime helper in one of them
 * is then undefined while the other initializes: the published package throws
 * `__exportAll is not a function` on import, with no test failing first.
 *
 * A helper earns a place on this list by being a leaf: imported by migrations
 * and nothing else, an external package, or reaching only further leaves and
 * never back into shared source. Anything else gets copied into the migration —
 * which a shipped migration wants anyway, since its behaviour is frozen.
 */
const ALLOWED_IMPORTS = new Set([
	"kysely",
	"ulidx",
	"../dialect-helpers.js",
	"../validate.js",
	"../types.js",
	"../pg-migration-lock.js",
	"../datetime-storage.js",
	"../../i18n/config.js",
]);

const IMPORT_SOURCE = /^\s*import\s[^;]*?from\s+"([^"]+)";/gm;

describe("migration imports", () => {
	const files = readdirSync(MIGRATIONS_DIR)
		.filter((name) => /^\d{3}_.*\.ts$/.test(name))
		.toSorted();

	// A wrong MIGRATIONS_DIR would leave `it.each` with no cases, passing vacuously.
	it("covers every migration file", () => {
		expect(files.length).toBeGreaterThan(70);
	});

	it.each(files)("%s imports only migration-safe modules", (file) => {
		const source = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
		const imports = Array.from(source.matchAll(IMPORT_SOURCE), (match) => match[1]!);

		expect(imports.filter((specifier) => !ALLOWED_IMPORTS.has(specifier))).toEqual([]);
	});
});
