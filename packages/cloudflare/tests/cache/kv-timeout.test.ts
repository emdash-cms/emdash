import { describe, expect, it, vi } from "vitest";

// The KV backend imports the binding from cloudflare:workers. Provide a fake
// `env` with a KV namespace whose ops never settle — the production hang.
// `vi.hoisted` runs before the hoisted `vi.mock` factory below.
const { stalledKv } = vi.hoisted(() => ({
	stalledKv: {
		get: () => new Promise<string | null>(() => {}), // never resolves or rejects
		put: () => new Promise<void>(() => {}),
		delete: () => new Promise<void>(() => {}),
	},
}));

vi.mock("cloudflare:workers", () => ({ env: { CACHE: stalledKv } }));

import { createObjectCache } from "../../src/cache/kv.js";

describe("kvCache backend timeout", () => {
	it("rejects a stalled get after the timeout instead of hanging", async () => {
		const backend = createObjectCache({ binding: "CACHE", timeout: 20 });
		await expect(backend.get("k")).rejects.toThrow(/timed out/);
	});

	it("rejects a stalled put after the timeout", async () => {
		const backend = createObjectCache({ binding: "CACHE", timeout: 20 });
		await expect(backend.set("k", "v")).rejects.toThrow(/timed out/);
	});
});
