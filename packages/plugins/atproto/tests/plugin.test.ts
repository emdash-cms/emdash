import { describe, it, expect } from "vitest";

import { atprotoPlugin } from "../src/index.js";

describe("atprotoPlugin descriptor", () => {
	it("returns a valid PluginDescriptor", () => {
		const descriptor = atprotoPlugin();
		expect(descriptor.id).toBe("atproto");
		expect(descriptor.version).toBe("0.1.0");
		expect(descriptor.entrypoint).toBe("@emdash-cms/plugin-atproto/sandbox");
		expect(descriptor.adminPages).toHaveLength(1);
		expect(descriptor.adminWidgets).toHaveLength(1);
	});

	it("uses standard format", () => {
		const descriptor = atprotoPlugin();
		expect(descriptor.format).toBe("standard");
	});

	it("declares required capabilities", () => {
		const descriptor = atprotoPlugin();
		expect(descriptor.capabilities).toContain("read:content");
		expect(descriptor.capabilities).toContain("network:fetch:any");
	});

	it("declares the storage used by the sandbox implementation", () => {
		const descriptor = atprotoPlugin();
		expect(descriptor.storage).toHaveProperty("records");
		expect(descriptor.storage!.records!.indexes).toContain("contentId");
		expect(descriptor.storage!.records!.indexes).toContain("status");
		expect(descriptor.storage!.records!.indexes).toContain("lastSyncedAt");
	});

	it("exposes an admin status page and widget", () => {
		const descriptor = atprotoPlugin();
		expect(descriptor.adminPages).toEqual([
			{ path: "/status", label: "AT Protocol", icon: "globe" },
		]);
		expect(descriptor.adminWidgets).toEqual([
			{ id: "sync-status", title: "AT Protocol", size: "third" },
		]);
	});
});
