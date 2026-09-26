import { afterEach, beforeEach, expect, it } from "vitest";

import type { EmDashRuntime } from "../../../src/emdash-runtime.js";
import { setI18nConfig } from "../../../src/i18n/config.js";
import { BlockTypeRegistry } from "../../../src/schema/block-type-registry.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import { createTestRuntime } from "../../utils/mcp-runtime.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

describeEachDialect("blocks content semantics", (dialect) => {
	let ctx: DialectTestContext;
	let runtime: EmDashRuntime;
	let blocks: BlockTypeRegistry;
	let schema: SchemaRegistry;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
		blocks = new BlockTypeRegistry(ctx.db);
		schema = new SchemaRegistry(ctx.db);
		await blocks.createBlockType({
			slug: "hero",
			label: "Hero",
			fields: [
				{ slug: "heading", label: "Heading", type: "string", required: true },
				{
					slug: "alignment",
					label: "Alignment",
					type: "select",
					defaultValue: "start",
					validation: { options: ["start", "center"] },
				},
			],
		});
		await blocks.createBlockType({
			slug: "banner",
			label: "Banner",
			fields: [{ slug: "text", label: "Text", type: "string", required: true }],
		});
		await schema.createCollection({ slug: "pages", label: "Pages" });
		await schema.createField("pages", {
			slug: "layout",
			label: "Layout",
			type: "blocks",
			validation: { allowedTypes: ["hero"], maxItems: 5 },
		});
		runtime = createTestRuntime(ctx.db);
	});

	afterEach(async () => {
		setI18nConfig(null);
		await teardownForDialect(ctx);
	});

	it("assigns keys, active versions, and defaults on create", async () => {
		const result = await runtime.handleContentCreate("pages", {
			slug: "home",
			data: { layout: [{ _type: "hero", heading: "Hello" }] },
		});

		expect(result.success).toBe(true);
		if (!result.success) return;
		expect(result.data.item.data.layout).toEqual([
			expect.objectContaining({
				_type: "hero",
				_version: 1,
				_key: expect.stringMatching(/^[0-9A-Z]{26}$/),
				heading: "Hello",
				alignment: "start",
			}),
		]);
	});

	it("writes the empty default when omitted and enforces a positive minimum", async () => {
		const empty = await runtime.handleContentCreate("pages", {
			slug: "empty",
			data: {},
		});
		expect(empty.success).toBe(true);
		if (empty.success) expect(empty.data.item.data.layout).toEqual([]);

		await schema.createCollection({ slug: "landing_pages", label: "Landing pages" });
		await schema.createField("landing_pages", {
			slug: "layout",
			label: "Layout",
			type: "blocks",
			validation: { allowedTypes: ["hero"], minItems: 1 },
		});
		const missing = await runtime.handleContentCreate("landing_pages", {
			slug: "missing",
			data: {},
		});
		expect(missing).toMatchObject({ success: false, error: { code: "VALIDATION_ERROR" } });
	});

	it("rejects undeclared values, disallowed types, duplicate keys, and inactive versions", async () => {
		for (const layout of [
			[{ _type: "hero", heading: "" }],
			[{ _type: "hero", heading: "Hello", extra: true }],
			[{ _type: "banner", text: "No" }],
			[
				{ _type: "hero", _key: "same", heading: "One" },
				{ _type: "hero", _key: "same", heading: "Two" },
			],
			[{ _type: "hero", _version: 2, heading: "Future" }],
		]) {
			const result = await runtime.handleContentCreate("pages", {
				slug: `invalid-${Math.random()}`,
				data: { layout },
			});
			expect(result).toMatchObject({ success: false, error: { code: "VALIDATION_ERROR" } });
		}
	});

	it("preserves identity and requires explicit intent for keyless replacement", async () => {
		const created = await runtime.handleContentCreate("pages", {
			slug: "home",
			data: { layout: [{ _type: "hero", heading: "Before" }] },
		});
		expect(created.success).toBe(true);
		if (!created.success) return;
		const original = (created.data.item.data.layout as Array<Record<string, unknown>>)[0]!;

		const keyless = await runtime.handleContentUpdate("pages", created.data.item.id, {
			data: { layout: [{ _type: "hero", heading: "After" }] },
		});
		expect(keyless).toMatchObject({ success: false, error: { code: "VALIDATION_ERROR" } });

		const replaced = await runtime.handleContentUpdate("pages", created.data.item.id, {
			data: { layout: [{ _type: "hero", heading: "After" }] },
			replaceBlocks: true,
		});
		expect(replaced.success).toBe(true);
		if (!replaced.success) return;
		const replacement = (replaced.data.item.data.layout as Array<Record<string, unknown>>)[0]!;
		expect(replacement._key).not.toBe(original._key);
		expect(replacement).toMatchObject({ _type: "hero", _version: 1, heading: "After" });
	});

	it("normalizes blocks for collections without draft revisions", async () => {
		await schema.createCollection({ slug: "plain_pages", label: "Plain pages", supports: [] });
		await schema.createField("plain_pages", {
			slug: "layout",
			label: "Layout",
			type: "blocks",
			validation: { allowedTypes: ["hero"] },
		});
		const created = await runtime.handleContentCreate("plain_pages", {
			slug: "home",
			data: { layout: [{ _type: "hero", heading: "Before" }] },
		});
		expect(created.success).toBe(true);
		if (!created.success) return;
		const block = (created.data.item.data.layout as Array<Record<string, unknown>>)[0]!;

		const updated = await runtime.handleContentUpdate("plain_pages", created.data.item.id, {
			data: { layout: [{ ...block, heading: "After" }] },
		});
		expect(updated.success).toBe(true);
		if (updated.success) {
			expect(updated.data.item.data.layout).toEqual([
				expect.objectContaining({ _key: block._key, _version: 1, heading: "After" }),
			]);
		}
	});

	it("rejects a stale revision before it can replace newer nested block data", async () => {
		const created = await runtime.handleContentCreate("pages", {
			slug: "home",
			data: { layout: [{ _type: "hero", heading: "Original" }] },
		});
		expect(created.success).toBe(true);
		if (!created.success) return;
		const block = (created.data.item.data.layout as Array<Record<string, unknown>>)[0]!;
		const first = await runtime.handleContentUpdate("pages", created.data.item.id, {
			_rev: created.data._rev,
			data: { layout: [{ ...block, heading: "Newer" }] },
		});
		expect(first.success).toBe(true);

		const stale = await runtime.handleContentUpdate("pages", created.data.item.id, {
			_rev: created.data._rev,
			data: { layout: [{ ...block, heading: "Stale" }] },
		});
		expect(stale).toMatchObject({ success: false, error: { code: "CONFLICT" } });
		const read = await runtime.handleContentGet("pages", created.data.item.id);
		expect(read.success).toBe(true);
		if (read.success) {
			expect(read.data.item.data.layout).toEqual([
				expect.objectContaining({ _key: block._key, heading: "Newer" }),
			]);
		}
	});

	it("keeps retired blocks editable but prevents adding new ones", async () => {
		const created = await runtime.handleContentCreate("pages", {
			slug: "home",
			data: { layout: [{ _type: "hero", heading: "Before" }] },
		});
		expect(created.success).toBe(true);
		if (!created.success) return;
		const original = (created.data.item.data.layout as Array<Record<string, unknown>>)[0]!;
		await schema.updateField("pages", "layout", { validation: { allowedTypes: ["banner"] } });

		const edited = await runtime.handleContentUpdate("pages", created.data.item.id, {
			data: { layout: [{ ...original, heading: "After" }] },
		});
		expect(edited.success).toBe(true);
		const added = await runtime.handleContentUpdate("pages", created.data.item.id, {
			data: {
				layout: [
					{ ...original, heading: "After" },
					{ _type: "hero", heading: "New retired block" },
				],
			},
		});
		expect(added).toMatchObject({ success: false, error: { code: "VALIDATION_ERROR" } });
	});

	it("requires migration intent and the active target version", async () => {
		const created = await runtime.handleContentCreate("pages", {
			slug: "home",
			data: { layout: [{ _type: "hero", heading: "Before" }] },
		});
		expect(created.success).toBe(true);
		if (!created.success) return;
		const original = (created.data.item.data.layout as Array<Record<string, unknown>>)[0]!;
		const type = await blocks.getBlockType("hero");
		const versioned = await blocks.updateBlockType("hero", {
			expectedFingerprint: type!.versions[0]!.fingerprint,
			fields: [{ slug: "title", label: "Title", type: "string", required: true }],
			breaking: true,
		});

		const inactive = await runtime.handleContentUpdate("pages", created.data.item.id, {
			data: { layout: [{ ...original, _version: 2, title: "New" }] },
			migrateBlocks: true,
		});
		expect(inactive).toMatchObject({ success: false, error: { code: "VALIDATION_ERROR" } });

		await blocks.activateVersion("hero", 2, versioned.versions[0]!.fingerprint);
		const withoutIntent = await runtime.handleContentUpdate("pages", created.data.item.id, {
			data: { layout: [{ ...original, _version: 2, title: "New" }] },
		});
		expect(withoutIntent).toMatchObject({ success: false, error: { code: "VALIDATION_ERROR" } });

		const migrated = await runtime.handleContentUpdate("pages", created.data.item.id, {
			data: { layout: [{ _type: "hero", _version: 2, _key: original._key, title: "New" }] },
			migrateBlocks: true,
		});
		expect(migrated.success).toBe(true);
		if (migrated.success) {
			expect(migrated.data.item.data.layout).toEqual([
				expect.objectContaining({ _type: "hero", _version: 2, _key: original._key, title: "New" }),
			]);
		}
	});

	it("preserves block keys and versions when duplicating and translating an entry", async () => {
		setI18nConfig({ defaultLocale: "en", locales: ["en", "fr"] });
		const created = await runtime.handleContentCreate("pages", {
			slug: "home",
			locale: "en",
			data: { layout: [{ _type: "hero", heading: "Hello" }] },
		});
		expect(created.success).toBe(true);
		if (!created.success) return;
		const layout = created.data.item.data.layout;

		const duplicated = await runtime.handleContentDuplicate("pages", created.data.item.id);
		expect(duplicated.success).toBe(true);
		if (duplicated.success) expect(duplicated.data.item.data.layout).toEqual(layout);

		const translated = await runtime.handleContentCreate("pages", {
			slug: "accueil",
			locale: "fr",
			translationOf: created.data.item.id,
			data: { layout },
		});
		expect(translated.success).toBe(true);
		if (translated.success) expect(translated.data.item.data.layout).toEqual(layout);
	});

	it("preserves block identity through publish and revision restore", async () => {
		const created = await runtime.handleContentCreate("pages", {
			slug: "revision-page",
			data: { layout: [{ _type: "hero", heading: "First" }] },
		});
		expect(created.success).toBe(true);
		if (!created.success) return;
		const original = (created.data.item.data.layout as Array<Record<string, unknown>>)[0]!;

		const firstPublish = await runtime.handleContentPublish("pages", created.data.item.id);
		expect(firstPublish.success).toBe(true);
		if (!firstPublish.success) return;
		const firstRevisionId = firstPublish.data.item.liveRevisionId;
		expect(firstRevisionId).toBeTruthy();

		const edited = await runtime.handleContentUpdate("pages", created.data.item.id, {
			data: { layout: [{ ...original, heading: "Second" }] },
		});
		expect(edited.success).toBe(true);
		const secondPublish = await runtime.handleContentPublish("pages", created.data.item.id);
		expect(secondPublish.success).toBe(true);

		const restored = await runtime.handleRevisionRestore(firstRevisionId!, "restore-author");
		expect(restored.success).toBe(true);
		if (!restored.success) return;
		expect(restored.data.item.data.layout).toEqual([
			expect.objectContaining({
				_type: "hero",
				_version: 1,
				_key: original._key,
				heading: "First",
			}),
		]);

		const republished = await runtime.handleContentPublish("pages", created.data.item.id);
		expect(republished.success).toBe(true);
		if (republished.success) {
			expect(republished.data.item.data.layout).toEqual([
				expect.objectContaining({ _key: original._key, _version: 1, heading: "First" }),
			]);
		}
	});
});
