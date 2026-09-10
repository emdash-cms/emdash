/**
 * Chrome write routes (settings, menus, taxonomies, widget-areas) must purge
 * their Workers edge-cache tags after a successful mutation.
 */

import { Role } from "@emdash-cms/auth";
import { ulid } from "ulidx";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { handleMenuCreate, handleMenuItemCreate } from "../../../src/api/handlers/menus.js";
import { handleTaxonomyCreate, handleTermCreate } from "../../../src/api/handlers/taxonomies.js";
import {
	DELETE as deleteMenu,
	PUT as putMenu,
} from "../../../src/astro/routes/api/menus/[name].js";
import { POST as postMenuItem } from "../../../src/astro/routes/api/menus/[name]/items.js";
import {
	DELETE as deleteMenuItem,
	PUT as putMenuItem,
} from "../../../src/astro/routes/api/menus/[name]/items/[id].js";
import { POST as reorderMenuItems } from "../../../src/astro/routes/api/menus/[name]/reorder.js";
import { POST as postMenus } from "../../../src/astro/routes/api/menus/index.js";
import { POST as postSettings } from "../../../src/astro/routes/api/settings.js";
import {
	DELETE as deleteTaxonomy,
	PUT as putTaxonomy,
} from "../../../src/astro/routes/api/taxonomies/[name].js";
import { POST as reorderTerms } from "../../../src/astro/routes/api/taxonomies/[name]/reorder.js";
import {
	DELETE as deleteTerm,
	PUT as putTerm,
} from "../../../src/astro/routes/api/taxonomies/[name]/terms/[slug].js";
import { POST as postTerms } from "../../../src/astro/routes/api/taxonomies/[name]/terms/index.js";
import { POST as postTaxonomies } from "../../../src/astro/routes/api/taxonomies/index.js";
import { DELETE as deleteWidgetArea } from "../../../src/astro/routes/api/widget-areas/[name].js";
import { POST as reorderWidgets } from "../../../src/astro/routes/api/widget-areas/[name]/reorder.js";
import { POST as postWidgets } from "../../../src/astro/routes/api/widget-areas/[name]/widgets.js";
import {
	DELETE as deleteWidget,
	PUT as putWidget,
} from "../../../src/astro/routes/api/widget-areas/[name]/widgets/[id].js";
import { POST as postWidgetAreas } from "../../../src/astro/routes/api/widget-areas/index.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

describe("Chrome write routes — edge cache invalidation", () => {
	let db: Awaited<ReturnType<typeof setupTestDatabase>>;

	const admin = { id: "user-1", role: Role.ADMIN };

	function makeContext<const P extends Record<string, string>>(params: P) {
		const invalidate = vi.fn().mockResolvedValue(undefined);
		return {
			locals: { emdash: { db, storage: null }, user: admin },
			params,
			cache: { enabled: true, invalidate },
			invalidate,
		};
	}

	async function makeRequest(method: string, body: unknown, url = "http://localhost/") {
		return new Request(url, {
			method,
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
	}

	beforeEach(async () => {
		db = await setupTestDatabase();
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	describe("settings", () => {
		it("invalidates emdash:settings on update", async () => {
			const { cache, invalidate } = makeContext({});
			const request = await makeRequest("POST", { title: "New title" });

			const response = await postSettings({
				request,
				locals: { emdash: { db, storage: null }, user: admin },
				cache,
			} as Parameters<typeof postSettings>[0]);

			expect(response.status).toBe(200);
			expect(invalidate).toHaveBeenCalledTimes(1);
			expect(invalidate).toHaveBeenCalledWith({ tags: ["emdash:settings"] });
		});
	});

	describe("menus", () => {
		async function menuFixture() {
			const created = await handleMenuCreate(db, { name: "primary", label: "Primary" });
			expect(created.success).toBe(true);
			const item = await handleMenuItemCreate(db, "primary", {
				type: "custom",
				label: "Home",
				customUrl: "/",
			});
			expect(item.success).toBe(true);
			return {
				menuId: created.success ? created.data.id : "",
				itemId: item.success ? item.data.id : "",
			};
		}

		it("invalidates on create", async () => {
			const { invalidate } = makeContext({});
			const request = await makeRequest("POST", { name: "primary", label: "Primary" });

			const response = await postMenus({
				request,
				locals: { emdash: { db, storage: null }, user: admin },
				cache: { enabled: true, invalidate },
			} as Parameters<typeof postMenus>[0]);

			expect(response.status).toBe(201);
			expect(invalidate).toHaveBeenCalledWith({ tags: ["emdash:menu:primary"] });
		});

		it("invalidates on update", async () => {
			await menuFixture();
			const { cache, invalidate } = makeContext({ name: "primary" });
			const request = await makeRequest("PUT", { label: "Updated" }, "http://localhost/");

			const response = await putMenu({
				request,
				params: { name: "primary" },
				url: new URL(request.url),
				locals: { emdash: { db, storage: null }, user: admin },
				cache,
			} as Parameters<typeof putMenu>[0]);

			expect(response.status).toBe(200);
			expect(invalidate).toHaveBeenCalledWith({ tags: ["emdash:menu:primary"] });
		});

		it("invalidates on item create", async () => {
			await menuFixture();
			const { cache, invalidate } = makeContext({ name: "primary" });
			const request = await makeRequest("POST", {
				type: "custom",
				label: "Blog",
				customUrl: "/blog",
			});

			const response = await postMenuItem({
				request,
				params: { name: "primary" },
				url: new URL(request.url),
				locals: { emdash: { db, storage: null }, user: admin },
				cache,
			} as Parameters<typeof postMenuItem>[0]);

			expect(response.status).toBe(201);
			expect(invalidate).toHaveBeenCalledWith({ tags: ["emdash:menu:primary"] });
		});

		it("invalidates on item update", async () => {
			const { itemId } = await menuFixture();
			const { cache, invalidate } = makeContext({ name: "primary", id: itemId });
			const request = await makeRequest("PUT", { label: "Updated" });

			const response = await putMenuItem({
				request,
				params: { name: "primary", id: itemId },
				url: new URL(request.url),
				locals: { emdash: { db, storage: null }, user: admin },
				cache,
			} as Parameters<typeof putMenuItem>[0]);

			expect(response.status).toBe(200);
			expect(invalidate).toHaveBeenCalledWith({ tags: ["emdash:menu:primary"] });
		});

		it("invalidates on item reorder", async () => {
			const { itemId } = await menuFixture();
			const { cache, invalidate } = makeContext({ name: "primary" });
			const request = await makeRequest("POST", {
				items: [{ id: itemId, parentId: null, sortOrder: 0 }],
			});

			const response = await reorderMenuItems({
				request,
				params: { name: "primary" },
				url: new URL(request.url),
				locals: { emdash: { db, storage: null }, user: admin },
				cache,
			} as Parameters<typeof reorderMenuItems>[0]);

			expect(response.status).toBe(200);
			expect(invalidate).toHaveBeenCalledWith({ tags: ["emdash:menu:primary"] });
		});

		it("invalidates on item delete", async () => {
			const { itemId } = await menuFixture();
			const { cache, invalidate } = makeContext({ name: "primary", id: itemId });
			const request = await makeRequest("DELETE", {});

			const response = await deleteMenuItem({
				request,
				params: { name: "primary", id: itemId },
				url: new URL(request.url),
				locals: { emdash: { db, storage: null }, user: admin },
				cache,
			} as Parameters<typeof deleteMenuItem>[0]);

			expect(response.status).toBe(200);
			expect(invalidate).toHaveBeenCalledWith({ tags: ["emdash:menu:primary"] });
		});

		it("invalidates on menu delete", async () => {
			await menuFixture();
			const { cache, invalidate } = makeContext({ name: "primary" });
			const request = await makeRequest("DELETE", {});

			const response = await deleteMenu({
				request,
				params: { name: "primary" },
				url: new URL(request.url),
				locals: { emdash: { db, storage: null }, user: admin },
				cache,
			} as Parameters<typeof deleteMenu>[0]);

			expect(response.status).toBe(200);
			expect(invalidate).toHaveBeenCalledWith({ tags: ["emdash:menu:primary"] });
		});
	});

	describe("taxonomies", () => {
		async function taxonomyFixture() {
			const created = await handleTaxonomyCreate(db, {
				name: "topics",
				label: "Topics",
				hierarchical: false,
				collections: [],
			});
			expect(created.success).toBe(true);
			return { taxonomyName: "topics" };
		}

		async function termFixture() {
			await taxonomyFixture();
			const term = await handleTermCreate(db, "topics", { slug: "news", label: "News" });
			expect(term.success).toBe(true);
			return {
				slug: term.success ? term.data.term.slug : "news",
				id: term.success ? term.data.term.id : "",
			};
		}

		it("invalidates on create", async () => {
			const { cache, invalidate } = makeContext({});
			const request = await makeRequest("POST", {
				name: "topics",
				label: "Topics",
				hierarchical: false,
				collections: [],
			});

			const response = await postTaxonomies({
				request,
				locals: { emdash: { db, storage: null }, user: admin },
				cache,
			} as Parameters<typeof postTaxonomies>[0]);

			expect(response.status).toBe(201);
			expect(invalidate).toHaveBeenCalledWith({ tags: ["emdash:taxonomy:topics"] });
		});

		it("invalidates on update", async () => {
			await taxonomyFixture();
			const { cache, invalidate } = makeContext({ name: "topics" });
			const request = await makeRequest("PUT", { label: "Updated" });

			const response = await putTaxonomy({
				request,
				params: { name: "topics" },
				url: new URL(request.url),
				locals: { emdash: { db, storage: null }, user: admin },
				cache,
			} as Parameters<typeof putTaxonomy>[0]);

			expect(response.status).toBe(200);
			expect(invalidate).toHaveBeenCalledWith({ tags: ["emdash:taxonomy:topics"] });
		});

		it("invalidates on term create", async () => {
			await taxonomyFixture();
			const { cache, invalidate } = makeContext({ name: "topics" });
			const request = await makeRequest("POST", { slug: "news", label: "News" });

			const response = await postTerms({
				request,
				params: { name: "topics" },
				url: new URL(request.url),
				locals: { emdash: { db, storage: null }, user: admin },
				cache,
			} as Parameters<typeof postTerms>[0]);

			expect(response.status).toBe(201);
			expect(invalidate).toHaveBeenCalledWith({ tags: ["emdash:taxonomy:topics"] });
		});

		it("invalidates on term update", async () => {
			const { slug } = await termFixture();
			const { cache, invalidate } = makeContext({ name: "topics", slug });
			const request = await makeRequest("PUT", { label: "Updated" });

			const response = await putTerm({
				request,
				params: { name: "topics", slug },
				url: new URL(request.url),
				locals: { emdash: { db, storage: null }, user: admin },
				cache,
			} as Parameters<typeof putTerm>[0]);

			expect(response.status).toBe(200);
			expect(invalidate).toHaveBeenCalledWith({ tags: ["emdash:taxonomy:topics"] });
		});

		it("invalidates on term reorder", async () => {
			const { id } = await termFixture();
			const { cache, invalidate } = makeContext({ name: "topics" });
			const request = await makeRequest("POST", { ids: [id] });

			const response = await reorderTerms({
				request,
				params: { name: "topics" },
				url: new URL(request.url),
				locals: { emdash: { db, storage: null }, user: admin },
				cache,
			} as Parameters<typeof reorderTerms>[0]);

			expect(response.status).toBe(200);
			expect(invalidate).toHaveBeenCalledWith({ tags: ["emdash:taxonomy:topics"] });
		});

		it("invalidates on term delete", async () => {
			const { slug } = await termFixture();
			const { cache, invalidate } = makeContext({ name: "topics", slug });
			const request = await makeRequest("DELETE", {});

			const response = await deleteTerm({
				request,
				params: { name: "topics", slug },
				url: new URL(request.url),
				locals: { emdash: { db, storage: null }, user: admin },
				cache,
			} as Parameters<typeof deleteTerm>[0]);

			expect(response.status).toBe(200);
			expect(invalidate).toHaveBeenCalledWith({ tags: ["emdash:taxonomy:topics"] });
		});

		it("invalidates on taxonomy delete", async () => {
			await taxonomyFixture();
			const { cache, invalidate } = makeContext({ name: "topics" });
			const request = await makeRequest("DELETE", {});

			const response = await deleteTaxonomy({
				request,
				params: { name: "topics" },
				url: new URL(request.url),
				locals: { emdash: { db, storage: null }, user: admin },
				cache,
			} as Parameters<typeof deleteTaxonomy>[0]);

			expect(response.status).toBe(200);
			expect(invalidate).toHaveBeenCalledWith({ tags: ["emdash:taxonomy:topics"] });
		});
	});

	describe("widget areas", () => {
		async function widgetAreaFixture() {
			const areaId = ulid();
			await db
				.insertInto("_emdash_widget_areas")
				.values({ id: areaId, name: "sidebar", label: "Sidebar" })
				.execute();
			const widgetId = ulid();
			await db
				.insertInto("_emdash_widgets")
				.values({ id: widgetId, area_id: areaId, type: "content", sort_order: 0 })
				.execute();
			return { areaId, widgetId };
		}

		it("invalidates on create", async () => {
			const { cache, invalidate } = makeContext({});
			const request = await makeRequest("POST", { name: "sidebar", label: "Sidebar" });

			const response = await postWidgetAreas({
				request,
				locals: { emdash: { db, storage: null }, user: admin },
				cache,
			} as Parameters<typeof postWidgetAreas>[0]);

			expect(response.status).toBe(201);
			expect(invalidate).toHaveBeenCalledWith({ tags: ["emdash:widget-area:sidebar"] });
		});

		it("invalidates on widget create", async () => {
			await widgetAreaFixture();
			const { cache, invalidate } = makeContext({ name: "sidebar" });
			const request = await makeRequest("POST", { type: "content", title: "Hello" });

			const response = await postWidgets({
				request,
				params: { name: "sidebar" },
				url: new URL(request.url),
				locals: { emdash: { db, storage: null }, user: admin },
				cache,
			} as Parameters<typeof postWidgets>[0]);

			expect(response.status).toBe(201);
			expect(invalidate).toHaveBeenCalledWith({ tags: ["emdash:widget-area:sidebar"] });
		});

		it("invalidates on widget update", async () => {
			const { widgetId } = await widgetAreaFixture();
			const { cache, invalidate } = makeContext({ name: "sidebar", id: widgetId });
			const request = await makeRequest("PUT", { title: "Updated" });

			const response = await putWidget({
				request,
				params: { name: "sidebar", id: widgetId },
				url: new URL(request.url),
				locals: { emdash: { db, storage: null }, user: admin },
				cache,
			} as Parameters<typeof putWidget>[0]);

			expect(response.status).toBe(200);
			expect(invalidate).toHaveBeenCalledWith({ tags: ["emdash:widget-area:sidebar"] });
		});

		it("invalidates on widget reorder", async () => {
			const { widgetId } = await widgetAreaFixture();
			const { cache, invalidate } = makeContext({ name: "sidebar" });
			const request = await makeRequest("POST", { widgetIds: [widgetId] });

			const response = await reorderWidgets({
				request,
				params: { name: "sidebar" },
				url: new URL(request.url),
				locals: { emdash: { db, storage: null }, user: admin },
				cache,
			} as Parameters<typeof reorderWidgets>[0]);

			expect(response.status).toBe(200);
			expect(invalidate).toHaveBeenCalledWith({ tags: ["emdash:widget-area:sidebar"] });
		});

		it("invalidates on widget delete", async () => {
			const { widgetId } = await widgetAreaFixture();
			const { cache, invalidate } = makeContext({ name: "sidebar", id: widgetId });
			const request = await makeRequest("DELETE", {});

			const response = await deleteWidget({
				request,
				params: { name: "sidebar", id: widgetId },
				url: new URL(request.url),
				locals: { emdash: { db, storage: null }, user: admin },
				cache,
			} as Parameters<typeof deleteWidget>[0]);

			expect(response.status).toBe(200);
			expect(invalidate).toHaveBeenCalledWith({ tags: ["emdash:widget-area:sidebar"] });
		});

		it("invalidates on widget area delete", async () => {
			await widgetAreaFixture();
			const { cache, invalidate } = makeContext({ name: "sidebar" });
			const request = await makeRequest("DELETE", {});

			const response = await deleteWidgetArea({
				request,
				params: { name: "sidebar" },
				url: new URL(request.url),
				locals: { emdash: { db, storage: null }, user: admin },
				cache,
			} as Parameters<typeof deleteWidgetArea>[0]);

			expect(response.status).toBe(200);
			expect(invalidate).toHaveBeenCalledWith({ tags: ["emdash:widget-area:sidebar"] });
		});
	});
});
