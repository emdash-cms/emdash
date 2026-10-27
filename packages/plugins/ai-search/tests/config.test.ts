import { describe, expect, it } from "vitest";

import { configSchema } from "../src/config.js";
import { config } from "./fakes.js";

function withAuthorTemplate(urlTemplate: string) {
	const base = config();
	return {
		...base,
		sources: { ...base.sources, _authors: { enabled: true, fields: [], urlTemplate, weight: 2 } },
	};
}

describe("configSchema", () => {
	it("accepts a site path containing {slug}", () => {
		expect(configSchema.safeParse(withAuthorTemplate("/people/{slug}/")).success).toBe(true);
	});

	it.each([
		"javascript:alert(1)//{slug}",
		"//evil.example/{slug}",
		"https://evil.example/{slug}",
		"/authors/",
		"/authors/{slug}?ref=search",
		'/authors/{slug}"><script>',
		"/authors/{id}/{slug}",
	])("rejects %s as an author page address", (urlTemplate) => {
		expect(configSchema.safeParse(withAuthorTemplate(urlTemplate)).success).toBe(false);
	});
});
