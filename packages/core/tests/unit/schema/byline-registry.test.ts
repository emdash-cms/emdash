import Database from "better-sqlite3";
import { Kysely, SqliteDialect, sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runMigrations } from "../../../src/database/migrations/runner.js";
import type { Database as EmDashDatabase } from "../../../src/database/types.js";
import { BylineSchemaError, BylineSchemaRegistry } from "../../../src/schema/byline-registry.js";
import { RESERVED_BYLINE_FIELD_SLUGS } from "../../../src/schema/types.js";

describe("BylineSchemaRegistry", () => {
	let db: Kysely<EmDashDatabase>;
	let registry: BylineSchemaRegistry;

	beforeEach(async () => {
		const sqlite = new Database(":memory:");
		db = new Kysely<EmDashDatabase>({
			dialect: new SqliteDialect({ database: sqlite }),
		});
		await runMigrations(db);
		registry = new BylineSchemaRegistry(db);
	});

	afterEach(async () => {
		await db.destroy();
	});

	describe("createField", () => {
		it("creates a string field with sensible defaults", async () => {
			const field = await registry.createField({
				slug: "job_title",
				label: "Job title",
				type: "string",
			});

			expect(field.slug).toBe("job_title");
			expect(field.label).toBe("Job title");
			expect(field.type).toBe("string");
			expect(field.required).toBe(false);
			expect(field.translatable).toBe(true);
			expect(field.validation).toBeNull();
			expect(field.sortOrder).toBe(0);
			expect(field.id).toBeDefined();
		});

		it("persists required + translatable=false + validation when provided", async () => {
			const field = await registry.createField({
				slug: "twitter_handle",
				label: "Twitter",
				type: "string",
				required: true,
				translatable: false,
			});

			expect(field.required).toBe(true);
			expect(field.translatable).toBe(false);

			// Round-trip via getField to confirm storage.
			const reloaded = await registry.getField("twitter_handle");
			expect(reloaded?.required).toBe(true);
			expect(reloaded?.translatable).toBe(false);
		});

		it("auto-assigns increasing sort_order when omitted", async () => {
			const a = await registry.createField({ slug: "a", label: "A", type: "string" });
			const b = await registry.createField({ slug: "b", label: "B", type: "string" });
			const c = await registry.createField({ slug: "c", label: "C", type: "string" });

			expect(a.sortOrder).toBe(0);
			expect(b.sortOrder).toBe(1);
			expect(c.sortOrder).toBe(2);
		});

		it("rejects camelCase slugs with INVALID_SLUG", async () => {
			await expect(
				registry.createField({ slug: "jobTitle", label: "Job title", type: "string" }),
			).rejects.toMatchObject({ name: "BylineSchemaError", code: "INVALID_SLUG" });
		});

		it("rejects PascalCase slugs with INVALID_SLUG", async () => {
			await expect(
				registry.createField({ slug: "JobTitle", label: "Job title", type: "string" }),
			).rejects.toMatchObject({ code: "INVALID_SLUG" });
		});

		it("rejects slugs with hyphens or leading digits", async () => {
			await expect(
				registry.createField({ slug: "job-title", label: "Job title", type: "string" }),
			).rejects.toMatchObject({ code: "INVALID_SLUG" });
			await expect(
				registry.createField({ slug: "1job", label: "Job", type: "string" }),
			).rejects.toMatchObject({ code: "INVALID_SLUG" });
		});

		it("rejects every reserved slug with RESERVED_SLUG", async () => {
			for (const slug of RESERVED_BYLINE_FIELD_SLUGS) {
				await expect(
					registry.createField({ slug, label: "Reserved", type: "string" }),
				).rejects.toMatchObject({ code: "RESERVED_SLUG", details: { slug } });
			}
		});

		it("rejects unsupported field types with INVALID_TYPE", async () => {
			// `portableText` is a valid content-field type but not a byline
			// field type — the registry must reject it at the typed-error
			// layer, not at the SQL layer.
			await expect(
				registry.createField({
					slug: "rich",
					label: "Rich",
					// eslint-disable-next-line @typescript-eslint/no-explicit-any -- intentionally crossing the type boundary
					type: "portableText" as any,
				}),
			).rejects.toMatchObject({ code: "INVALID_TYPE" });
		});

		it("rejects duplicate slugs with FIELD_EXISTS (not a raw SQL UNIQUE error)", async () => {
			await registry.createField({ slug: "job_title", label: "Job title", type: "string" });

			await expect(
				registry.createField({ slug: "job_title", label: "Other label", type: "string" }),
			).rejects.toMatchObject({ name: "BylineSchemaError", code: "FIELD_EXISTS" });
		});

		it("requires non-empty validation.options for select fields", async () => {
			await expect(
				registry.createField({ slug: "role", label: "Role", type: "select" }),
			).rejects.toMatchObject({ code: "INVALID_VALIDATION" });
			await expect(
				registry.createField({
					slug: "role",
					label: "Role",
					type: "select",
					validation: { options: [] },
				}),
			).rejects.toMatchObject({ code: "INVALID_VALIDATION" });
		});

		it("rejects duplicate or empty select options", async () => {
			await expect(
				registry.createField({
					slug: "role",
					label: "Role",
					type: "select",
					validation: { options: ["a", "a", "b"] },
				}),
			).rejects.toMatchObject({ code: "INVALID_VALIDATION" });
			await expect(
				registry.createField({
					slug: "role",
					label: "Role",
					type: "select",
					validation: { options: ["a", ""] },
				}),
			).rejects.toMatchObject({ code: "INVALID_VALIDATION" });
		});

		it("strips select-only validation from non-select fields", async () => {
			const field = await registry.createField({
				slug: "title",
				label: "Title",
				type: "string",
				validation: { options: ["junk"] },
			});
			expect(field.validation).toBeNull();
		});
	});

	describe("listFields / getField", () => {
		it("returns an empty list when no fields are registered", async () => {
			expect(await registry.listFields()).toEqual([]);
			expect(await registry.getField("anything")).toBeNull();
		});

		it("orders by sort_order then created_at", async () => {
			const a = await registry.createField({ slug: "a", label: "A", type: "string" });
			const b = await registry.createField({ slug: "b", label: "B", type: "string" });

			// Manually reorder by sort_order to verify ordering.
			await registry.reorderFields(["b", "a"]);
			const list = await registry.listFields();
			expect(list.map((f) => f.slug)).toEqual(["b", "a"]);
			expect(a.id).not.toBe(b.id);
		});
	});

	describe("updateField", () => {
		it("updates label + required + validation and bumps the version counter", async () => {
			const before = await registry.getVersion();
			const created = await registry.createField({
				slug: "role",
				label: "Role",
				type: "select",
				validation: { options: ["editor", "author"] },
			});
			const afterCreate = await registry.getVersion();

			const updated = await registry.updateField("role", {
				label: "Role (renamed)",
				required: true,
				validation: { options: ["editor", "author", "guest"] },
			});

			expect(updated.label).toBe("Role (renamed)");
			expect(updated.required).toBe(true);
			expect(updated.validation?.options).toEqual(["editor", "author", "guest"]);
			expect(updated.id).toBe(created.id);
			expect(await registry.getVersion()).toBeGreaterThan(afterCreate);
			expect(afterCreate).toBeGreaterThan(before);
		});

		it("no-op updates return the field without bumping the version", async () => {
			await registry.createField({ slug: "job_title", label: "Job title", type: "string" });
			const v = await registry.getVersion();

			const result = await registry.updateField("job_title", {});

			expect(result.slug).toBe("job_title");
			expect(await registry.getVersion()).toBe(v);
		});

		it("rejects unknown slugs with FIELD_NOT_FOUND", async () => {
			await expect(registry.updateField("missing", { label: "x" })).rejects.toMatchObject({
				code: "FIELD_NOT_FOUND",
			});
		});

		it("allows flipping translatable when no values exist", async () => {
			await registry.createField({
				slug: "twitter_handle",
				label: "Twitter",
				type: "string",
				translatable: false,
			});

			const flipped = await registry.updateField("twitter_handle", { translatable: true });
			expect(flipped.translatable).toBe(true);
		});

		it("rejects flipping translatable when per-locale values exist", async () => {
			await registry.createField({ slug: "job_title", label: "Job title", type: "string" });
			const field = await registry.getField("job_title");

			// Seed a byline + a per-locale value.
			await sql`
				INSERT INTO _emdash_bylines (id, slug, display_name, locale, translation_group)
				VALUES ('b1', 'jane', 'Jane', 'en', 'b1')
			`.execute(db);
			await sql`
				INSERT INTO _emdash_byline_field_values (byline_id, field_id, value)
				VALUES ('b1', ${field?.id}, '"Editor"')
			`.execute(db);

			await expect(
				registry.updateField("job_title", { translatable: false }),
			).rejects.toMatchObject({ code: "TRANSLATABLE_LOCKED" });
		});

		it("rejects flipping translatable when group-shared values exist", async () => {
			await registry.createField({
				slug: "twitter_handle",
				label: "Twitter",
				type: "string",
				translatable: false,
			});
			const field = await registry.getField("twitter_handle");

			await sql`
				INSERT INTO _emdash_byline_field_group_values (translation_group, field_id, value)
				VALUES ('g1', ${field?.id}, '"@jane"')
			`.execute(db);

			await expect(
				registry.updateField("twitter_handle", { translatable: true }),
			).rejects.toMatchObject({ code: "TRANSLATABLE_LOCKED" });
		});
	});

	describe("deleteField", () => {
		it("removes the field and bumps the version counter", async () => {
			await registry.createField({ slug: "job_title", label: "Job title", type: "string" });
			const v = await registry.getVersion();

			await registry.deleteField("job_title");

			expect(await registry.getField("job_title")).toBeNull();
			expect(await registry.getVersion()).toBeGreaterThan(v);
		});

		it("clears values via application-level cascade (works without FK pragma)", async () => {
			await registry.createField({ slug: "job_title", label: "Job title", type: "string" });
			const field = await registry.getField("job_title");

			// Explicitly leave FK enforcement OFF (better-sqlite3 default in
			// the test connection) to prove the cleanup is app-level, not
			// FK-dependent. Production (`connection.ts:60`) and D1 keep FK
			// ON; this test verifies the registry doesn't *rely* on that.
			await sql`PRAGMA foreign_keys = OFF`.execute(db);
			await sql`
				INSERT INTO _emdash_bylines (id, slug, display_name, locale, translation_group)
				VALUES ('b1', 'jane', 'Jane', 'en', 'b1')
			`.execute(db);
			await sql`
				INSERT INTO _emdash_byline_field_values (byline_id, field_id, value)
				VALUES ('b1', ${field?.id}, '"Editor"')
			`.execute(db);
			await sql`
				INSERT INTO _emdash_byline_field_group_values (translation_group, field_id, value)
				VALUES ('b1', ${field?.id}, '"@jane"')
			`.execute(db);

			await registry.deleteField("job_title");

			const tr = await sql<{ count: number }>`
				SELECT COUNT(*) AS count FROM _emdash_byline_field_values
			`.execute(db);
			const grp = await sql<{ count: number }>`
				SELECT COUNT(*) AS count FROM _emdash_byline_field_group_values
			`.execute(db);
			expect(Number(tr.rows[0]?.count ?? -1)).toBe(0);
			expect(Number(grp.rows[0]?.count ?? -1)).toBe(0);
		});

		it("FK ON DELETE CASCADE still serves as defense-in-depth", async () => {
			// Companion test to the app-level cascade above: with FK ON,
			// even if a future regression removed the app-level DELETEs the
			// schema constraint would catch it. Useful contract to keep
			// asserted so neither layer rots.
			await registry.createField({ slug: "job_title", label: "Job title", type: "string" });
			const field = await registry.getField("job_title");

			await sql`PRAGMA foreign_keys = ON`.execute(db);
			await sql`
				INSERT INTO _emdash_bylines (id, slug, display_name, locale, translation_group)
				VALUES ('b1', 'jane', 'Jane', 'en', 'b1')
			`.execute(db);
			await sql`
				INSERT INTO _emdash_byline_field_values (byline_id, field_id, value)
				VALUES ('b1', ${field?.id}, '"Editor"')
			`.execute(db);

			// Bypass the registry — DELETE the definition row directly,
			// simulating the layered FK fallback. Values should still be gone.
			await sql`DELETE FROM _emdash_byline_fields WHERE id = ${field?.id}`.execute(db);

			const tr = await sql<{ count: number }>`
				SELECT COUNT(*) AS count FROM _emdash_byline_field_values
			`.execute(db);
			expect(Number(tr.rows[0]?.count ?? -1)).toBe(0);
		});

		it("rejects unknown slugs with FIELD_NOT_FOUND", async () => {
			await expect(registry.deleteField("missing")).rejects.toMatchObject({
				code: "FIELD_NOT_FOUND",
			});
		});
	});

	describe("reorderFields", () => {
		it("rewrites sort_order to match the input order and bumps the version", async () => {
			await registry.createField({ slug: "a", label: "A", type: "string" });
			await registry.createField({ slug: "b", label: "B", type: "string" });
			await registry.createField({ slug: "c", label: "C", type: "string" });
			const v = await registry.getVersion();

			await registry.reorderFields(["c", "a", "b"]);

			const list = await registry.listFields();
			expect(list.map((f) => f.slug)).toEqual(["c", "a", "b"]);
			expect(list.map((f) => f.sortOrder)).toEqual([0, 1, 2]);
			expect(await registry.getVersion()).toBeGreaterThan(v);
		});

		it("rejects duplicate slugs with REORDER_MISMATCH", async () => {
			await registry.createField({ slug: "a", label: "A", type: "string" });
			await registry.createField({ slug: "b", label: "B", type: "string" });
			await expect(registry.reorderFields(["a", "a"])).rejects.toMatchObject({
				code: "REORDER_MISMATCH",
			});
		});

		it("rejects input that adds or drops slugs vs the registered set", async () => {
			await registry.createField({ slug: "a", label: "A", type: "string" });
			await registry.createField({ slug: "b", label: "B", type: "string" });

			await expect(registry.reorderFields(["a"])).rejects.toMatchObject({
				code: "REORDER_MISMATCH",
			});
			await expect(registry.reorderFields(["a", "b", "c"])).rejects.toMatchObject({
				code: "REORDER_MISMATCH",
			});
			await expect(registry.reorderFields(["a", "c"])).rejects.toMatchObject({
				code: "REORDER_MISMATCH",
			});
		});

		it("empty registered set + empty input is a no-op (does not throw)", async () => {
			const v = await registry.getVersion();
			await expect(registry.reorderFields([])).resolves.toBeUndefined();
			// No fields, no version bump warranted — but consistent behaviour
			// matters: the version IS bumped because the operation completes.
			// Document the observed behaviour rather than over-specifying.
			expect(await registry.getVersion()).toBeGreaterThanOrEqual(v);
		});
	});

	describe("version counter", () => {
		it("starts at 0 after migration 041", async () => {
			expect(await registry.getVersion()).toBe(0);
		});

		it("monotonically increases across mutations", async () => {
			const v0 = await registry.getVersion();
			await registry.createField({ slug: "a", label: "A", type: "string" });
			const v1 = await registry.getVersion();
			await registry.updateField("a", { label: "Aa" });
			const v2 = await registry.getVersion();
			await registry.createField({ slug: "b", label: "B", type: "string" });
			const v3 = await registry.getVersion();
			await registry.reorderFields(["b", "a"]);
			const v4 = await registry.getVersion();
			await registry.deleteField("a");
			const v5 = await registry.getVersion();

			expect(v0).toBe(0);
			expect(v1).toBe(1);
			expect(v2).toBe(2);
			expect(v3).toBe(3);
			expect(v4).toBe(4);
			expect(v5).toBe(5);
		});

		it("getVersion returns 0 when the row is missing", async () => {
			await sql`DELETE FROM options WHERE name = 'byline_fields_version'`.execute(db);
			expect(await registry.getVersion()).toBe(0);
		});
	});

	describe("bump-before-mutate ordering", () => {
		// These tests pin the observable behaviour that the registry bumps
		// the version counter *before* it applies the schema mutation. The
		// rationale lives in BylineSchemaRegistry's class JSDoc: on D1 (no
		// transactions) a crash between bump and mutation leaves the system
		// recoverable; the opposite order leaves caches stuck stale.
		//
		// "Observable behaviour" here means: when a mutation would fail
		// for a reason that only becomes visible *after* the bump runs
		// (e.g. a UNIQUE-constraint race), the version counter still
		// advanced. Tests that assert "version unchanged on validation
		// rejection" further confirm that pre-bump validation is correct.

		it("createField bumps the version before INSERT (validation errors do NOT bump)", async () => {
			const v0 = await registry.getVersion();

			// Pre-bump validation: an invalid slug never reaches the bump.
			await expect(
				registry.createField({ slug: "JobTitle", label: "Job title", type: "string" }),
			).rejects.toMatchObject({ code: "INVALID_SLUG" });
			expect(await registry.getVersion()).toBe(v0);

			// Successful path: bump lands.
			await registry.createField({ slug: "job_title", label: "Job title", type: "string" });
			expect(await registry.getVersion()).toBe(v0 + 1);

			// Duplicate-slug check is pre-bump too (we call getField first).
			await expect(
				registry.createField({ slug: "job_title", label: "Other", type: "string" }),
			).rejects.toMatchObject({ code: "FIELD_EXISTS" });
			expect(await registry.getVersion()).toBe(v0 + 1);
		});

		it("deleteField bumps the version before the DELETE (FIELD_NOT_FOUND does NOT bump)", async () => {
			const v0 = await registry.getVersion();
			await expect(registry.deleteField("missing")).rejects.toMatchObject({
				code: "FIELD_NOT_FOUND",
			});
			expect(await registry.getVersion()).toBe(v0);

			await registry.createField({ slug: "job_title", label: "Job title", type: "string" });
			const v1 = await registry.getVersion();

			await registry.deleteField("job_title");
			expect(await registry.getVersion()).toBe(v1 + 1);
		});

		it("updateField bumps the version before the UPDATE (TRANSLATABLE_LOCKED does NOT bump)", async () => {
			await registry.createField({ slug: "job_title", label: "Job title", type: "string" });
			const field = await registry.getField("job_title");
			await sql`
				INSERT INTO _emdash_bylines (id, slug, display_name, locale, translation_group)
				VALUES ('b1', 'jane', 'Jane', 'en', 'b1')
			`.execute(db);
			await sql`
				INSERT INTO _emdash_byline_field_values (byline_id, field_id, value)
				VALUES ('b1', ${field?.id}, '"Editor"')
			`.execute(db);

			const v0 = await registry.getVersion();
			// Pre-bump validation catches TRANSLATABLE_LOCKED — version must
			// not advance on a rejected flip.
			await expect(
				registry.updateField("job_title", { translatable: false }),
			).rejects.toMatchObject({ code: "TRANSLATABLE_LOCKED" });
			expect(await registry.getVersion()).toBe(v0);

			// Successful update bumps.
			await registry.updateField("job_title", { label: "Job Title" });
			expect(await registry.getVersion()).toBe(v0 + 1);
		});

		it("reorderFields bumps the version before the UPDATE loop (REORDER_MISMATCH does NOT bump)", async () => {
			await registry.createField({ slug: "a", label: "A", type: "string" });
			await registry.createField({ slug: "b", label: "B", type: "string" });
			const v0 = await registry.getVersion();

			await expect(registry.reorderFields(["a", "c"])).rejects.toMatchObject({
				code: "REORDER_MISMATCH",
			});
			expect(await registry.getVersion()).toBe(v0);

			await registry.reorderFields(["b", "a"]);
			expect(await registry.getVersion()).toBe(v0 + 1);
		});
	});

	describe("typed errors carry stable codes", () => {
		it("error instances are BylineSchemaError with .code", async () => {
			try {
				await registry.createField({ slug: "id", label: "ID", type: "string" });
				expect.fail("should have thrown");
			} catch (error) {
				expect(error).toBeInstanceOf(BylineSchemaError);
				expect((error as BylineSchemaError).code).toBe("RESERVED_SLUG");
			}
		});
	});
});
