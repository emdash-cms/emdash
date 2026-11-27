import type { ValidatedPackageView } from "@emdash-cms/registry-client/discovery";
import type { APIContext } from "astro";
import { describe, expect, it, vi } from "vitest";

import { GET } from "../pages/llms.txt.js";
import { searchCatalog } from "./catalog.js";

vi.mock("./catalog.js", () => ({ searchCatalog: vi.fn() }));

const context = { site: new URL("https://plugins.emdashcms.com") } as APIContext;

function plugin(fields: {
	slug: string;
	handle?: string;
	name?: string;
	description?: string;
	latestVersion?: string;
}): ValidatedPackageView {
	const { slug, handle, name, description, latestVersion } = fields;
	return {
		uri: `at://did:plc:${slug}/com.emdashcms.experimental.package.profile/${slug}`,
		did: `did:plc:${slug}`,
		slug,
		handle,
		latestVersion,
		profile: name || description ? { name, description } : null,
	} as unknown as ValidatedPackageView;
}

describe("llms.txt", () => {
	it("lists every plugin by name with a link to its page", async () => {
		vi.mocked(searchCatalog).mockResolvedValue({
			packages: [
				plugin({
					slug: "search-ping",
					handle: "example.com",
					name: "Search Ping",
					description: "Pings search engines\nwhen you publish.",
					latestVersion: "1.2.0",
				}),
				plugin({ slug: "forms", handle: "alice.dev", name: "Forms [beta]" }),
				plugin({
					slug: "contact-form",
					handle: "example.jp",
					name: "問い合わせフォーム",
					description: "問い合わせフォーム。",
				}),
			],
		});

		const response = await GET(context);
		const body = await response.text();

		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
		expect(body).toContain(
			"- [Forms \\[beta\\]](https://plugins.emdashcms.com/plugins/@alice.dev/forms): Published by @alice.dev.",
		);
		expect(body).toContain(
			"- [Search Ping](https://plugins.emdashcms.com/plugins/@example.com/search-ping): Pings search engines when you publish. Published by @example.com, v1.2.0.",
		);
		expect(body).toContain("問い合わせフォーム。 Published by @example.jp.");
		expect(body.indexOf("[Forms")).toBeLessThan(body.indexOf("[Search Ping]"));
	});

	it("answers 503 rather than a registry with no plugins when the registry fails", async () => {
		vi.mocked(searchCatalog).mockResolvedValue({
			error: new Error("Failed to search the registry: Bad Gateway"),
		});

		const response = await GET(context);

		expect(response.status).toBe(503);
		expect(response.headers.get("cache-control")).toBeNull();
	});
});
