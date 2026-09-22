import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(async () => {
	const { setI18nConfig } = await import("../../../src/i18n/config.js");
	setI18nConfig(null);
	vi.resetModules();
});

describe("i18n config", () => {
	it("shares config across duplicated module instances", async () => {
		const writer = await import("../../../src/i18n/config.js");
		writer.setI18nConfig({ defaultLocale: "en", locales: ["en", "fr"] });

		vi.resetModules();
		const reader = await import("../../../src/i18n/config.js");

		expect(reader.getI18nConfig()).toEqual({
			defaultLocale: "en",
			locales: ["en", "fr"],
		});
		expect(reader.isI18nEnabled()).toBe(true);
	});
});
