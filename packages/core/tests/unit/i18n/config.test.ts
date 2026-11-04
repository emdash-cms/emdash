import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(async () => {
	const { setI18nConfig } = await import("../../../src/i18n/config.js");
	setI18nConfig(null);
	vi.resetModules();
});

describe("i18n config", () => {
	it.each(["en-US", "EN-us", "en"])(
		"resolves %s to the configured path casing when an alias target differs in case",
		async (locale) => {
			const { resolveContentCreateLocale, setI18nConfig } =
				await import("../../../src/i18n/config.js");
			const { resolveLocale } = await import("../../../src/i18n/resolve.js");
			const config = {
				defaultLocale: "es-MX",
				locales: ["es-MX", "En"],
				localeAliases: { "en-US": "en" },
			};

			expect(resolveContentCreateLocale(locale, config)).toBe("En");
			setI18nConfig(config);
			expect(resolveLocale(locale)).toBe("En");
		},
	);

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
