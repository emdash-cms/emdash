import { env } from "cloudflare:test";
import { Kysely, sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { D1Adapter, RawBindingD1Dialect } from "../../../cloudflare/src/db/d1-dialect.js";
import { runMigrations } from "../../src/database/migrations/runner.js";
import type { Database } from "../../src/database/types.js";
import { applySeed } from "../../src/seed/apply.js";
import type { SeedFile, SeedWidgetArea } from "../../src/seed/types.js";
import { resetD1Schema } from "./d1-schema.js";

declare module "cloudflare:test" {
	interface ProvidedEnv {
		DB: D1Database;
	}
}

let db: Kysely<Database>;

beforeAll(() => {
	db = new Kysely<Database>({ dialect: new RawBindingD1Dialect({ database: env.DB }) });
});

beforeEach(async () => {
	await resetD1Schema(db);
	await runMigrations(db);
});

afterAll(async () => {
	await db.destroy();
});

function widgetArea(name: string, count: number, prefix = name): SeedWidgetArea {
	return {
		name,
		label: name,
		widgets: Array.from({ length: count }, (_, index) => ({
			type: "component",
			componentId: `${prefix}-${index}`,
			title: `${prefix} title ${index}`,
		})),
	};
}

function seed(...widgetAreas: SeedWidgetArea[]): SeedFile {
	return { version: "1", widgetAreas };
}

async function readWidgets(database: Kysely<Database>) {
	return database
		.selectFrom("_emdash_widgets")
		.innerJoin("_emdash_widget_areas", "_emdash_widget_areas.id", "_emdash_widgets.area_id")
		.select([
			"_emdash_widget_areas.name as area",
			"_emdash_widgets.sort_order as sortOrder",
			"_emdash_widgets.title as title",
			"_emdash_widgets.component_id as componentId",
		])
		.orderBy("_emdash_widget_areas.name")
		.orderBy("_emdash_widgets.sort_order")
		.execute();
}

describe("applySeed widgets on D1", () => {
	it("concurrently creates areas with exactly the seeded widgets", async () => {
		const first = new Kysely<Database>({
			dialect: new RawBindingD1Dialect({ database: env.DB }),
		});
		const second = new Kysely<Database>({
			dialect: new RawBindingD1Dialect({ database: env.DB }),
		});
		try {
			const widgetSeed = seed(widgetArea("sidebar", 5), widgetArea("footer", 2));
			await expect(
				Promise.all([applySeed(first, widgetSeed), applySeed(second, widgetSeed)]),
			).resolves.toHaveLength(2);

			const widgets = await readWidgets(db);
			expect(widgets).toHaveLength(7);
			expect(widgets.map(({ area, sortOrder, title }) => [area, sortOrder, title])).toEqual([
				["footer", 0, "footer title 0"],
				["footer", 1, "footer title 1"],
				["sidebar", 0, "sidebar title 0"],
				["sidebar", 1, "sidebar title 1"],
				["sidebar", 2, "sidebar title 2"],
				["sidebar", 3, "sidebar title 3"],
				["sidebar", 4, "sidebar title 4"],
			]);
		} finally {
			await Promise.all([first.destroy(), second.destroy()]);
		}
	});

	it("atomically replaces all areas when concurrent replacements meet at the D1 batch", async () => {
		const first = new Kysely<Database>({
			dialect: new RawBindingD1Dialect({ database: env.DB }),
		});
		const second = new Kysely<Database>({
			dialect: new RawBindingD1Dialect({ database: env.DB }),
		});
		const firstAdapter = first.getExecutor().adapter;
		const secondAdapter = second.getExecutor().adapter;
		if (!(firstAdapter instanceof D1Adapter) || !(secondAdapter instanceof D1Adapter)) {
			throw new Error("Expected D1 adapters");
		}
		const firstBatch = firstAdapter.executeAtomicBatch.bind(firstAdapter);
		const secondBatch = secondAdapter.executeAtomicBatch.bind(secondAdapter);
		let arrived = 0;
		const barrier = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const waitForBoth = async () => {
			if (++arrived === 2) barrier.resolve();
			await release.promise;
		};
		const firstSpy = vi
			.spyOn(firstAdapter, "executeAtomicBatch")
			.mockImplementation(async (queries) => {
				await waitForBoth();
				return firstBatch(queries);
			});
		const secondSpy = vi
			.spyOn(secondAdapter, "executeAtomicBatch")
			.mockImplementation(async (queries) => {
				await waitForBoth();
				return secondBatch(queries);
			});
		try {
			const initial = seed(
				widgetArea("sidebar", 1, "initial-sidebar"),
				widgetArea("footer", 1, "initial-footer"),
			);
			await applySeed(db, initial);
			const seedA = seed(
				widgetArea("sidebar", 3, "A-sidebar"),
				widgetArea("footer", 2, "A-footer"),
			);
			const seedB = seed(
				widgetArea("sidebar", 4, "B-sidebar"),
				widgetArea("footer", 3, "B-footer"),
			);
			const applications = Promise.all([applySeed(first, seedA), applySeed(second, seedB)]);
			try {
				await Promise.race([barrier.promise, applications]);
			} finally {
				release.resolve();
			}
			await expect(applications).resolves.toHaveLength(2);
			expect(arrived).toBe(2);

			const widgets = await readWidgets(db);
			const byArea = new Map<string, typeof widgets>();
			for (const widget of widgets) {
				const areaWidgets = byArea.get(widget.area) ?? [];
				areaWidgets.push(widget);
				byArea.set(widget.area, areaWidgets);
			}
			const sidebar = byArea.get("sidebar") ?? [];
			const selectedPrefix = sidebar[0]?.componentId?.charAt(0);
			expect(selectedPrefix).toMatch(/[AB]/);
			expect(sidebar).toHaveLength(selectedPrefix === "A" ? 3 : 4);
			expect(sidebar.map((widget) => widget.sortOrder)).toEqual(sidebar.map((_, index) => index));
			for (const area of ["sidebar", "footer"]) {
				const areaWidgets = byArea.get(area) ?? [];
				expect(
					areaWidgets.every((widget) => widget.componentId?.startsWith(selectedPrefix ?? "")),
				).toBe(true);
				expect(areaWidgets.map((widget) => widget.sortOrder)).toEqual(
					areaWidgets.map((_, index) => index),
				);
			}
			expect(byArea.get("footer")).toHaveLength(selectedPrefix === "A" ? 2 : 3);
		} finally {
			release.resolve();
			firstSpy.mockRestore();
			secondSpy.mockRestore();
			await Promise.all([first.destroy(), second.destroy()]);
		}
	});

	it("rolls back every area when a widget insert fails", async () => {
		await applySeed(
			db,
			seed(widgetArea("sidebar", 2, "old-sidebar"), widgetArea("footer", 2, "old-footer")),
		);
		await sql`
			CREATE TRIGGER fail_seed_widget
			BEFORE INSERT ON _emdash_widgets
			WHEN NEW.title = 'Fail'
			BEGIN SELECT RAISE(ABORT, 'seed widget rejected'); END
		`.execute(db);

		const replacement = seed(widgetArea("sidebar", 2, "new-sidebar"), {
			...widgetArea("footer", 2, "new-footer"),
			widgets: [
				{ type: "component", componentId: "new-footer-0", title: "Okay" },
				{ type: "component", componentId: "new-footer-1", title: "Fail" },
			],
		});
		await expect(applySeed(db, replacement)).rejects.toThrow("seed widget rejected");
		expect(await readWidgets(db)).toEqual([
			{ area: "footer", sortOrder: 0, title: "old-footer title 0", componentId: "old-footer-0" },
			{ area: "footer", sortOrder: 1, title: "old-footer title 1", componentId: "old-footer-1" },
			{ area: "sidebar", sortOrder: 0, title: "old-sidebar title 0", componentId: "old-sidebar-0" },
			{ area: "sidebar", sortOrder: 1, title: "old-sidebar title 1", componentId: "old-sidebar-1" },
		]);
	});

	it("replaces more than eleven widgets and clears an empty area", async () => {
		await applySeed(db, seed(widgetArea("large", 13, "old"), widgetArea("empty", 2, "old-empty")));
		await applySeed(db, seed(widgetArea("large", 13, "new"), widgetArea("empty", 0)));
		const widgets = await readWidgets(db);
		expect(widgets.filter((widget) => widget.area === "large")).toHaveLength(13);
		expect(
			widgets.filter((widget) => widget.area === "large").map((widget) => widget.sortOrder),
		).toEqual(Array.from({ length: 13 }, (_, index) => index));
		expect(
			widgets
				.filter((widget) => widget.area === "large")
				.every((widget) => widget.title?.startsWith("new")),
		).toBe(true);
		expect(widgets.filter((widget) => widget.area === "empty")).toEqual([]);
	});
});
