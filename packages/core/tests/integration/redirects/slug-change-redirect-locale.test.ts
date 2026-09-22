/**
 * Slug-change auto-redirects must never point away from a URL that still
 * serves content.
 *
 * A collection's `url_pattern` has no locale token, so every locale variant of
 * an entry maps to the same generated URL. Slugs are unique per
 * `(slug, locale)`, so a translation legitimately shares its canonical's slug
 * — and renaming one of them would otherwise emit a 301 whose source is the
 * other's live URL. The redirect middleware runs `order: "pre"`, so such a
 * redirect takes the live page down with no way for routing to recover.
 */

import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { handleContentUpdate } from "../../../src/api/handlers/content.js";
import { ContentRepository } from "../../../src/database/repositories/content.js";
import type { Database } from "../../../src/database/types.js";
import { setI18nConfig } from "../../../src/i18n/config.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

describe("slug-change auto-redirect — locale awareness", () => {
	let db: Kysely<Database>;
	let repo: ContentRepository;

	beforeEach(async () => {
		db = await setupTestDatabase();
		repo = new ContentRepository(db);

		const registry = new SchemaRegistry(db);
		await registry.createCollection({
			slug: "venue",
			label: "Venues",
			labelSingular: "Venue",
			urlPattern: "/sede/{slug}",
		});
		await registry.createField("venue", {
			slug: "title",
			label: "Title",
			type: "string",
		});

		// Spanish canonical site: es is the default locale, en is a translation.
		setI18nConfig({ locales: ["es", "en"], defaultLocale: "es" });
	});

	afterEach(async () => {
		setI18nConfig(null);
		await teardownTestDatabase(db);
	});

	async function redirectSources(): Promise<string[]> {
		const rows = await db.selectFrom("_emdash_redirects").select(["source"]).execute();
		return rows.map((r) => r.source);
	}

	it("does not redirect the canonical URL when a translation sharing its slug is renamed", async () => {
		const canonical = await repo.create({
			type: "venue",
			slug: "cineteca-nacional",
			locale: "es",
			status: "published",
			data: { title: "Cineteca Nacional" },
		});
		const twin = await repo.create({
			type: "venue",
			slug: "cineteca-nacional",
			locale: "en",
			status: "published",
			translationOf: canonical.id,
			data: { title: "Cineteca Nacional" },
		});

		const result = await handleContentUpdate(db, "venue", twin.id, { slug: "cinematheque" });
		expect(result.success).toBe(true);

		// The canonical Spanish page still lives at /sede/cineteca-nacional/.
		expect(await redirectSources()).not.toContain("/sede/cineteca-nacional");
	});

	it("does not redirect a URL still held by a translation when the canonical is renamed", async () => {
		const canonical = await repo.create({
			type: "venue",
			slug: "cineteca-nacional",
			locale: "es",
			status: "published",
			data: { title: "Cineteca Nacional" },
		});
		await repo.create({
			type: "venue",
			slug: "cineteca-nacional",
			locale: "en",
			status: "published",
			translationOf: canonical.id,
			data: { title: "Cineteca Nacional" },
		});

		const result = await handleContentUpdate(db, "venue", canonical.id, { slug: "cineteca" });
		expect(result.success).toBe(true);

		expect(await redirectSources()).not.toContain("/sede/cineteca-nacional");
	});

	it("still redirects when the renamed entry owned the URL outright", async () => {
		const solo = await repo.create({
			type: "venue",
			slug: "teatro-viejo",
			locale: "es",
			status: "published",
			data: { title: "Teatro Viejo" },
		});

		const result = await handleContentUpdate(db, "venue", solo.id, { slug: "teatro-nuevo" });
		expect(result.success).toBe(true);

		const rows = await db
			.selectFrom("_emdash_redirects")
			.select(["source", "destination"])
			.execute();
		expect(rows).toEqual([
			expect.objectContaining({ source: "/sede/teatro-viejo", destination: "/sede/teatro-nuevo" }),
		]);
	});
});
