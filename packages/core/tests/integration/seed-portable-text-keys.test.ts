/**
 * Regression guard for issue #867 (and the related portfolio
 * `featured_image` shape bug surfaced during review).
 *
 * The bug: PR #777 wired the existing `generateZodSchema()` into the
 * runtime content-update path, so autosave now validates the body the
 * admin re-sends on every keystroke. Several first-party templates ship
 * seed content that didn't satisfy that schema (PT blocks missing
 * `_key`, portfolio's `featured_image` as bare URL strings instead of
 * media objects). The result: any user who scaffolded those templates
 * couldn't save edits to seeded entries.
 *
 * This test does the smallest end-to-end thing that would have caught
 * both regressions: for every shipped template seed, apply it to a
 * fresh DB and re-validate every stored entry against the same
 * validator the autosave endpoint uses (`validateContentData` with
 * `partial: true`). If a template ever ships malformed seed data
 * again, this fails before release.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { validateContentData } from "../../src/api/handlers/validation.js";
import type { Database } from "../../src/database/types.js";
import { applySeed } from "../../src/seed/apply.js";
import type { SeedFile } from "../../src/seed/types.js";
import { setupTestDatabase, teardownTestDatabase } from "../utils/test-db.js";

// `tests/integration/` -> repo root is four levels up.
const WORKSPACE_ROOT = resolve(import.meta.dirname, "../../../..");

const TEMPLATE_SEEDS = [
	"templates/blog/seed/seed.json",
	"templates/blog-cloudflare/seed/seed.json",
	"templates/portfolio/seed/seed.json",
	"templates/portfolio-cloudflare/seed/seed.json",
	"templates/starter/seed/seed.json",
	"templates/starter-cloudflare/seed/seed.json",
	"templates/marketing/seed/seed.json",
	"templates/marketing-cloudflare/seed/seed.json",
] as const;

function loadSeed(rel: string): SeedFile {
	const abs = resolve(WORKSPACE_ROOT, rel);
	return JSON.parse(readFileSync(abs, "utf8")) as SeedFile;
}

/**
 * Walk a seed and return every collection slug that has at least one
 * entry, so the test can iterate dynamic `ec_*` tables without
 * hard-coding them. Returns slugs in seed order to keep failures
 * predictable.
 */
function collectionsWithContent(seed: SeedFile): string[] {
	if (!seed.content) return [];
	const out: string[] = [];
	for (const [slug, entries] of Object.entries(seed.content)) {
		if (Array.isArray(entries) && entries.length > 0) out.push(slug);
	}
	return out;
}

describe("shipped template seeds survive the autosave validator (issue #867)", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		db = await setupTestDatabase();
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	for (const rel of TEMPLATE_SEEDS) {
		it(`${rel}: every seeded entry round-trips through validateContentData`, async () => {
			const seed = loadSeed(rel);

			// `includeContent: true` is what `create-emdash` setup uses.
			// `skipMediaDownload: true` keeps the test offline -- we don't
			// care about the actual bytes here, only the validator-relevant
			// shape of stored entries.
			await applySeed(db, seed, {
				includeContent: true,
				skipMediaDownload: true,
			});

			const slugs = collectionsWithContent(seed);
			if (slugs.length === 0) {
				// Marketing has no content entries -- nothing to validate,
				// but exercising applySeed itself is still useful coverage.
				return;
			}

			for (const slug of slugs) {
				const tableName = `ec_${slug}`;
				const rows = await db
					// biome-ignore lint/suspicious/noExplicitAny: dynamic content table
					.selectFrom(tableName as any)
					.selectAll()
					.where("deleted_at", "is", null)
					// biome-ignore lint/suspicious/noExplicitAny: dynamic content table
					.execute();

				expect(rows.length, `expected at least one row in ${tableName}`).toBeGreaterThan(0);

				for (const row of rows as Array<Record<string, unknown>>) {
					// Reconstruct the data shape the admin holds in memory:
					// system columns + the user's field columns. We strip
					// the obvious system columns so they don't get flagged
					// as "unknown field" by the validator.
					const data: Record<string, unknown> = {};
					for (const [k, v] of Object.entries(row)) {
						if (
							k === "id" ||
							k === "slug" ||
							k === "status" ||
							k === "author_id" ||
							k === "primary_byline_id" ||
							k === "created_at" ||
							k === "updated_at" ||
							k === "published_at" ||
							k === "scheduled_at" ||
							k === "deleted_at" ||
							k === "version" ||
							k === "live_revision_id" ||
							k === "draft_revision_id" ||
							k === "locale" ||
							k === "translation_group"
						) {
							continue;
						}
						// JSON-shaped columns come back as strings; parse so
						// the validator sees the structure it expects.
						if (typeof v === "string" && (v.startsWith("[") || v.startsWith("{"))) {
							try {
								data[k] = JSON.parse(v);
								continue;
							} catch {
								// Fall through -- treat as plain string.
							}
						}
						data[k] = v;
					}

					const result = await validateContentData(db, slug, data, { partial: true });
					if (!("ok" in result) || !result.ok) {
						const message = result.ok ? "(unexpected)" : result.error.message;
						throw new Error(
							`${rel}: row in ${tableName} (slug=${row.slug as string}) failed validation: ${message}`,
						);
					}
				}
			}
		});
	}
});
