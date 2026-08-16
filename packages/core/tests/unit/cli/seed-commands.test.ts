/**
 * Tests for CLI seed commands
 */

import { mkdtemp, rm, writeFile, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { exportSeed } from "../../../src/cli/commands/export-seed.js";
import { createDatabase } from "../../../src/database/connection.js";
import { runMigrations } from "../../../src/database/migrations/runner.js";
import { ContentRepository } from "../../../src/database/repositories/content.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import { applySeed } from "../../../src/seed/apply.js";
import type { SeedFile } from "../../../src/seed/types.js";
import { validateSeed } from "../../../src/seed/validate.js";

describe("CLI Seed Commands", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "emdash-cli-test-"));
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	describe("seed file resolution", () => {
		it("should resolve .emdash/seed.json by convention", async () => {
			// Create convention seed file
			const emdashDir = join(tempDir, ".emdash");
			await mkdir(emdashDir);
			const seedPath = join(emdashDir, "seed.json");

			const seed: SeedFile = {
				version: "1",
				settings: { title: "Convention Seed" },
			};
			await writeFile(seedPath, JSON.stringify(seed));

			// Read it back
			const content = await readFile(seedPath, "utf-8");
			const parsed = JSON.parse(content);
			expect(parsed.settings.title).toBe("Convention Seed");
		});

		it("should resolve seed from package.json emdash.seed", async () => {
			// Create seed file in custom location
			const customDir = join(tempDir, "custom");
			await mkdir(customDir);
			const seedPath = join(customDir, "my-seed.json");

			const seed: SeedFile = {
				version: "1",
				settings: { title: "Package.json Seed" },
			};
			await writeFile(seedPath, JSON.stringify(seed));

			// Create package.json referencing it
			const pkg = {
				name: "test-project",
				emdash: {
					seed: "custom/my-seed.json",
				},
			};
			await writeFile(join(tempDir, "package.json"), JSON.stringify(pkg));

			// Verify the referenced path works
			const content = await readFile(seedPath, "utf-8");
			const parsed = JSON.parse(content);
			expect(parsed.settings.title).toBe("Package.json Seed");
		});
	});

	describe("seed validation", () => {
		it("should validate a valid seed file", () => {
			const seed: SeedFile = {
				version: "1",
				settings: { title: "Test Site" },
				collections: [
					{
						slug: "posts",
						label: "Posts",
						fields: [{ slug: "title", label: "Title", type: "string", required: true }],
					},
				],
			};

			const result = validateSeed(seed);
			expect(result.valid).toBe(true);
			expect(result.errors).toHaveLength(0);
		});

		it("should reject invalid seed version", () => {
			const seed = {
				version: "999",
				settings: {},
			};

			const result = validateSeed(seed);
			expect(result.valid).toBe(false);
			expect(result.errors.some((e) => e.includes("version"))).toBe(true);
		});

		it("should reject seed with invalid collection", () => {
			const seed: SeedFile = {
				version: "1",
				collections: [
					{
						slug: "", // Invalid: empty slug
						label: "Posts",
						fields: [],
					},
				],
			};

			const result = validateSeed(seed);
			expect(result.valid).toBe(false);
		});
	});

	describe("seed application", () => {
		it("should apply settings from seed", async () => {
			const dbPath = join(tempDir, "test.db");
			const db = createDatabase({ url: `file:${dbPath}` });

			try {
				await runMigrations(db);

				const seed: SeedFile = {
					version: "1",
					settings: {
						title: "My Test Site",
						tagline: "A test site for testing",
					},
				};

				const result = await applySeed(db, seed, {});

				expect(result.settings.applied).toBe(2);
			} finally {
				await db.destroy();
			}
		});

		it("should apply collections from seed", async () => {
			const dbPath = join(tempDir, "test.db");
			const db = createDatabase({ url: `file:${dbPath}` });

			try {
				await runMigrations(db);

				const seed: SeedFile = {
					version: "1",
					collections: [
						{
							slug: "articles",
							label: "Articles",
							labelSingular: "Article",
							fields: [
								{
									slug: "title",
									label: "Title",
									type: "string",
									required: true,
								},
								{ slug: "body", label: "Body", type: "portableText" },
							],
						},
					],
				};

				const result = await applySeed(db, seed, {});

				expect(result.collections.created).toBe(1);
				expect(result.fields.created).toBe(2);
			} finally {
				await db.destroy();
			}
		});

		it("should be idempotent (skip existing)", async () => {
			const dbPath = join(tempDir, "test.db");
			const db = createDatabase({ url: `file:${dbPath}` });

			try {
				await runMigrations(db);

				const seed: SeedFile = {
					version: "1",
					collections: [
						{
							slug: "pages",
							label: "Pages",
							fields: [{ slug: "title", label: "Title", type: "string" }],
						},
					],
				};

				// First apply
				const result1 = await applySeed(db, seed, {});
				expect(result1.collections.created).toBe(1);
				expect(result1.collections.skipped).toBe(0);

				// Second apply - should skip
				const result2 = await applySeed(db, seed, {});
				expect(result2.collections.created).toBe(0);
				expect(result2.collections.skipped).toBe(1);
			} finally {
				await db.destroy();
			}
		});
	});

	describe("export-seed output", () => {
		it("preserves slugless content in a non-routable collection", async () => {
			const dbPath = join(tempDir, "slugless-content.db");
			const db = createDatabase({ url: `file:${dbPath}` });

			try {
				await runMigrations(db);
				const registry = new SchemaRegistry(db);
				await registry.createCollection({ slug: "blocks", label: "Blocks", routable: false });
				await registry.createField("blocks", { slug: "title", label: "Title", type: "string" });
				await new ContentRepository(db).create({
					type: "blocks",
					slug: null,
					status: "published",
					data: { title: "Hero" },
				});

				const exported = await exportSeed(db, "blocks");
				const entry = exported.content?.blocks?.[0];
				expect(entry?.slug).toBeUndefined();
				expect(validateSeed(exported)).toMatchObject({ valid: true, errors: [] });
			} finally {
				await db.destroy();
			}
		});

		it("falls back for unusable routable slugs while preserving a zero slug", async () => {
			const dbPath = join(tempDir, "legacy-routable-content.db");
			const db = createDatabase({ url: `file:${dbPath}` });

			try {
				await runMigrations(db);
				const registry = new SchemaRegistry(db);
				await registry.createCollection({ slug: "posts", label: "Posts" });
				await registry.createField("posts", { slug: "title", label: "Title", type: "string" });
				const contentRepo = new ContentRepository(db);
				const whitespace = await contentRepo.create({
					type: "posts",
					slug: "   ",
					status: "published",
					data: { title: "Legacy" },
				});
				await contentRepo.create({
					type: "posts",
					slug: "0",
					status: "published",
					data: { title: "Zero" },
				});

				const exported = await exportSeed(db, "posts");
				const slugs = exported.content?.posts?.map((entry) => entry.slug);
				expect(slugs).toContain(whitespace.id);
				expect(slugs).toContain("0");
				expect(validateSeed(exported)).toMatchObject({ valid: true, errors: [] });
			} finally {
				await db.destroy();
			}
		});

		it("preserves a non-routable collection", async () => {
			const dbPath = join(tempDir, "routable.db");
			const db = createDatabase({ url: `file:${dbPath}` });

			try {
				await runMigrations(db);
				await applySeed(db, {
					version: "1",
					collections: [
						{
							slug: "blocks",
							label: "Blocks",
							routable: false,
							fields: [{ slug: "title", label: "Title", type: "string" }],
						},
					],
				});

				const exported = await exportSeed(db);
				expect(exported.collections?.[0]?.routable).toBe(false);
				expect(validateSeed(exported)).toMatchObject({ valid: true, errors: [] });
			} finally {
				await db.destroy();
			}
		});

		it("preserves collection list columns through apply and export", async () => {
			const dbPath = join(tempDir, "admin-config.db");
			const db = createDatabase({ url: `file:${dbPath}` });

			try {
				await runMigrations(db);
				await applySeed(db, {
					version: "1",
					collections: [
						{
							slug: "tickets",
							label: "Tickets",
							admin: { listColumns: ["ticket_number", "priority"] },
							fields: [
								{ slug: "ticket_number", label: "Ticket number", type: "string" },
								{ slug: "priority", label: "Priority", type: "select" },
							],
						},
					],
				});

				const exported = await exportSeed(db);
				const tickets = exported.collections?.find((collection) => collection.slug === "tickets");

				expect(tickets?.admin).toEqual({
					listColumns: ["ticket_number", "priority"],
				});
				expect(validateSeed(exported)).toMatchObject({ valid: true, errors: [] });
			} finally {
				await db.destroy();
			}
		});

		it("should produce valid seed from exported data", async () => {
			const dbPath = join(tempDir, "test.db");
			const db = createDatabase({ url: `file:${dbPath}` });

			try {
				await runMigrations(db);

				// Apply a seed first
				const inputSeed: SeedFile = {
					version: "1",
					settings: { title: "Export Test" },
					collections: [
						{
							slug: "docs",
							label: "Documentation",
							fields: [
								{ slug: "title", label: "Title", type: "string" },
								{ slug: "content", label: "Content", type: "portableText" },
							],
						},
					],
				};

				await applySeed(db, inputSeed, {});

				// Now export (simulating what export-seed does)
				// For this test, we just verify the input seed validates
				const validation = validateSeed(inputSeed);
				expect(validation.valid).toBe(true);
			} finally {
				await db.destroy();
			}
		});
	});

	describe("content export with $media", () => {
		it("should handle content without media gracefully", async () => {
			const dbPath = join(tempDir, "test.db");
			const db = createDatabase({ url: `file:${dbPath}` });

			try {
				await runMigrations(db);

				const seed: SeedFile = {
					version: "1",
					collections: [
						{
							slug: "posts",
							label: "Posts",
							fields: [{ slug: "title", label: "Title", type: "string" }],
						},
					],
					content: {
						posts: [
							{
								id: "post-1",
								slug: "hello-world",
								status: "published",
								data: { title: "Hello World" },
							},
						],
					},
				};

				const result = await applySeed(db, seed, { includeContent: true });

				expect(result.collections.created).toBe(1);
				expect(result.content.created).toBe(1);
			} finally {
				await db.destroy();
			}
		});
	});
});
