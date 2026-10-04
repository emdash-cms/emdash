import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { exportSeed } from "../../../src/cli/commands/export-seed.js";
import { ContentRepository } from "../../../src/database/repositories/content.js";
import type { Database } from "../../../src/database/types.js";
import { BlockTypeRegistry } from "../../../src/schema/block-type-registry.js";
import { applySeed } from "../../../src/seed/apply.js";
import type { SeedFile } from "../../../src/seed/types.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

const seed: SeedFile = {
	version: "1",
	blockTypes: [
		{
			slug: "hero",
			label: "Hero",
			currentVersion: 2,
			versions: [
				{
					version: 1,
					fields: [{ slug: "heading", label: "Heading", type: "string", required: true }],
				},
				{
					version: 2,
					fields: [{ slug: "title", label: "Title", type: "string", required: true }],
				},
			],
		},
	],
	collections: [
		{
			slug: "pages",
			label: "Pages",
			fields: [
				{
					slug: "layout",
					label: "Layout",
					type: "blocks",
					validation: { allowedTypes: ["hero"] },
				},
			],
		},
	],
	content: {
		pages: [
			{
				id: "page-home",
				slug: "home",
				status: "draft",
				data: {
					layout: [
						{
							_type: "hero",
							_version: 1,
							_key: "01K5AB3F7M9QZ2X8W4V6T1R0YH",
							heading: "Historical",
						},
					],
				},
			},
		],
	},
};

describe("blocks seed round trip", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		db = await setupTestDatabase();
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	it("preserves exact versions, active pointer, and stored block identity", async () => {
		const result = await applySeed(db, seed, { includeContent: true });

		expect(result.blockTypes).toEqual({ created: 1, skipped: 0, updated: 0 });
		const type = await new BlockTypeRegistry(db).getBlockType("hero");
		expect(type?.currentVersion).toBe(2);
		expect(type?.versions.map((version) => version.version)).toEqual([1, 2]);
		const page = await new ContentRepository(db).findBySlug("pages", "home", "en");
		expect(page?.data.layout).toEqual(seed.content?.pages?.[0]?.data.layout);

		const exported = await exportSeed(db, "all");
		expect(exported.blockTypes).toEqual(seed.blockTypes);
		expect(exported.content?.pages?.[0]?.data.layout).toEqual(
			seed.content?.pages?.[0]?.data.layout,
		);

		const restored = await setupTestDatabase();
		try {
			await applySeed(restored, exported, { includeContent: true });
			const restoredType = await new BlockTypeRegistry(restored).getBlockType("hero");
			expect(restoredType?.currentVersion).toBe(2);
			expect(restoredType?.versions.map((version) => version.version)).toEqual([1, 2]);
		} finally {
			await teardownTestDatabase(restored);
		}
	});

	it("is idempotent and rejects incompatible reuse of a stored version", async () => {
		await applySeed(db, seed);
		const rerun = await applySeed(db, seed, { onConflict: "update" });
		expect(rerun.blockTypes).toEqual({ created: 0, skipped: 0, updated: 1 });

		const incompatible = structuredClone(seed);
		incompatible.blockTypes![0]!.versions[0]!.fields = [
			{ slug: "different", label: "Different", type: "string", required: true },
		];
		await expect(applySeed(db, incompatible, { onConflict: "update" })).rejects.toMatchObject({
			code: "BLOCK_TYPE_VERSION_CONFLICT",
		});
	});
});
