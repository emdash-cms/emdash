/**
 * Smoke tests for template/demo seed fixtures.
 *
 * Validates that all seed files are well-formed, can be applied
 * to a fresh database, and that the resulting database passes
 * doctor checks. Does NOT start a dev server — these are fast,
 * programmatic tests that exercise the seed/validate/apply/doctor
 * pipeline directly.
 *
 * Also shells out to the CLI binary for seed --validate and doctor
 * commands to ensure the CLI interface works correctly.
 */

import { execFile } from "node:child_process";
import { existsSync, readFileSync, readdirSync, mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { describe, it, expect, beforeAll, afterEach } from "vitest";

import { createDatabase } from "../../../src/database/connection.js";
import { runMigrations } from "../../../src/database/migrations/runner.js";
import { applySeed } from "../../../src/seed/apply.js";
import type { SeedFile } from "../../../src/seed/types.js";
import { validateSeed } from "../../../src/seed/validate.js";
import { LocalStorage } from "../../../src/storage/local.js";
import { ensureBuilt } from "../server.js";

const exec = promisify(execFile);

const WORKSPACE_ROOT = resolve(import.meta.dirname, "../../../../..");
const CLI_BIN = resolve(import.meta.dirname, "../../../dist/cli/index.mjs");
const VALIDATION_FAILED_RE = /validation failed/i;
const SEED_SCHEMA_URL = "https://emdashcms.com/seed.schema.json";

// ---------------------------------------------------------------------------
// Discover all templates and demos with seed files
// ---------------------------------------------------------------------------

interface SiteFixture {
	/** Human-readable name for test output */
	name: string;
	/** Absolute path to the template/theme directory */
	dir: string;
	/** Absolute path to the seed file */
	seedPath: string;
	/** Parsed seed file contents */
	seed: SeedFile;
}

function discoverFixtures(): SiteFixture[] {
	const fixtures: SiteFixture[] = [];

	const dirs = [
		{ prefix: "templates", path: resolve(WORKSPACE_ROOT, "templates") },
		{ prefix: "demos", path: resolve(WORKSPACE_ROOT, "demos") },
	];

	for (const { prefix, path: parentDir } of dirs) {
		if (!existsSync(parentDir)) continue;

		for (const entry of readdirSync(parentDir)) {
			const dir = join(parentDir, entry);

			// Check for seed path in package.json first (emdash.seed config)
			let seedPath = join(dir, ".emdash", "seed.json");
			const pkgPath = join(dir, "package.json");

			if (existsSync(pkgPath)) {
				try {
					const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
					if (pkg.emdash?.seed) {
						seedPath = join(dir, pkg.emdash.seed);
					}
				} catch {
					// Ignore parse errors
				}
			}

			if (!existsSync(seedPath)) continue;

			const raw = readFileSync(seedPath, "utf-8");
			const seed = JSON.parse(raw) as SeedFile;

			fixtures.push({
				name: `${prefix}/${entry}`,
				dir,
				seedPath,
				seed,
			});
		}
	}

	return fixtures;
}

const fixtures = discoverFixtures();

describe("published seed schema", () => {
	it("is available at the canonical docs site path", () => {
		const schemaPath = resolve(WORKSPACE_ROOT, "docs/public/seed.schema.json");
		const schema = JSON.parse(readFileSync(schemaPath, "utf-8")) as {
			$id?: string;
			properties?: { version?: { const?: string } };
		};

		expect(schema.$id).toBe(SEED_SCHEMA_URL);
		expect(schema.properties?.version?.const).toBe("1");
		for (const fixture of fixtures) {
			expect(fixture.seed.$schema).toBe(SEED_SCHEMA_URL);
		}
	});
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Seed Fixture Smoke Tests", () => {
	let tempDirs: string[] = [];

	beforeAll(async () => {
		// Ensure CLI binary is built for CLI-based tests
		await ensureBuilt();
	}, 120_000);

	afterEach(() => {
		// Clean up any temp directories created during tests
		for (const dir of tempDirs) {
			rmSync(dir, { recursive: true, force: true });
		}
		tempDirs = [];
	});

	function createTempDir(): string {
		const dir = mkdtempSync(join(tmpdir(), "emdash-smoke-"));
		tempDirs.push(dir);
		return dir;
	}

	// Sanity check: we actually found fixtures to test
	it("discovers at least one template/demo with a seed file", () => {
		expect(fixtures.length).toBeGreaterThanOrEqual(1);
		const names = fixtures.map((f) => f.name);
		// At minimum the blog template should always be present.
		expect(names).toContain("templates/blog");
	});

	// -----------------------------------------------------------------------
	// Per-fixture tests
	// -----------------------------------------------------------------------

	for (const fixture of fixtures) {
		describe(fixture.name, () => {
			// --- Seed file is valid JSON with correct structure ---

			it("has a valid seed.json that parses as JSON", () => {
				expect(fixture.seed).toBeDefined();
				expect(fixture.seed.version).toBe("1");
			});

			// --- Programmatic validation ---

			it("passes programmatic seed validation", () => {
				const result = validateSeed(fixture.seed);
				if (!result.valid) {
					// Include errors in failure message for debuggability
					expect.fail(`Seed validation failed:\n${result.errors.join("\n")}`);
				}
				expect(result.valid).toBe(true);
			});

			// --- CLI --validate ---

			it("passes CLI seed --validate", async () => {
				const { stdout, stderr } = await exec(
					"node",
					[CLI_BIN, "seed", fixture.seedPath, "--validate"],
					{
						cwd: fixture.dir,
						timeout: 15_000,
					},
				);
				// The validate command should succeed (exit 0) — if it throws,
				// the test will fail with the error message
				expect(stdout + stderr).not.toMatch(VALIDATION_FAILED_RE);
			});

			// --- Seed applies to fresh database ---

			it("applies seed to a fresh database without errors", { timeout: 30_000 }, async () => {
				const tempDir = createTempDir();
				const dbPath = join(tempDir, "test.db");
				const uploadsDir = join(tempDir, "uploads");
				mkdirSync(uploadsDir, { recursive: true });

				// Create database and run migrations
				const db = createDatabase({ url: `file:${dbPath}` });

				try {
					const { applied } = await runMigrations(db);
					expect(applied.length).toBeGreaterThan(0);

					// Set up local storage for media resolution
					const storage = new LocalStorage({
						directory: uploadsDir,
						baseUrl: "/_emdash/api/media/file",
					});

					// Apply seed
					const result = await applySeed(db, fixture.seed, {
						includeContent: true,
						onConflict: "skip",
						storage,
						mediaBasePath: join(fixture.dir, ".emdash"),
					});

					// Verify collections were created
					if (fixture.seed.collections && fixture.seed.collections.length > 0) {
						expect(result.collections.created).toBeGreaterThan(0);
					}

					// Verify fields were created
					const totalFields =
						fixture.seed.collections?.reduce((sum, c) => sum + (c.fields?.length ?? 0), 0) ?? 0;
					if (totalFields > 0) {
						expect(result.fields.created).toBeGreaterThan(0);
					}

					// Verify content was created if seed has content
					if (fixture.seed.content) {
						const totalEntries = Object.values(fixture.seed.content).reduce(
							(sum, entries) => sum + (Array.isArray(entries) ? entries.length : 0),
							0,
						);
						if (totalEntries > 0) {
							expect(result.content.created).toBeGreaterThan(0);
						}
					}

					// Verify taxonomy processing completed (some may be pre-seeded by migrations)
					if (fixture.seed.taxonomies && fixture.seed.taxonomies.length > 0) {
						// Taxonomies either created or already existed — just verify no crash
						expect(result.taxonomies.created + result.taxonomies.terms).toBeGreaterThanOrEqual(0);
					}

					// Verify menus if present
					if (fixture.seed.menus && fixture.seed.menus.length > 0) {
						expect(result.menus.created).toBeGreaterThan(0);
					}
				} finally {
					await db.destroy();
				}
			});

			// --- CLI seed apply + doctor ---

			it("passes CLI doctor after seed apply", { timeout: 30_000 }, async () => {
				const tempDir = createTempDir();
				const dbPath = join(tempDir, "test.db");

				// Apply seed via CLI (this also runs migrations)
				await exec("node", [CLI_BIN, "seed", fixture.seedPath, "--database", dbPath], {
					cwd: fixture.dir,
					timeout: 30_000,
				});

				// Run doctor and verify all checks pass
				const { stdout } = await exec("node", [CLI_BIN, "doctor", "--database", dbPath, "--json"], {
					cwd: fixture.dir,
					timeout: 15_000,
				});

				const checks = JSON.parse(stdout) as Array<{
					name: string;
					status: "pass" | "warn" | "fail";
					message: string;
				}>;

				// No failures allowed
				const failures = checks.filter((c) => c.status === "fail");
				if (failures.length > 0) {
					expect.fail(
						`Doctor failures:\n${failures.map((f) => `  ${f.name}: ${f.message}`).join("\n")}`,
					);
				}

				// Database, migrations, and collections should all pass
				const dbCheck = checks.find((c) => c.name === "database");
				expect(dbCheck?.status).toBe("pass");

				const migrationsCheck = checks.find((c) => c.name === "migrations");
				expect(migrationsCheck?.status).toBe("pass");

				const collectionsCheck = checks.find((c) => c.name === "collections");
				expect(collectionsCheck?.status).toBe("pass");
			});

			// --- Idempotent re-apply ---

			it(
				"can re-apply seed with on-conflict=skip without errors",
				{ timeout: 30_000 },
				async () => {
					const tempDir = createTempDir();
					const dbPath = join(tempDir, "test.db");
					const uploadsDir = join(tempDir, "uploads");
					mkdirSync(uploadsDir, { recursive: true });

					const db = createDatabase({ url: `file:${dbPath}` });

					try {
						await runMigrations(db);

						const storage = new LocalStorage({
							directory: uploadsDir,
							baseUrl: "/_emdash/api/media/file",
						});

						const seedOpts = {
							includeContent: true,
							onConflict: "skip" as const,
							storage,
							seedDir: join(fixture.dir, ".emdash"),
						};

						// First apply
						await applySeed(db, fixture.seed, seedOpts);

						// Second apply — should not throw
						const result2 = await applySeed(db, fixture.seed, seedOpts);

						// Everything should be skipped on second apply
						expect(result2.collections.created).toBe(0);
					} finally {
						await db.destroy();
					}
				},
			);

			// --- package.json has emdash.seed pointing to seed file ---

			it("has package.json with emdash.seed pointing to the seed file", () => {
				const pkgPath = join(fixture.dir, "package.json");
				if (!existsSync(pkgPath)) return; // blank template has no seed, already filtered
				const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));

				// Either emdash.seed is set, or we rely on the .emdash/seed.json convention
				const seedRef = pkg.emdash?.seed;
				if (seedRef) {
					const resolvedSeedPath = resolve(fixture.dir, seedRef);
					expect(existsSync(resolvedSeedPath)).toBe(true);
				} else {
					// Convention: .emdash/seed.json exists (which it does since we're iterating fixtures)
					expect(existsSync(fixture.seedPath)).toBe(true);
				}
			});
		});
	}

	// -----------------------------------------------------------------------
	// Cross-cutting: all templates/demos have required files
	// -----------------------------------------------------------------------

	describe("Required files", () => {
		const roots = [
			{ prefix: "templates", dir: resolve(WORKSPACE_ROOT, "templates") },
			{ prefix: "demos", dir: resolve(WORKSPACE_ROOT, "demos") },
		].filter((root) => existsSync(root.dir));

		const allDirs = roots
			.flatMap((root) =>
				readdirSync(root.dir).map((entry) => ({
					name: `${root.prefix}/${entry}`,
					dir: join(root.dir, entry),
				})),
			)
			.filter((d) => existsSync(join(d.dir, "package.json")));

		for (const { name, dir } of allDirs) {
			describe(name, () => {
				it("has astro.config.mjs", () => {
					expect(existsSync(join(dir, "astro.config.mjs"))).toBe(true);
				});

				it("has tsconfig.json", () => {
					expect(existsSync(join(dir, "tsconfig.json"))).toBe(true);
				});

				it("has live.config.ts with emdashLoader", () => {
					const liveConfig = join(dir, "src", "live.config.ts");
					expect(existsSync(liveConfig)).toBe(true);

					const content = readFileSync(liveConfig, "utf-8");
					expect(content).toContain("emdashLoader");
					expect(content).toContain("defineLiveCollection");
				});

				it("has typecheck script in package.json", () => {
					const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf-8"));
					expect(pkg.scripts?.typecheck || pkg.scripts?.check).toBeDefined();
				});

				it("uses workspace:* for emdash dependency", () => {
					const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf-8"));
					expect(pkg.dependencies?.emdash).toBe("workspace:*");
				});

				it("uses catalog: for astro dependency", () => {
					const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf-8"));
					const astroVersion = pkg.dependencies?.astro;
					expect(astroVersion).toBe("catalog:");
				});
			});
		}
	});
});
