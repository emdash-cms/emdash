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

	it("declares storage with publications collection", () => {
		const descriptor = atprotoPlugin();
		expect(descriptor.storage).toHaveProperty("publications");
		expect(descriptor.storage!.publications!.indexes).toContain("contentId");
		expect(descriptor.storage!.publications!.indexes).toContain("platform");
		expect(descriptor.storage!.publications!.indexes).toContain("publishedAt");
	});

	it("has admin pages and widgets", () => {
		const descriptor = atprotoPlugin();
		expect(descriptor.adminPages![0]!.label).toBe("AT Protocol");
		expect(descriptor.adminWidgets![0]!.title).toBe("AT Protocol");
	});
});
