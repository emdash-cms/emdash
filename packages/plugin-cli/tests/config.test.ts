import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_AGGREGATOR_URL, resolveAggregatorUrl } from "../src/config.js";

const ORIGINAL_ENV = process.env["EMDASH_REGISTRY_URL"];

describe("resolveAggregatorUrl", () => {
	afterEach(() => {
		// Restore the env var if a test mutated it.
		if (ORIGINAL_ENV === undefined) {
			delete process.env["EMDASH_REGISTRY_URL"];
		} else {
			process.env["EMDASH_REGISTRY_URL"] = ORIGINAL_ENV;
		}
	});

	it("prefers an explicit flag over the env var and default", () => {
		process.env["EMDASH_REGISTRY_URL"] = "https://from-env.test";
		expect(resolveAggregatorUrl("https://from-flag.test")).toBe("https://from-flag.test");
	});

	it("falls back to the env var when no flag is given", () => {
		process.env["EMDASH_REGISTRY_URL"] = "https://from-env.test";
		expect(resolveAggregatorUrl()).toBe("https://from-env.test");
		expect(resolveAggregatorUrl("")).toBe("https://from-env.test");
	});

	it("falls back to the experimental default when neither flag nor env var is set", () => {
		delete process.env["EMDASH_REGISTRY_URL"];
		expect(resolveAggregatorUrl()).toBe(DEFAULT_AGGREGATOR_URL);
	});

	it("treats an empty env var as unset", () => {
		process.env["EMDASH_REGISTRY_URL"] = "";
		expect(resolveAggregatorUrl()).toBe(DEFAULT_AGGREGATOR_URL);
	});
});
