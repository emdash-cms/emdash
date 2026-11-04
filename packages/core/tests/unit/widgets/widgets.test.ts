import type { Kysely } from "kysely";
import { ulid } from "ulidx";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { createDatabase } from "../../../src/database/connection.js";
import { runMigrations } from "../../../src/database/migrations/runner.js";
import type { Database } from "../../../src/database/types.js";
import { getWidgetComponents } from "../../../src/widgets/components.js";
import type { WidgetType } from "../../../src/widgets/types.js";

// Regex patterns for widget validation
const WIDGET_ID_FORMAT_REGEX = /^[a-z]+:[a-z-]+$/;

describe("Widget System", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		db = createDatabase({ url: ":memory:" });
		await runMigrations(db);
	});

	afterEach(async () => {
		await db.destroy();
	});

	describe("migration", () => {
		it("should create _emdash_widget_areas table", async () => {
			const tables = await db.introspection.getTables();
			const areasTable = tables.find((t) => t.name === "_emdash_widget_areas");
			expect(areasTable).toBeDefined();

			const columns = areasTable!.columns.map((c) => c.name);
			expect(columns).toContain("id");
			expect(columns).toContain("name");
			expect(columns).toContain("label");
			expect(columns).toContain("description");
		});

		it("should create _emdash_widgets table", async () => {
			const tables = await db.introspection.getTables();
			const widgetsTable = tables.find((t) => t.name === "_emdash_widgets");
			expect(widgetsTable).toBeDefined();

			const columns = widgetsTable!.columns.map((c) => c.name);
			expect(columns).toContain("id");
			expect(columns).toContain("area_id");
			expect(columns).toContain("sort_order");
			expect(columns).toContain("type");
			expect(columns).toContain("title");
			expect(columns).toContain("content");
			expect(columns).toContain("menu_name");
			expect(columns).toContain("component_id");
			expect(columns).toContain("component_props");
		});

		it("should enforce unique constraint on widget area name", async () => {
			const id1 = ulid();
			const id2 = ulid();

			await db
				.insertInto("_emdash_widget_areas")
				.values({
					id: id1,
					name: "sidebar",
					label: "Sidebar",
					description: null,
				})
				.execute();

			await expect(
				db
					.insertInto("_emdash_widget_areas")
					.values({
						id: id2,
						name: "sidebar",
						label: "Sidebar Again",
						description: null,
					})
					.execute(),
			).rejects.toThrow();
		});

		it("should cascade delete widgets when area is deleted", async () => {
			const areaId = ulid();
			const widgetId = ulid();

			// Create area
			await db
				.insertInto("_emdash_widget_areas")
				.values({
					id: areaId,
					name: "sidebar",
					label: "Sidebar",
					description: null,
				})
				.execute();

			// Create widget
			await db
				.insertInto("_emdash_widgets")
				.values({
					id: widgetId,
					area_id: areaId,
					sort_order: 0,
					type: "content" as WidgetType,
					title: "Test Widget",
					content: null,
					menu_name: null,
					component_id: null,
					component_props: null,
				})
				.execute();

			// Delete area
			await db.deleteFrom("_emdash_widget_areas").where("id", "=", areaId).execute();

			// Verify widget was deleted
			const widgets = await db
				.selectFrom("_emdash_widgets")
				.where("area_id", "=", areaId)
				.selectAll()
				.execute();

			expect(widgets).toHaveLength(0);
		});
	});

	describe("widget areas", () => {
		it("should create a widget area", async () => {
			const id = ulid();

			await db
				.insertInto("_emdash_widget_areas")
				.values({
					id,
					name: "sidebar",
					label: "Sidebar",
					description: "The main sidebar",
				})
				.execute();

			const area = await db
				.selectFrom("_emdash_widget_areas")
				.selectAll()
				.where("id", "=", id)
				.executeTakeFirst();

			expect(area).not.toBeNull();
			expect(area?.name).toBe("sidebar");
			expect(area?.label).toBe("Sidebar");
			expect(area?.description).toBe("The main sidebar");
		});

		it("should query all widget areas", async () => {
			await db
				.insertInto("_emdash_widget_areas")
				.values([
					{ id: ulid(), name: "sidebar", label: "Sidebar", description: null },
					{ id: ulid(), name: "footer", label: "Footer", description: null },
					{
						id: ulid(),
						name: "header",
						label: "Header Widgets",
						description: null,
					},
				])
				.execute();

			const areas = await db.selectFrom("_emdash_widget_areas").selectAll().execute();

			expect(areas).toHaveLength(3);
		});

		it("should query widget area by name", async () => {
			await db
				.insertInto("_emdash_widget_areas")
				.values({
					id: ulid(),
					name: "sidebar",
					label: "Sidebar",
					description: "Primary sidebar",
				})
				.execute();

			const area = await db
				.selectFrom("_emdash_widget_areas")
				.selectAll()
				.where("name", "=", "sidebar")
				.executeTakeFirst();

			expect(area).not.toBeNull();
			expect(area?.label).toBe("Sidebar");
		});
	});

	describe("widgets", () => {
		let areaId: string;

		beforeEach(async () => {
			areaId = ulid();
			await db
				.insertInto("_emdash_widget_areas")
				.values({
					id: areaId,
					name: "sidebar",
					label: "Sidebar",
					description: null,
				})
				.execute();
		});

		describe("content widgets", () => {
			it("should create a content widget", async () => {
				const id = ulid();
				const content = [{ _type: "block", children: [{ _type: "span", text: "Hello" }] }];

				await db
					.insertInto("_emdash_widgets")
					.values({
						id,
						area_id: areaId,
						sort_order: 0,
						type: "content" as WidgetType,
						title: "Welcome",
						content: JSON.stringify(content),
						menu_name: null,
						component_id: null,
						component_props: null,
					})
					.execute();

				const widget = await db
					.selectFrom("_emdash_widgets")
					.selectAll()
					.where("id", "=", id)
					.executeTakeFirst();

				expect(widget).not.toBeNull();
				expect(widget?.type).toBe("content");
				expect(widget?.title).toBe("Welcome");
				expect(JSON.parse(widget!.content!)).toEqual(content);
			});
		});

		describe("menu widgets", () => {
			it("should create a menu widget", async () => {
				const id = ulid();

				await db
					.insertInto("_emdash_widgets")
					.values({
						id,
						area_id: areaId,
						sort_order: 0,
						type: "menu" as WidgetType,
						title: "Navigation",
						content: null,
						menu_name: "sidebar-nav",
						component_id: null,
						component_props: null,
					})
					.execute();

				const widget = await db
					.selectFrom("_emdash_widgets")
					.selectAll()
					.where("id", "=", id)
					.executeTakeFirst();

				expect(widget).not.toBeNull();
				expect(widget?.type).toBe("menu");
				expect(widget?.menu_name).toBe("sidebar-nav");
			});
		});

		describe("component widgets", () => {
			it("should create a component widget", async () => {
				const id = ulid();
				const props = { count: 5, showDate: true };

				await db
					.insertInto("_emdash_widgets")
					.values({
						id,
						area_id: areaId,
						sort_order: 0,
						type: "component" as WidgetType,
						title: "Recent Posts",
						content: null,
						menu_name: null,
						component_id: "core:recent-posts",
						component_props: JSON.stringify(props),
					})
					.execute();

				const widget = await db
					.selectFrom("_emdash_widgets")
					.selectAll()
					.where("id", "=", id)
					.executeTakeFirst();

				expect(widget).not.toBeNull();
				expect(widget?.type).toBe("component");
				expect(widget?.component_id).toBe("core:recent-posts");
				expect(JSON.parse(widget!.component_props!)).toEqual(props);
			});
		});

		describe("ordering", () => {
			it("should order widgets by sort_order", async () => {
				await db
					.insertInto("_emdash_widgets")
					.values([
						{
							id: ulid(),
							area_id: areaId,
							sort_order: 2,
							type: "content" as WidgetType,
							title: "Third",
							content: null,
							menu_name: null,
							component_id: null,
							component_props: null,
						},
						{
							id: ulid(),
							area_id: areaId,
							sort_order: 0,
							type: "content" as WidgetType,
							title: "First",
							content: null,
							menu_name: null,
							component_id: null,
							component_props: null,
						},
						{
							id: ulid(),
							area_id: areaId,
							sort_order: 1,
							type: "content" as WidgetType,
							title: "Second",
							content: null,
							menu_name: null,
							component_id: null,
							component_props: null,
						},
					])
					.execute();

				const widgets = await db
					.selectFrom("_emdash_widgets")
					.selectAll()
					.where("area_id", "=", areaId)
					.orderBy("sort_order", "asc")
					.execute();

				expect(widgets).toHaveLength(3);
				expect(widgets[0].title).toBe("First");
				expect(widgets[1].title).toBe("Second");
				expect(widgets[2].title).toBe("Third");
			});

			it("should update sort_order for reordering", async () => {
				const ids = [ulid(), ulid(), ulid()];

				await db
					.insertInto("_emdash_widgets")
					.values([
						{
							id: ids[0],
							area_id: areaId,
							sort_order: 0,
							type: "content" as WidgetType,
							title: "A",
							content: null,
							menu_name: null,
							component_id: null,
							component_props: null,
						},
						{
							id: ids[1],
							area_id: areaId,
							sort_order: 1,
							type: "content" as WidgetType,
							title: "B",
							content: null,
							menu_name: null,
							component_id: null,
							component_props: null,
						},
						{
							id: ids[2],
							area_id: areaId,
							sort_order: 2,
							type: "content" as WidgetType,
							title: "C",
							content: null,
							menu_name: null,
							component_id: null,
							component_props: null,
						},
					])
					.execute();

				// Reorder: C (was 2) -> 0, A (was 0) -> 1, B (was 1) -> 2
				const newOrder = [ids[2], ids[0], ids[1]];
				for (let i = 0; i < newOrder.length; i++) {
					await db
						.updateTable("_emdash_widgets")
						.set({ sort_order: i })
						.where("id", "=", newOrder[i])
						.execute();
				}

				const widgets = await db
					.selectFrom("_emdash_widgets")
					.selectAll()
					.where("area_id", "=", areaId)
					.orderBy("sort_order", "asc")
					.execute();

				expect(widgets[0].title).toBe("C");
				expect(widgets[1].title).toBe("A");
				expect(widgets[2].title).toBe("B");
			});
		});

		describe("update and delete", () => {
			it("should update widget properties", async () => {
				const id = ulid();

				await db
					.insertInto("_emdash_widgets")
					.values({
						id,
						area_id: areaId,
						sort_order: 0,
						type: "content" as WidgetType,
						title: "Original",
						content: JSON.stringify([{ _type: "block", children: [] }]),
						menu_name: null,
						component_id: null,
						component_props: null,
					})
					.execute();

				const newContent = [{ _type: "block", children: [{ _type: "span", text: "Updated" }] }];

				await db
					.updateTable("_emdash_widgets")
					.set({
						title: "Updated Title",
						content: JSON.stringify(newContent),
					})
					.where("id", "=", id)
					.execute();

				const widget = await db
					.selectFrom("_emdash_widgets")
					.selectAll()
					.where("id", "=", id)
					.executeTakeFirst();

				expect(widget?.title).toBe("Updated Title");
				expect(JSON.parse(widget!.content!)).toEqual(newContent);
			});

			it("should delete a widget", async () => {
				const id = ulid();

				await db
					.insertInto("_emdash_widgets")
					.values({
						id,
						area_id: areaId,
						sort_order: 0,
						type: "content" as WidgetType,
						title: "To Delete",
						content: null,
						menu_name: null,
						component_id: null,
						component_props: null,
					})
					.execute();

				await db.deleteFrom("_emdash_widgets").where("id", "=", id).execute();

				const widget = await db
					.selectFrom("_emdash_widgets")
					.selectAll()
					.where("id", "=", id)
					.executeTakeFirst();

				expect(widget).toBeUndefined();
			});
		});
	});

	describe("widget components registry", () => {
		it("should return core widget components", () => {
			const components = getWidgetComponents();

			expect(components.length).toBeGreaterThan(0);

			const recentPosts = components.find((c) => c.id === "core:recent-posts");
			expect(recentPosts).toBeDefined();
			expect(recentPosts?.label).toBe("Recent Posts");
			expect(recentPosts?.props).toHaveProperty("count");
			expect(recentPosts?.props).toHaveProperty("showThumbnails");
			expect(recentPosts?.props).toHaveProperty("showDate");
			expect(recentPosts?.props).toHaveProperty("urlTemplate");
		});

		it("should include categories component", () => {
			const components = getWidgetComponents();
			const categories = components.find((c) => c.id === "core:categories");

			expect(categories).toBeDefined();
			expect(categories?.props).toHaveProperty("showCount");
			expect(categories?.props).toHaveProperty("hierarchical");
		});

		it("should include tags component", () => {
			const components = getWidgetComponents();
			const tags = components.find((c) => c.id === "core:tags");

			expect(tags).toBeDefined();
			expect(tags?.props).toHaveProperty("showCount");
			expect(tags?.props).toHaveProperty("limit");
		});

		it("should include search component", () => {
			const components = getWidgetComponents();
			const search = components.find((c) => c.id === "core:search");

			expect(search).toBeDefined();
			expect(search?.props).toHaveProperty("placeholder");
		});

		it("should include archives component", () => {
			const components = getWidgetComponents();
			const archives = components.find((c) => c.id === "core:archives");

			expect(archives).toBeDefined();
			expect(archives?.props).toHaveProperty("type");
			expect(archives?.props).toHaveProperty("limit");
			expect(archives?.props.type.options).toEqual([
				{ value: "monthly", label: "Monthly" },
				{ value: "yearly", label: "Yearly" },
			]);
		});

		it("should have valid prop definitions", () => {
			const components = getWidgetComponents();

			for (const component of components) {
				expect(component.id).toMatch(WIDGET_ID_FORMAT_REGEX);
				expect(component.label).toBeTruthy();

				for (const [_key, prop] of Object.entries(component.props)) {
					expect(["string", "number", "boolean", "select"]).toContain(prop.type);
					expect(prop.label).toBeTruthy();

					if (prop.type === "select") {
						expect(prop.options).toBeDefined();
						expect(Array.isArray(prop.options)).toBe(true);
					}
				}
			}
		});
	});
});
