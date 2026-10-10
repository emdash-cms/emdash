import { describe, expect, it } from "vitest";

import { withoutInvalidAddresses } from "../src/admin-api.js";
import { type Config, configSchema } from "../src/config.js";
import { config } from "./fakes.js";

function withAuthors(base: Config, authors: Partial<Config["sources"][string]>): Config {
	return {
		...base,
		sources: { ...base.sources, _authors: { ...base.sources._authors!, ...authors } },
	};
}

describe("withoutInvalidAddresses", () => {
	it("makes a draft savable after a source with an unfinished address is skipped", () => {
		const saved = config();
		const draft = withAuthors(saved, { enabled: false, urlTemplate: "/people" });
		expect(configSchema.safeParse(draft).success).toBe(false);

		const result = withoutInvalidAddresses(draft, saved);

		expect(configSchema.safeParse(result).success).toBe(true);
		expect(result.sources._authors).toMatchObject({
			enabled: false,
			urlTemplate: "/authors/{slug}",
		});
	});

	it("drops an unfinished address when there is no saved one to go back to", () => {
		const saved = withAuthors(config(), { urlTemplate: undefined });
		const draft = withAuthors(saved, { enabled: false, urlTemplate: "" });

		const result = withoutInvalidAddresses(draft, saved);

		expect(configSchema.safeParse(result).success).toBe(true);
		expect(result.sources._authors?.urlTemplate).toBeUndefined();
	});

	it("keeps the address of an included source for the server to check", () => {
		const draft = withAuthors(config(), { enabled: true, urlTemplate: "/people" });

		expect(withoutInvalidAddresses(draft, config()).sources._authors?.urlTemplate).toBe("/people");
	});
});
