import { ulid } from "ulidx";
import { afterEach, beforeEach, expect } from "vitest";

import type { EmDashRuntime } from "../../../src/emdash-runtime.js";
import { createMediaProvider } from "../../../src/media/local-runtime.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import { createTestRuntime } from "../../utils/mcp-runtime.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

describeEachDialect("image field dark variant normalization", (dialect) => {
	let ctx: DialectTestContext;
	let runtime: EmDashRuntime;
	let lightId: string;
	let darkId: string;

	async function insertMedia(id: string, filename: string) {
		await ctx.db
			.insertInto("media")
			.values({
				id,
				filename,
				mime_type: "image/png",
				size: 100,
				width: 1200,
				height: 600,
				alt: null,
				caption: null,
				storage_key: filename,
				content_hash: null,
				blurhash: null,
				dominant_color: null,
				status: "ready",
				author_id: null,
			})
			.execute();
	}

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
		const registry = new SchemaRegistry(ctx.db);
		await registry.createCollection({ slug: "posts", label: "Posts" });
		await registry.createField("posts", { slug: "title", label: "Title", type: "string" });
		await registry.createField("posts", {
			slug: "hero",
			label: "Hero",
			type: "image",
			options: { darkVariant: true },
		});

		lightId = ulid();
		darkId = ulid();
		await insertMedia(lightId, "hero-light.png");
		await insertMedia(darkId, "hero-dark.png");

		await registry.createField("posts", {
			slug: "attachment",
			label: "Attachment",
			type: "file",
		});

		runtime = createTestRuntime(ctx.db);
		runtime.mediaProviders.set("local", createMediaProvider({ db: ctx.db }));
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	it("keeps the dark variant on save and normalizes it like the primary image", async () => {
		const result = await runtime.handleContentCreate("posts", {
			slug: "p1",
			data: {
				title: "p1",
				hero: { id: lightId, provider: "local", darkVariant: { id: darkId, provider: "local" } },
			},
		});
		expect(result.success).toBe(true);
		if (!result.success) return;

		const hero = (result.data.item.data as Record<string, unknown>).hero as Record<string, unknown>;
		const darkVariant = hero.darkVariant as Record<string, unknown>;

		expect(hero.id).toBe(lightId);
		expect(hero.meta).toMatchObject({ storageKey: "hero-light.png" });
		expect(hero.width).toBe(1200);

		expect(darkVariant.id).toBe(darkId);
		expect(darkVariant.meta).toMatchObject({ storageKey: "hero-dark.png" });
		expect(darkVariant.width).toBe(1200);
		expect(darkVariant.filename).toBe("hero-dark.png");
	});

	it("accepts a bare media id as the dark variant", async () => {
		const result = await runtime.handleContentCreate("posts", {
			slug: "p2",
			data: { title: "p2", hero: { id: lightId, provider: "local", darkVariant: darkId } },
		});
		expect(result.success).toBe(true);
		if (!result.success) return;

		const hero = (result.data.item.data as Record<string, unknown>).hero as Record<string, unknown>;
		expect(hero.darkVariant).toMatchObject({ id: darkId, provider: "local" });
	});

	it("resolves a legacy string primary that was upgraded to carry a variant", async () => {
		const result = await runtime.handleContentCreate("posts", {
			slug: "p4",
			data: {
				title: "p4",
				hero: {
					id: "",
					src: "https://cdn.example.com/legacy.png",
					darkVariant: { id: darkId, provider: "local" },
				},
			},
		});
		expect(result.success).toBe(true);
		if (!result.success) return;

		const hero = (result.data.item.data as Record<string, unknown>).hero as Record<string, unknown>;
		expect(hero.provider).toBe("external");
		expect(hero.src).toBe("https://cdn.example.com/legacy.png");
		expect(hero.darkVariant).toMatchObject({ id: darkId, provider: "local" });
	});

	it("keeps the provider linkage of an upgraded legacy local id", async () => {
		const result = await runtime.handleContentCreate("posts", {
			slug: "p5",
			data: {
				title: "p5",
				hero: { id: "", src: lightId, darkVariant: { id: darkId, provider: "local" } },
			},
		});
		expect(result.success).toBe(true);
		if (!result.success) return;

		const hero = (result.data.item.data as Record<string, unknown>).hero as Record<string, unknown>;
		expect(hero).toMatchObject({ id: lightId, provider: "local", filename: "hero-light.png" });
		expect(hero.darkVariant).toMatchObject({ id: darkId, provider: "local" });
	});

	it("keeps an upgraded legacy string primary that carries no variant", async () => {
		const created = await runtime.handleContentCreate("posts", {
			slug: "p7",
			data: {
				title: "p7",
				hero: {
					id: "",
					src: "https://cdn.example.com/legacy.png",
					darkVariant: { id: darkId, provider: "local" },
				},
			},
		});
		expect(created.success).toBe(true);
		if (!created.success) return;

		const updated = await runtime.handleContentUpdate("posts", created.data.item.id, {
			data: { hero: { id: "", src: "https://cdn.example.com/legacy.png" } },
		});
		expect(updated.success).toBe(true);
		if (!updated.success) return;

		const hero = (updated.data.item.data as Record<string, unknown>).hero as Record<
			string,
			unknown
		>;
		expect(hero.provider).toBe("external");
		expect(hero.src).toBe("https://cdn.example.com/legacy.png");
		expect(hero.darkVariant).toBeUndefined();
	});

	it("keeps the provider linkage of an upgraded legacy local id that carries no variant", async () => {
		const result = await runtime.handleContentCreate("posts", {
			slug: "p8",
			data: { title: "p8", hero: { id: "", src: lightId } },
		});
		expect(result.success).toBe(true);
		if (!result.success) return;

		const hero = (result.data.item.data as Record<string, unknown>).hero as Record<string, unknown>;
		expect(hero).toMatchObject({ id: lightId, provider: "local", filename: "hero-light.png" });
	});

	it("does not apply dark variant handling to file fields", async () => {
		const result = await runtime.handleContentCreate("posts", {
			slug: "p6",
			data: {
				title: "p6",
				attachment: {
					id: lightId,
					provider: "local",
					darkVariant: { id: darkId, provider: "local" },
				},
			},
		});
		expect(result.success).toBe(true);
		if (!result.success) return;

		const attachment = (result.data.item.data as Record<string, unknown>).attachment as Record<
			string,
			unknown
		>;
		expect(attachment.id).toBe(lightId);
		expect(attachment.darkVariant).toBeUndefined();
	});

	it("removes the dark variant when an update clears it", async () => {
		const created = await runtime.handleContentCreate("posts", {
			slug: "p3",
			data: {
				title: "p3",
				hero: { id: lightId, provider: "local", darkVariant: { id: darkId, provider: "local" } },
			},
		});
		expect(created.success).toBe(true);
		if (!created.success) return;

		const updated = await runtime.handleContentUpdate("posts", created.data.item.id, {
			data: { hero: { id: lightId, provider: "local" } },
		});
		expect(updated.success).toBe(true);
		if (!updated.success) return;

		const hero = (updated.data.item.data as Record<string, unknown>).hero as Record<
			string,
			unknown
		>;
		expect(hero.darkVariant).toBeUndefined();
	});
});
