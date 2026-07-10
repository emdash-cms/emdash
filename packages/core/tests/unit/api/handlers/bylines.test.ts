import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	handleBylineCreate,
	handleBylineTranslations,
} from "../../../../src/api/handlers/bylines.js";
import { BylineRepository } from "../../../../src/database/repositories/byline.js";
import type { Database } from "../../../../src/database/types.js";
import { setI18nConfig } from "../../../../src/i18n/config.js";
import { setupTestDatabaseWithCollections, teardownTestDatabase } from "../../../utils/test-db.js";

describe("byline handlers", () => {
	let db: Kysely<Database>;
	let repo: BylineRepository;

	beforeEach(async () => {
		db = await setupTestDatabaseWithCollections();
		repo = new BylineRepository(db);
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	describe("handleBylineTranslations", () => {
		it("returns every sibling row for an existing byline", async () => {
			const anchor = await repo.create({
				slug: "jane",
				displayName: "Jane Doe",
				locale: "en",
			});
			await repo.create({
				slug: "jane",
				displayName: "Jeanne",
				locale: "fr",
				translationOf: anchor.id,
			});

			const result = await handleBylineTranslations(db, anchor.id);
			expect(result.success).toBe(true);
			if (!result.success) return;
			expect(result.data.items.map((b) => b.locale).toSorted()).toEqual(["en", "fr"]);
		});

		it("returns NOT_FOUND when the byline does not exist", async () => {
			const result = await handleBylineTranslations(db, "non-existent-id");
			expect(result.success).toBe(false);
			if (result.success) return;
			expect(result.error.code).toBe("NOT_FOUND");
		});

		it("returns a single-item list when the byline has no siblings", async () => {
			const anchor = await repo.create({
				slug: "solo",
				displayName: "Solo Author",
			});

			const result = await handleBylineTranslations(db, anchor.id);
			expect(result.success).toBe(true);
			if (!result.success) return;
			expect(result.data.items).toHaveLength(1);
			expect(result.data.items[0]?.id).toBe(anchor.id);
		});
	});

	describe("handleBylineCreate (translationOf)", () => {
		it("rejects translationOf without locale (handler-level guard)", async () => {
			const anchor = await repo.create({
				slug: "jane",
				displayName: "Jane Doe",
				locale: "en",
			});

			const result = await handleBylineCreate(db, {
				slug: "jane",
				displayName: "Jeanne",
				translationOf: anchor.id,
				// locale intentionally omitted
			});

			// Previously this guard lived only at the route boundary, so SDK
			// callers could clone into the default locale by accident. The
			// handler now refuses.
			expect(result.success).toBe(false);
			if (result.success) return;
			expect(result.error.code).toBe("VALIDATION_ERROR");
			expect(result.error.message).toMatch(/locale/i);
			expect(result.error.message).toMatch(/translationOf/i);

			// No sibling row created.
			const siblings = await repo.listTranslations(anchor.id);
			expect(siblings).toHaveLength(1);
		});

		it("creates a sibling row sharing the source's translation_group", async () => {
			const anchor = await repo.create({
				slug: "jane",
				displayName: "Jane Doe",
				locale: "en",
			});

			const result = await handleBylineCreate(db, {
				slug: "jane",
				displayName: "Jeanne",
				locale: "fr",
				translationOf: anchor.id,
			});

			expect(result.success).toBe(true);
			if (!result.success) return;
			expect(result.data.locale).toBe("fr");
			expect(result.data.translationGroup).toBe(anchor.translationGroup);
			expect(result.data.id).not.toBe(anchor.id);
		});

		it("returns NOT_FOUND when the source byline is missing", async () => {
			const result = await handleBylineCreate(db, {
				slug: "ghost",
				displayName: "Ghost",
				locale: "fr",
				translationOf: "non-existent-id",
			});

			expect(result.success).toBe(false);
			if (result.success) return;
			expect(result.error.code).toBe("NOT_FOUND");
			expect(result.error.message).toMatch(/source byline/i);
		});

		it("returns CONFLICT when a sibling already exists at the target locale", async () => {
			const anchor = await repo.create({
				slug: "jane",
				displayName: "Jane Doe",
				locale: "en",
			});
			await repo.create({
				slug: "jane",
				displayName: "Jeanne",
				locale: "fr",
				translationOf: anchor.id,
			});

			const result = await handleBylineCreate(db, {
				slug: "jane",
				displayName: "Jeanne 2",
				locale: "fr",
				translationOf: anchor.id,
			});

			expect(result.success).toBe(false);
			if (result.success) return;
			expect(result.error.code).toBe("CONFLICT");
			// The translation-group conflict fires before the (slug, locale)
			// conflict — siblings within the same translation_group are
			// constrained to one row per locale by the partial unique index.
			expect(result.error.message).toMatch(/translation already exists/i);
			expect(result.error.message).toMatch(/fr/);
		});

		it("returns CONFLICT when translationOf points at a group that already has the target locale, even with a different slug", async () => {
			const anchor = await repo.create({
				slug: "jane",
				displayName: "Jane Doe",
				locale: "en",
			});
			await repo.create({
				slug: "jane",
				displayName: "Jeanne",
				locale: "fr",
				translationOf: anchor.id,
			});

			// Different slug — the (slug, locale) UNIQUE wouldn't catch this,
			// but the (translation_group, locale) partial unique + the
			// handler-level guard should.
			const result = await handleBylineCreate(db, {
				slug: "jane-alt",
				displayName: "Jeanne Alt",
				locale: "fr",
				translationOf: anchor.id,
			});

			expect(result.success).toBe(false);
			if (result.success) return;
			expect(result.error.code).toBe("CONFLICT");
			expect(result.error.message).toMatch(/translation already exists/i);
		});

		it("returns CONFLICT when a non-translation byline with the same (slug, locale) exists", async () => {
			await repo.create({
				slug: "jane",
				displayName: "Jane Doe",
				locale: "en",
			});

			const result = await handleBylineCreate(db, {
				slug: "jane",
				displayName: "Other Jane",
				// Implicit defaultLocale (no `locale` field) — should still
				// collide with the existing en row because the handler
				// resolves the effective locale before the conflict check.
			});

			expect(result.success).toBe(false);
			if (result.success) return;
			expect(result.error.code).toBe("CONFLICT");
		});

		it("creates an anchor (no translationOf) successfully", async () => {
			const result = await handleBylineCreate(db, {
				slug: "ada",
				displayName: "Ada",
			});
			expect(result.success).toBe(true);
			if (!result.success) return;
			expect(result.data.translationGroup).toBe(result.data.id);
		});

		// Schema only enforces non-empty strings; an unknown locale like
		// "zz" would otherwise create a row no resolver ever asks for.
		// Validate against the configured locales here.
		it("rejects a locale that is not in the configured site locales", async () => {
			setI18nConfig({ defaultLocale: "en", locales: ["en", "fr"] });
			try {
				const result = await handleBylineCreate(db, {
					slug: "jane",
					displayName: "Jane",
					locale: "zz",
				});
				expect(result.success).toBe(false);
				if (result.success) return;
				expect(result.error.code).toBe("VALIDATION_ERROR");
				expect(result.error.message).toMatch(/zz/);
			} finally {
				setI18nConfig(null);
			}
		});

		it("accepts a configured locale", async () => {
			setI18nConfig({ defaultLocale: "en", locales: ["en", "fr"] });
			try {
				const result = await handleBylineCreate(db, {
					slug: "jane",
					displayName: "Jane",
					locale: "fr",
				});
				expect(result.success).toBe(true);
			} finally {
				setI18nConfig(null);
			}
		});

		it("skips locale validation when no i18n config is set", async () => {
			setI18nConfig(null);
			const result = await handleBylineCreate(db, {
				slug: "jane",
				displayName: "Jane",
				locale: "anything",
			});
			expect(result.success).toBe(true);
		});
	});

	describe("schema validation (Zod)", () => {
		it("rejects an empty-string locale on byline create", async () => {
			const { bylineCreateBody } = await import("../../../../src/api/schemas/bylines.js");
			const result = bylineCreateBody.safeParse({
				slug: "x",
				displayName: "X",
				locale: "",
			});
			expect(result.success).toBe(false);
		});

		it("rejects an empty-string locale on byline list query", async () => {
			const { bylinesListQuery } = await import("../../../../src/api/schemas/bylines.js");
			const result = bylinesListQuery.safeParse({ locale: "" });
			expect(result.success).toBe(false);
		});

		it("accepts an omitted locale", async () => {
			const { bylineCreateBody } = await import("../../../../src/api/schemas/bylines.js");
			const result = bylineCreateBody.safeParse({ slug: "x", displayName: "X" });
			expect(result.success).toBe(true);
		});

		it("accepts a non-empty locale", async () => {
			const { bylineCreateBody } = await import("../../../../src/api/schemas/bylines.js");
			const result = bylineCreateBody.safeParse({
				slug: "x",
				displayName: "X",
				locale: "de-de",
			});
			expect(result.success).toBe(true);
		});
	});
});
