import { describe, it, expect, beforeEach } from "vitest";

import { createDbStore } from "../src/db-store.js";

interface State {
	issuer: string;
	expiresAt?: number;
}

interface Entry {
	value: State;
	expiresAt: number | null;
}

describe("createDbStore", () => {
	let rows: Map<string, Entry>;
	const store = createDbStore<string, State>(() => ({
		get: async (id) => rows.get(id) ?? null,
		put: async (id, data) => void rows.set(id, data),
		delete: async (id) => rows.delete(id),
		deleteMany: async (ids) => ids.filter((id) => rows.delete(id)).length,
		query: async () => ({ items: Array.from(rows, ([id, data]) => ({ id, data })) }),
	}));

	beforeEach(() => {
		rows = new Map();
	});

	it("returns a value whose expiresAt has not passed", async () => {
		const state = { issuer: "https://pds.example", expiresAt: Date.now() + 10 * 60 * 1000 };
		await store.set("state", state);

		expect(await store.get("state")).toEqual(state);
	});

	it("drops a value whose expiresAt has passed", async () => {
		await store.set("state", { issuer: "https://pds.example", expiresAt: Date.now() - 60 * 1000 });

		expect(await store.get("state")).toBeUndefined();
		expect(rows.size).toBe(0);
	});

	it("keeps a value that has no expiresAt", async () => {
		const value = { issuer: "https://pds.example" };
		await store.set("key", value);

		expect(await store.get("key")).toEqual(value);
	});
});
