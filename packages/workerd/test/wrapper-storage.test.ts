import { describe, expect, it } from "vitest";

import { generatePluginWrapper } from "../src/sandbox/wrapper.js";

interface StorageContext {
	storage: { records: { updateIf(id: unknown, args: unknown): Promise<unknown> } };
}

function createWrapper() {
	const generated = generatePluginWrapper(
		{ id: "storage-wrapper", version: "1.0.0", capabilities: [], allowedHosts: [], storage: {} },
		{ backingServiceUrl: "http://bridge", authToken: "auth", invokeToken: "invoke" },
	);
	const end = generated.indexOf("\nexport default {");
	if (end < 0) throw new Error("Generated worker entry point is missing");
	const source = generated
		.slice(0, end)
		.replace('import pluginModule from "sandbox-plugin.js";', "");
	const calls: Array<{ url: string; body: unknown }> = [];
	const fetch = async (url: string, init: { body: string }) => {
		calls.push({ url, body: JSON.parse(init.body) });
		return Response.json({ result: { applied: true, data: { stock: 1 } } });
	};
	// eslint-disable-next-line no-implied-eval -- Exercise the generated context and HTTP serializer together.
	const factory = new Function("fetch", "pluginModule", source + "\nreturn createContext();");
	const context = factory(fetch, {}) as StorageContext;
	return { store: context.storage.records, calls };
}

describe("Workerd generated storage wrapper", () => {
	it.each([
		{ name: "undefined guard", args: { where: { stock: undefined }, set: { stock: 0 } } },
		{ name: "NaN guard", args: { where: { stock: NaN }, set: { stock: 0 } } },
		{
			name: "infinite range",
			args: { where: { stock: { gte: Infinity } }, set: { stock: 0 } },
		},
		{
			name: "undefined range",
			args: { where: { stock: { gte: undefined } }, set: { stock: 0 } },
		},
		{ name: "function guard", args: { where: { stock: () => 1 }, set: { stock: 0 } } },
		{ name: "symbol guard", args: { where: { stock: Symbol("stock") }, set: { stock: 0 } } },
		{ name: "bigint guard", args: { where: { stock: 1n }, set: { stock: 0 } } },
		{ name: "date guard", args: { where: new Date(0), set: { stock: 0 } } },
		{
			name: "guard toJSON",
			args: { where: { stock: undefined, toJSON: () => ({}) }, set: { stock: 0 } },
		},
		{
			name: "ambiguous delta",
			args: { where: {}, delta: { stock: { inc: 1, dec: undefined } } },
		},
		{ name: "infinite delta", args: { where: {}, delta: { stock: { inc: Infinity } } } },
		{
			name: "undefined in operand",
			args: { where: { stock: { in: [1, undefined] } }, set: { stock: 0 } },
		},
		{
			name: "unknown undefined argument",
			args: { where: {}, set: { stock: 0 }, unexpected: undefined },
		},
		{
			name: "root toJSON",
			args: { toJSON: () => ({ where: {}, set: { stock: 0 } }) },
		},
		{ name: "array set", args: { where: {}, set: [0] } },
		{ name: "array delta", args: { where: {}, delta: [{ inc: 1 }] } },
		{ name: "function set value", args: { where: {}, set: { stock: () => 0 } } },
	])("rejects $name before sending a write", async ({ args }) => {
		const { store, calls } = createWrapper();
		await expect(store.updateIf("stock", args)).rejects.toThrow(TypeError);
		expect(calls).toEqual([]);
	});

	it.each([1, { toJSON: () => "stock" }])(
		"rejects non-string ID %s before sending a write",
		async (id) => {
			const { store, calls } = createWrapper();
			await expect(store.updateIf(id, { where: {}, set: { stock: 0 } })).rejects.toThrow(TypeError);
			expect(calls).toEqual([]);
		},
	);

	it("rejects a cyclic guard before sending a write", async () => {
		const where: Record<string, unknown> = {};
		where.stock = where;
		const { store, calls } = createWrapper();
		await expect(store.updateIf("stock", { where, set: { stock: 0 } })).rejects.toThrow(TypeError);
		expect(calls).toEqual([]);
	});

	it("preserves valid guards, exact IDs and defined deltas", async () => {
		const { store, calls } = createWrapper();
		expect(
			await store.updateIf("constructor", {
				where: { stock: { gte: 1 }, category: { in: ["open", 1] } },
				delta: { stock: { dec: 1 }, ignored: undefined },
				set: undefined,
			}),
		).toEqual({ applied: true, data: { stock: 1 } });
		expect(calls).toEqual([
			{
				url: "http://bridge/storage/updateIf",
				body: {
					collection: "records",
					id: "constructor",
					args: {
						where: { stock: { gte: 1 }, category: { in: ["open", 1] } },
						delta: { stock: { dec: 1 } },
					},
				},
			},
		]);
	});

	it.each([
		{ filter: { gte: 1, lte: undefined }, expected: { gte: 1 } },
		{ filter: { in: [1], gte: Infinity }, expected: { in: [1] } },
		{ filter: { startsWith: "A", gte: undefined }, expected: { startsWith: "A" } },
	])("preserves the effective guard in $filter", async ({ filter, expected }) => {
		const { store, calls } = createWrapper();
		await store.updateIf("stock", { where: { stock: filter }, set: { stock: 0 } });
		expect(calls[0]?.body).toEqual({
			collection: "records",
			id: "stock",
			args: { where: { stock: expected }, set: { stock: 0 } },
		});
	});

	it("normalizes each defined set value while ignoring whole undefined entries", async () => {
		const { store, calls } = createWrapper();
		await store.updateIf("stock", {
			where: {},
			delta: undefined,
			set: {
				ignored: undefined,
				metadata: { toJSON: () => ({ count: NaN, items: [undefined, Infinity] }) },
			},
		});
		expect(calls[0]?.body).toEqual({
			collection: "records",
			id: "stock",
			args: { where: {}, set: { metadata: { count: null, items: [null, null] } } },
		});
	});

	it("snapshots guards before normalizing set values regardless of argument order", async () => {
		const { store, calls } = createWrapper();
		const where: { stock?: number } = { stock: 0 };
		await store.updateIf("stock", {
			set: {
				metadata: {
					toJSON() {
						delete where.stock;
						return {};
					},
				},
			},
			where,
		});
		expect(where).toEqual({});
		expect(calls[0]?.body).toEqual({
			collection: "records",
			id: "stock",
			args: { where: { stock: 0 }, set: { metadata: {} } },
		});
	});

	it("preserves unknown JSON fields for authoritative host validation", async () => {
		const { store, calls } = createWrapper();
		const where: unknown = JSON.parse('{"__proto__":{"gte":1}}');
		await store.updateIf("stock", { where, set: { stock: 0 }, unexpected: false });
		expect(calls[0]?.body).toEqual({
			collection: "records",
			id: "stock",
			args: { where, set: { stock: 0 }, unexpected: false },
		});
	});
});
