import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { handleTaxonomyCreate, handleTermCreate } from "../../../src/api/handlers/taxonomies.js";
import { createTermBody } from "../../../src/api/schemas/taxonomies.js";
import {
	describeEachDialect,
	setupForDialectWithCollections,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

describe("taxonomy term create schema", () => {
	it("allows the server to derive a slug from the label", () => {
		expect(createTermBody.safeParse({ label: "音楽" }).success).toBe(true);
	});
});

describeEachDialect("taxonomy term slug generation", (dialect) => {
	let ctx: DialectTestContext;

	beforeEach(async () => {
		ctx = await setupForDialectWithCollections(dialect);
		const created = await handleTaxonomyCreate(ctx.db, {
			name: "tags",
			label: "Tags",
			collections: ["post"],
		});
		expect(created.success).toBe(true);
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	it.each([
		["مرحبا بالعالم", "مرحبا-بالعالم"],
		["你好世界", "你好世界"],
		["Привет мир", "привет-мир"],
		["שלום עולם", "שלום-עולם"],
		["สวัสดี โลก", "สวัสดี-โลก"],
		["Καλημέρα κόσμε", "καλημέρα-κόσμε"],
		["మేష రాసి", "మేష-రాసి"],
	])("derives a native-script slug for %s", async (label, expected) => {
		const result = await handleTermCreate(ctx.db, "tags", { label });

		expect(result.success).toBe(true);
		if (!result.success) return;
		expect(result.data.term.slug).toBe(expected);
	});

	it("uses a deterministic fallback for emoji-only labels", async () => {
		const result = await handleTermCreate(ctx.db, "tags", { label: "🎵🎵" });

		expect(result.success).toBe(true);
		if (!result.success) return;
		expect(result.data.term.slug).toMatch(/^untitled-[a-z0-9]+$/);
	});

	it("adds a numeric suffix for generated slug collisions", async () => {
		const first = await handleTermCreate(ctx.db, "tags", { label: "音楽", locale: "en" });
		const second = await handleTermCreate(ctx.db, "tags", { label: "音楽", locale: "en" });

		expect(first.success).toBe(true);
		expect(second.success).toBe(true);
		if (!second.success) return;
		expect(second.data.term.slug).toBe("音楽-1");
	});

	it("keeps generated slug uniqueness scoped to the locale", async () => {
		const english = await handleTermCreate(ctx.db, "tags", { label: "音楽", locale: "en" });
		const japanese = await handleTermCreate(ctx.db, "tags", { label: "音楽", locale: "ja" });

		expect(english.success).toBe(true);
		expect(japanese.success).toBe(true);
		if (!english.success || !japanese.success) return;
		expect(english.data.term.slug).toBe("音楽");
		expect(japanese.data.term.slug).toBe("音楽");
	});

	it("still rejects a colliding explicit slug", async () => {
		await handleTermCreate(ctx.db, "tags", { slug: "music", label: "Music" });

		const duplicate = await handleTermCreate(ctx.db, "tags", {
			slug: "music",
			label: "Other music",
		});

		expect(duplicate.success).toBe(false);
		if (duplicate.success) return;
		expect(duplicate.error.code).toBe("CONFLICT");
	});
});
