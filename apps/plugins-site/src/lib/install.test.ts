import { describe, expect, it } from "vitest";

import { normalizeSiteOrigin, pluginAdminUrl } from "./install.js";

describe("plugin install handoff", () => {
	it("normalizes an HTTPS site address to its origin", () => {
		expect(normalizeSiteOrigin("cms.example.com/_emdash/admin")).toBe("https://cms.example.com");
	});

	it("allows local HTTP development sites", () => {
		expect(normalizeSiteOrigin("http://localhost:4321/example")).toBe("http://localhost:4321");
	});

	it("rejects insecure remote sites and URLs containing credentials", () => {
		expect(normalizeSiteOrigin("http://cms.example.com")).toBeUndefined();
		expect(normalizeSiteOrigin("https://user:secret@cms.example.com")).toBeUndefined();
	});

	it("rejects site addresses that are too long to persist safely", () => {
		expect(normalizeSiteOrigin(`https://${"a".repeat(2_048)}.example`)).toBeUndefined();
	});

	it("builds an encoded admin registry detail URL", () => {
		expect(pluginAdminUrl("https://cms.example.com", "@plugins.example.com", "contact-form")).toBe(
			"https://cms.example.com/_emdash/admin/plugins/registry/%40plugins.example.com/contact-form",
		);
	});
});
