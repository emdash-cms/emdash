import type { RegistryEntryData } from "@emdash-cms/registry-loader";
import { describe, expect, it } from "vitest";

import { pluginJsonLd, serializeJsonLd } from "./seo.js";

function entry(profile: Record<string, unknown>): RegistryEntryData {
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- partial registry fixture
	return {
		package: { did: "did:plc:publisher", slug: "contact-form", profile },
		latestRelease: { release: { version: "1.2.0" } },
	} as unknown as RegistryEntryData;
}

describe("plugin structured data", () => {
	it("keeps publisher text from closing the JSON-LD script", () => {
		const json = serializeJsonLd({ description: "</script><script>alert(1)</script>" });

		expect(json).not.toContain("</script");
		expect(JSON.parse(json)).toEqual({ description: "</script><script>alert(1)</script>" });
	});

	it("describes the plugin with only safe publisher links", () => {
		const data = pluginJsonLd(
			entry({
				name: "Contact Form",
				license: "MIT",
				authors: [
					{ name: "Ada", url: "https://ada.example" },
					{ name: "Eve", url: "javascript:alert(1)" },
				],
			}),
			"https://plugins.emdashcms.com/plugins/@example.com/contact-form",
			{ dateModified: new Date("2026-09-01T10:00:00Z") },
		);

		expect(data).toMatchObject({
			"@type": "SoftwareApplication",
			name: "Contact Form",
			softwareVersion: "1.2.0",
			license: "MIT",
			dateModified: "2026-09-01T10:00:00.000Z",
			author: [
				{ "@type": "Person", name: "Ada", url: "https://ada.example/" },
				{ "@type": "Person", name: "Eve", url: undefined },
			],
		});
	});

	it("omits modification dates in the future", () => {
		const data = pluginJsonLd(
			entry({ name: "Contact Form" }),
			"https://plugins.emdashcms.com/plugins/@example.com/contact-form",
			{ dateModified: new Date(Date.now() + 86_400_000) },
		);

		expect(data.dateModified).toBeUndefined();
	});
});
