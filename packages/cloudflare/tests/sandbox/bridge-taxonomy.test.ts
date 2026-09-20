/**
 * Tests for the PluginBridge taxonomy methods (taxonomyList, taxonomyTerms,
 * taxonomyEntryTerms): capability enforcement, SQL/parameter wiring for the
 * locale/taxonomy filters, and D1 row mapping (JSON parsing, int→bool,
 * nullable columns).
 */

import { describe, expect, it, vi } from "vitest";

// PluginBridge extends WorkerEntrypoint from cloudflare:workers, which is
// not importable under plain vitest. Substitute a minimal base class that
// stores ctx/env the way the runtime does.
vi.mock("cloudflare:workers", () => ({
	WorkerEntrypoint: class {
		ctx: unknown;
		env: unknown;
		constructor(ctx: unknown, env: unknown) {
			this.ctx = ctx;
			this.env = env;
		}
	},
}));

import { PluginBridge, setTaxonomyWriteCallback } from "../../src/sandbox/bridge.js";

type Row = Record<string, unknown>;

interface RecordedQuery {
	sql: string;
	params: unknown[];
}

/** Minimal fake D1Database: records SQL + bound params, returns canned rows. */
function fakeD1(rows: Row[], recorded: RecordedQuery[]) {
	return {
		prepare(sql: string) {
			const statement = {
				params: [] as unknown[],
				bind(...args: unknown[]) {
					statement.params = args;
					return statement;
				},
				async all() {
					recorded.push({ sql, params: statement.params });
					return { results: rows };
				},
				async first() {
					recorded.push({ sql, params: statement.params });
					return rows[0] ?? null;
				},
				async run() {
					recorded.push({ sql, params: statement.params });
					return { meta: { changes: 0 } };
				},
			};
			return statement;
		},
	};
}

function makeBridge(capabilities: string[], rows: Row[] = [], taxonomyWriteRuntimeId?: string) {
	const recorded: RecordedQuery[] = [];
	const ctx = {
		props: {
			pluginId: "test-plugin",
			pluginVersion: "1.0.0",
			capabilities,
			allowedHosts: [],
			storageCollections: [],
			taxonomyWriteRuntimeId,
		},
	};
	const env = { DB: fakeD1(rows, recorded) };
	// eslint-disable-next-line typescript/no-unsafe-type-assertion -- fake ctx/env stand in for the Workers runtime injections
	const bridge = new PluginBridge(ctx as never, env as never);
	return { bridge, recorded };
}

const TERM_ROW: Row = {
	id: "term-1",
	name: "category",
	slug: "news",
	label: "News",
	parent_id: null,
	data: '{"color":"red"}',
	locale: "en",
	translation_group: "tg-1",
};

describe("PluginBridge taxonomy methods — capability enforcement", () => {
	it("rejects all three methods without taxonomies:read", async () => {
		// content:read must not grant taxonomy access.
		const { bridge } = makeBridge(["content:read"]);
		await expect(bridge.taxonomyList()).rejects.toThrow(/taxonomies:read/);
		await expect(bridge.taxonomyTerms("category")).rejects.toThrow(/taxonomies:read/);
		await expect(bridge.taxonomyEntryTerms("posts", "p1")).rejects.toThrow(/taxonomies:read/);
	});

	it("routes writes through the runtime callback and denies read-only plugins", async () => {
		const createTerm = vi.fn(async () => ({
			id: "term-2",
			taxonomy: "category",
			slug: "reviews",
			label: "Reviews",
			parentId: null,
			data: null,
			locale: "en",
			translationGroup: "term-2",
		}));
		const addEntryTerms = vi.fn(async () => []);
		const removeEntryTerms = vi.fn(async () => []);
		setTaxonomyWriteCallback("writer", {
			getAll: vi.fn(async () => []),
			getTerms: vi.fn(async () => []),
			getEntryTerms: vi.fn(async () => []),
			createTerm,
			addEntryTerms,
			removeEntryTerms,
		});

		const reader = makeBridge(["taxonomies:read"]).bridge;
		await expect(reader.taxonomyCreateTerm("category", { label: "Reviews" })).rejects.toThrow(
			/taxonomies:write/,
		);

		const writer = makeBridge(["taxonomies:read", "taxonomies:write"], [], "writer").bridge;
		await writer.taxonomyCreateTerm("category", { label: "Reviews" });
		await writer.taxonomyAddEntryTerms("posts", "post-1", "category", ["term-2"]);
		await writer.taxonomyRemoveEntryTerms("posts", "post-1", "category", ["term-2"]);

		expect(createTerm).toHaveBeenCalledWith("category", { label: "Reviews" });
		expect(addEntryTerms).toHaveBeenCalledWith("posts", "post-1", "category", ["term-2"]);
		expect(removeEntryTerms).toHaveBeenCalledWith("posts", "post-1", "category", ["term-2"]);
		setTaxonomyWriteCallback("writer", null);
	});

	it("isolates taxonomy callbacks by runner and removes terminated callbacks", async () => {
		const firstCreate = vi.fn(async () => TERM_ROW as never);
		const secondCreate = vi.fn(async () => TERM_ROW as never);
		const access = (createTerm: typeof firstCreate) => ({
			getAll: vi.fn(async () => []),
			getTerms: vi.fn(async () => []),
			getEntryTerms: vi.fn(async () => []),
			createTerm,
			addEntryTerms: vi.fn(async () => []),
			removeEntryTerms: vi.fn(async () => []),
		});
		setTaxonomyWriteCallback("first", access(firstCreate));
		setTaxonomyWriteCallback("second", access(secondCreate));

		const first = makeBridge(["taxonomies:write"], [], "first").bridge;
		const second = makeBridge(["taxonomies:write"], [], "second").bridge;
		await first.taxonomyCreateTerm("category", { label: "First" });
		await second.taxonomyCreateTerm("category", { label: "Second" });

		expect(firstCreate).toHaveBeenCalledOnce();
		expect(secondCreate).toHaveBeenCalledOnce();
		setTaxonomyWriteCallback("first", null);
		await expect(first.taxonomyCreateTerm("category", { label: "Missing" })).rejects.toThrow(
			"Taxonomy mutations are not available",
		);
		setTaxonomyWriteCallback("second", null);
	});
});

describe("PluginBridge content discovery capability enforcement", () => {
	it("denies schema and revision history independently", async () => {
		const { bridge } = makeBridge(["content:read"]);
		await expect(bridge.schemaListCollections()).rejects.toThrow(/schema:read/);
		await expect(bridge.contentListRevisions("posts", "post-1")).rejects.toThrow(
			/content:revisions:read/,
		);
	});
});

describe("taxonomyList", () => {
	it("maps rows: int→bool, JSON collections, nullable label_singular", async () => {
		const { bridge } = makeBridge(
			["taxonomies:read"],
			[
				{
					name: "category",
					label: "Categories",
					label_singular: "Category",
					hierarchical: 1,
					collections: '["posts","pages"]',
					locale: "en",
				},
				{
					name: "tag",
					label: "Tags",
					label_singular: null,
					hierarchical: 0,
					collections: "not-json",
					locale: "en",
				},
			],
		);

		const defs = await bridge.taxonomyList();
		expect(defs).toEqual([
			{
				name: "category",
				label: "Categories",
				labelSingular: "Category",
				hierarchical: true,
				collections: ["posts", "pages"],
				locale: "en",
			},
			{
				name: "tag",
				label: "Tags",
				labelSingular: null,
				hierarchical: false,
				collections: [],
				locale: "en",
			},
		]);
	});

	it("filters by locale only when provided", async () => {
		const { bridge, recorded } = makeBridge(["taxonomies:read"]);
		await bridge.taxonomyList();
		await bridge.taxonomyList({ locale: "de" });

		expect(recorded[0]?.sql).not.toContain("locale");
		expect(recorded[0]?.params).toEqual([]);
		expect(recorded[1]?.sql).toContain("WHERE locale = ?");
		expect(recorded[1]?.params).toEqual(["de"]);
	});
});

describe("taxonomyTerms", () => {
	it("maps rows including JSON data and translation group", async () => {
		const { bridge } = makeBridge(["taxonomies:read"], [TERM_ROW]);
		const terms = await bridge.taxonomyTerms("category");
		expect(terms).toEqual([
			{
				id: "term-1",
				taxonomy: "category",
				slug: "news",
				label: "News",
				parentId: null,
				data: { color: "red" },
				locale: "en",
				translationGroup: "tg-1",
			},
		]);
	});

	it("returns null data for malformed JSON", async () => {
		const { bridge } = makeBridge(["taxonomies:read"], [{ ...TERM_ROW, data: "{broken" }]);
		const terms = await bridge.taxonomyTerms("category");
		expect(terms[0]?.data).toBeNull();
	});

	it("binds the taxonomy name and appends the locale filter when provided", async () => {
		const { bridge, recorded } = makeBridge(["taxonomies:read"]);
		await bridge.taxonomyTerms("category");
		await bridge.taxonomyTerms("category", { locale: "fr" });

		expect(recorded[0]?.sql).toContain("WHERE name = ?");
		expect(recorded[0]?.params).toEqual(["category"]);
		expect(recorded[1]?.sql).toContain("AND locale = ?");
		expect(recorded[1]?.params).toEqual(["category", "fr"]);
	});

	// Terms carry a manual order, so a plugin reading through the bridge has to
	// get the same order core's TaxonomyRepository.findByName returns. The clause
	// is a raw string here, so assert it rather than trusting it.
	it("orders by the manual position ahead of the label", async () => {
		const { bridge, recorded } = makeBridge(["taxonomies:read"]);
		await bridge.taxonomyTerms("category");

		expect(recorded[0]?.sql).toContain("ORDER BY sort_order ASC, label ASC, id ASC");
	});
});

describe("taxonomyEntryTerms", () => {
	it("joins the pivot on translation_group and binds collection + entry", async () => {
		const { bridge, recorded } = makeBridge(["taxonomies:read"], [TERM_ROW]);
		const terms = await bridge.taxonomyEntryTerms("posts", "post-1");

		expect(recorded[0]?.sql).toContain(
			"JOIN taxonomies ON taxonomies.translation_group = content_taxonomies.taxonomy_id",
		);
		expect(recorded[0]?.params).toEqual(["posts", "post-1"]);
		expect(terms[0]?.taxonomy).toBe("category");
	});

	it("appends taxonomy and locale filters in order when provided", async () => {
		const { bridge, recorded } = makeBridge(["taxonomies:read"]);
		await bridge.taxonomyEntryTerms("posts", "post-1", { taxonomy: "tag", locale: "de" });

		expect(recorded[0]?.sql).toContain("AND taxonomies.name = ?");
		expect(recorded[0]?.sql).toContain("AND taxonomies.locale = ?");
		expect(recorded[0]?.params).toEqual(["posts", "post-1", "tag", "de"]);
	});
});
