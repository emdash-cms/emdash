import type { KyselyPlugin, QueryId } from "kysely";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";

import {
	describeEachDialect,
	destroySharedPool,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

vi.mock("../../../src/loader.js", () => ({ getDb: vi.fn() }));
vi.mock("virtual:emdash/object-cache", () => ({ createObjectCache: undefined }));

import { prefetchLayoutData } from "../../../src/astro/prefetch.js";
import { getDb } from "../../../src/loader.js";
import { runWithContext } from "../../../src/request-context.js";
import { getWidgetArea } from "../../../src/widgets/index.js";

afterAll(destroySharedPool);

describeEachDialect("widget area request cache", (dialect) => {
	let ctx: DialectTestContext;
	let queries: string[];
	let failBulkRead: boolean;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
		await ctx.db
			.insertInto("_emdash_widget_areas")
			.values([
				{ id: "footer", name: "footer", label: "Footer" },
				{ id: "sidebar", name: "sidebar", label: "Sidebar" },
				{ id: "empty", name: "empty", label: "Empty" },
			])
			.execute();
		await ctx.db
			.insertInto("_emdash_widgets")
			.values([
				{ id: "links", area_id: "footer", type: "menu", menu_name: "links", sort_order: 2 },
				{
					id: "search",
					area_id: "footer",
					type: "component",
					component_id: "core:search",
					component_props: JSON.stringify({ placeholder: "Search" }),
					sort_order: 1,
				},
				{
					id: "about",
					area_id: "sidebar",
					type: "content",
					content: JSON.stringify([{ _type: "block", children: [] }]),
					sort_order: 0,
				},
			])
			.execute();

		queries = [];
		failBulkRead = false;
		const bulkReads = new WeakSet<QueryId>();
		const plugin: KyselyPlugin = {
			transformQuery(args) {
				const { sql } = ctx.db.getExecutor().compileQuery(args.node, args.queryId);
				if (sql.includes("_emdash_widget")) queries.push(sql);
				if (sql.includes('from "_emdash_widget_areas"') && !sql.includes(" join ")) {
					bulkReads.add(args.queryId);
				}
				return args.node;
			},
			async transformResult(args) {
				if (failBulkRead && bulkReads.has(args.queryId)) throw new Error("Bulk read failed");
				return args.result;
			},
		};
		vi.mocked(getDb).mockResolvedValue(ctx.db.withPlugin(plugin));
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
		vi.clearAllMocks();
	});

	it("shares in-flight prefetch with concurrent named reads, including missing areas", async () => {
		const footer = await getWidgetArea("footer");
		const sidebar = await getWidgetArea("sidebar");
		expect(footer?.widgets.map((widget) => widget.id)).toEqual(["search", "links"]);
		queries = [];

		await runWithContext({ editMode: false }, async () => {
			const [, actualFooter, actualSidebar, empty, missing] = await Promise.all([
				prefetchLayoutData(),
				getWidgetArea("footer"),
				getWidgetArea("sidebar"),
				getWidgetArea("empty"),
				getWidgetArea("missing"),
			]);
			expect(actualFooter).toEqual(footer);
			expect(actualSidebar).toEqual(sidebar);
			expect(empty?.widgets).toEqual([]);
			expect(missing).toBeNull();
			expect(queries).toHaveLength(2);
		});
	});

	it("shares the bulk load between repeated prefetch calls", async () => {
		await runWithContext({ editMode: false }, async () => {
			await Promise.all([prefetchLayoutData(), prefetchLayoutData()]);
			expect(queries).toHaveLength(2);
		});
	});

	it("serves completed prefetch results without further queries", async () => {
		await runWithContext({ editMode: false }, async () => {
			await prefetchLayoutData();
			queries = [];
			expect((await getWidgetArea("footer"))?.widgets).toHaveLength(2);
			expect(await getWidgetArea("missing")).toBeNull();
			expect(queries).toHaveLength(0);
		});
	});

	it("falls back to a named read when the optional bulk load fails", async () => {
		failBulkRead = true;
		await runWithContext({ editMode: false }, async () => {
			const [, footer] = await Promise.all([prefetchLayoutData(), getWidgetArea("footer")]);
			expect(footer?.widgets.map((widget) => widget.id)).toEqual(["search", "links"]);
			expect(await getWidgetArea("footer")).toBe(footer);
			expect(queries).toHaveLength(2);
		});
	});

	it("keeps named reads scoped when no prefetch runs", async () => {
		await runWithContext({ editMode: false }, async () => {
			const [first, second] = await Promise.all([getWidgetArea("footer"), getWidgetArea("footer")]);
			expect(first).toBe(second);
			expect(queries).toHaveLength(1);
			expect(queries[0]).toContain("where");
		});
	});

	it("does not reuse prefetched data across requests", async () => {
		await runWithContext({ editMode: false }, () => prefetchLayoutData());
		await ctx.db
			.updateTable("_emdash_widget_areas")
			.set({ label: "Updated" })
			.where("id", "=", "footer")
			.execute();
		queries = [];
		const area = await runWithContext({ editMode: false }, () => getWidgetArea("footer"));
		expect(area?.label).toBe("Updated");
		expect(queries).toHaveLength(1);
	});
});
