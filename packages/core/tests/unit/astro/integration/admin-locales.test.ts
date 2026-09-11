import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
	createAdminLocaleResolverPlugin,
	getAdminLocaleCodes,
	resolveAdminDist,
	resolveAdminSource,
	validateAdminLocales,
} from "../../../../src/astro/integration/admin-locales.js";

const adminDistPath = resolveAdminDist();
const projectRoot = resolve(import.meta.dirname, "../../../../../demos/simple/");
const adminSourcePath = resolveAdminSource(projectRoot);
const knownCodes = getAdminLocaleCodes(adminDistPath);

const LOCALE_LOADERS_ENTRY_RE =
	/"\.\/([a-zA-Z0-9-]+)\/messages\.mjs":\s*\(\)\s*=>\s*import\("\.\/messages-([A-Za-z0-9_-]+)\.js"\)/g;

function findNonDefaultChunk(): { hash: string; locale: string; defaultChunk: string } | undefined {
	let defaultChunk: string | undefined;
	let firstNonDefault: { hash: string; locale: string } | undefined;

	for (const file of readdirSync(adminDistPath)) {
		if (!file.endsWith(".js") || file.endsWith(".map")) continue;
		const content = readFileSync(resolve(adminDistPath, file), "utf8");
		if (!content.includes("LOCALE_LOADERS")) continue;

		for (const match of content.matchAll(LOCALE_LOADERS_ENTRY_RE)) {
			const locale = match[1]!;
			const hash = match[2]!;
			if (locale === "en") {
				defaultChunk = `messages-${hash}.js`;
			} else if (!firstNonDefault) {
				firstNonDefault = { hash, locale };
			}
		}

		// Only one chunk contains the loader map.
		break;
	}

	if (!defaultChunk || !firstNonDefault) return undefined;
	return { ...firstNonDefault, defaultChunk };
}

describe("getAdminLocaleCodes", () => {
	it("includes the source locale and known enabled locales", () => {
		expect(knownCodes.has("en")).toBe(true);
		expect(knownCodes.has("de")).toBe(true);
		expect(knownCodes.size).toBeGreaterThan(1);
	});
});

describe("validateAdminLocales", () => {
	it("returns undefined when no allowlist is configured", () => {
		expect(validateAdminLocales(undefined, knownCodes)).toBeUndefined();
	});

	it("returns canonicalized locale codes", () => {
		expect(validateAdminLocales(["en", "de"], knownCodes)).toEqual(["en", "de"]);
	});

	it("canonicalizes case", () => {
		expect(validateAdminLocales(["en", "en-gb"], knownCodes)).toEqual(["en", "en-GB"]);
	});

	it("rejects unknown codes", () => {
		expect(() => validateAdminLocales(["en", "xx"], knownCodes)).toThrow("Unknown admin locale");
	});

	it("rejects empty entries", () => {
		expect(() => validateAdminLocales(["en", ""], knownCodes)).toThrow("non-empty");
	});

	it("rejects invalid BCP 47 tags", () => {
		expect(() => validateAdminLocales(["en", "!!!"], knownCodes)).toThrow("Invalid locale code");
	});

	it("rejects non-arrays", () => {
		expect(() => validateAdminLocales("en", knownCodes)).toThrow("must be an array");
	});

	it("rejects an empty array", () => {
		expect(() => validateAdminLocales([], knownCodes)).toThrow("cannot be empty");
	});

	it("requires the source locale", () => {
		expect(() => validateAdminLocales(["de"], knownCodes)).toThrow(
			"must include the source locale",
		);
	});

	it("deduplicates entries", () => {
		expect(validateAdminLocales(["en", "de", "en"], knownCodes)).toEqual(["en", "de"]);
	});
});

describe("createAdminLocaleResolverPlugin source-mode resolution", () => {
	it("returns null for the default locale", () => {
		const plugin = createAdminLocaleResolverPlugin({
			adminDistPath,
			adminSourcePath,
			locales: ["en"],
		});

		expect(plugin.resolveId!("./en/messages.mjs", adminSourcePath!)).toBeUndefined();
	});

	it("returns null for allowed source locales", () => {
		const plugin = createAdminLocaleResolverPlugin({
			adminDistPath,
			adminSourcePath,
			locales: ["en", "de"],
		});

		expect(plugin.resolveId!("./de/messages.mjs", adminSourcePath!)).toBeUndefined();
	});

	it("redirects disallowed source locales to the default catalog", () => {
		const plugin = createAdminLocaleResolverPlugin({
			adminDistPath,
			adminSourcePath,
			locales: ["en"],
		});

		expect(plugin.resolveId!("./de/messages.mjs", adminSourcePath!)).toBe(
			resolve(adminDistPath, "locales", "en", "messages.mjs"),
		);
	});
});

describe("createAdminLocaleResolverPlugin dist-mode resolution", () => {
	const found = findNonDefaultChunk();
	const itIfChunk = found ? it : it.skip;

	itIfChunk("redirects disallowed hashed chunks to the default chunk", () => {
		const plugin = createAdminLocaleResolverPlugin({
			adminDistPath,
			locales: ["en"],
		});

		const importer = resolve(adminDistPath, "LocaleDirectionProvider-PLACEHOLDER.js");
		expect(plugin.resolveId!(`./messages-${found!.hash}.js`, importer)).toBe(
			resolve(adminDistPath, found!.defaultChunk),
		);
	});

	itIfChunk("returns null for allowed hashed chunks", () => {
		const plugin = createAdminLocaleResolverPlugin({
			adminDistPath,
			locales: ["en", found!.locale],
		});

		const importer = resolve(adminDistPath, "LocaleDirectionProvider-PLACEHOLDER.js");
		expect(plugin.resolveId!(`./messages-${found!.hash}.js`, importer)).toBeUndefined();
	});
});

describe("runtime locale allowlist", () => {
	it("filters the admin supported locales from globalThis.__EMDASH_ADMIN_LOCALES__", async () => {
		const previous = globalThis.__EMDASH_ADMIN_LOCALES__;
		globalThis.__EMDASH_ADMIN_LOCALES__ = ["en"];
		try {
			// The admin locale config computes its lists at module load time, so
			// re-import after mutating the runtime global.
			// oxlint-disable-next-line typescript/await-thenable -- vi.resetModules returns Promise<void>
			await vi.resetModules();
			const adminLocales = await import("@emdash-cms/admin/locales");
			expect(adminLocales.SUPPORTED_LOCALES.map((l) => l.code)).toEqual(["en"]);
			expect(adminLocales.SUPPORTED_LOCALE_CODES.has("en")).toBe(true);
			expect(adminLocales.SUPPORTED_LOCALE_CODES.has("de")).toBe(false);
		} finally {
			globalThis.__EMDASH_ADMIN_LOCALES__ = previous;
			// oxlint-disable-next-line typescript/await-thenable -- vi.resetModules returns Promise<void>
			await vi.resetModules();
		}
	});
});
