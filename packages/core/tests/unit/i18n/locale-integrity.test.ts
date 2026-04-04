import { readdirSync, readFileSync } from "node:fs";
import { resolve, basename } from "node:path";

import { describe, expect, it } from "vitest";

const LOCALES_DIR = resolve(__dirname, "../../../../admin/src/i18n/locales");
const DEFAULT_LOCALE = "en";
const BARREL_EXPORT_RE = /export \{ default as (\w+) \}/g;

/** Read and parse a JSON file from the locales directory. */
function readLocaleFile(locale: string, namespace: string): Record<string, string> {
	const filePath = resolve(LOCALES_DIR, locale, `${namespace}.json`);
	return JSON.parse(readFileSync(filePath, "utf-8"));
}

/** Get all locale codes (subdirectories of locales/). */
function getLocales(): string[] {
	return readdirSync(LOCALES_DIR, { withFileTypes: true })
		.filter((d) => d.isDirectory())
		.map((d) => d.name);
}

/** Get all namespace filenames (without extension) for a locale. */
function getNamespaces(locale: string): string[] {
	return readdirSync(resolve(LOCALES_DIR, locale))
		.filter((f) => f.endsWith(".json"))
		.map((f) => basename(f, ".json"));
}

describe("i18n locale integrity", () => {
	const locales = getLocales();
	const defaultNamespaces = getNamespaces(DEFAULT_LOCALE);

	it("has at least one non-default locale", () => {
		expect(locales.filter((l) => l !== DEFAULT_LOCALE).length).toBeGreaterThan(0);
	});

	for (const locale of locales) {
		if (locale === DEFAULT_LOCALE) continue;

		describe(`${locale}`, () => {
			it("has the same namespace files as the default locale", () => {
				const localeNamespaces = getNamespaces(locale);
				expect(localeNamespaces.toSorted()).toEqual(defaultNamespaces.toSorted());
			});

			for (const ns of defaultNamespaces) {
				it(`${ns}.json has the same keys as ${DEFAULT_LOCALE}/${ns}.json`, () => {
					const defaultKeys = Object.keys(readLocaleFile(DEFAULT_LOCALE, ns)).toSorted();
					const localeKeys = Object.keys(readLocaleFile(locale, ns)).toSorted();

					const missing = defaultKeys.filter((k) => !localeKeys.includes(k));
					const extra = localeKeys.filter((k) => !defaultKeys.includes(k));

					if (missing.length > 0) {
						expect.fail(`${locale}/${ns}.json is missing keys: ${missing.join(", ")}`);
					}
					if (extra.length > 0) {
						expect.fail(
							`${locale}/${ns}.json has extra keys not in ${DEFAULT_LOCALE}: ${extra.join(", ")}`,
						);
					}
				});
			}
		});
	}

	describe("barrel export", () => {
		it("locales/en/index.ts exports all namespace files", () => {
			const barrelPath = resolve(LOCALES_DIR, DEFAULT_LOCALE, "index.ts");
			const barrelContent = readFileSync(barrelPath, "utf-8");

			for (const ns of defaultNamespaces) {
				expect(barrelContent).toContain(`export { default as ${ns} } from "./${ns}.json"`);
			}
		});

		it("locales/en/index.ts has no extra exports beyond namespace files", () => {
			const barrelPath = resolve(LOCALES_DIR, DEFAULT_LOCALE, "index.ts");
			const barrelContent = readFileSync(barrelPath, "utf-8");
			const exportMatches = barrelContent.match(BARREL_EXPORT_RE) ?? [];

			expect(exportMatches.length).toBe(defaultNamespaces.length);
		});
	});
});
