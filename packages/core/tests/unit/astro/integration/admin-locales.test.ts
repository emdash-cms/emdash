import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	type AdminLocaleManifest,
	createAdminLocaleResolverPlugin,
	readAdminLocaleManifest,
	resolveAdminLocales,
} from "../../../../src/astro/integration/admin-locales.js";
import { resolveAdminDist } from "../../../../src/astro/integration/vite-config.js";

// Vite/Rollup type hook fields as `T | { handler: T }`; this plugin uses the plain form.
function unwrapHook<T>(hook: T | { handler: T } | null | undefined): T {
	if (hook == null) throw new Error("Hook is not defined");
	if (typeof hook === "object" && "handler" in hook) return hook.handler;
	return hook;
}

describe("readAdminLocaleManifest", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "emdash-admin-locales-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	function writeManifest(contents: string) {
		writeFileSync(join(dir, "locales-manifest.json"), contents);
	}

	it("maps every catalog the installed admin package ships, including en", () => {
		const manifest = readAdminLocaleManifest(resolveAdminDist());
		expect(Object.keys(manifest)).toEqual(
			expect.arrayContaining(["en", "de", "sr-Latn", "es-419"]),
		);
	});

	it("throws when the manifest is missing", () => {
		expect(() => readAdminLocaleManifest(dir)).toThrow(
			/admin locale manifest .* could not be read/,
		);
	});

	it("throws when the manifest is not JSON", () => {
		writeManifest("not json");
		expect(() => readAdminLocaleManifest(dir)).toThrow(/could not be read/);
	});

	it.each([
		["a non-object", "[]"],
		["no locales map", "{}"],
		["non-string chunk names", JSON.stringify({ locales: { en: 1 } })],
		["no en catalog", JSON.stringify({ locales: { de: "messages-de.js" } })],
	])("throws when the manifest has %s", (_label, contents) => {
		writeManifest(contents);
		expect(() => readAdminLocaleManifest(dir)).toThrow(/admin locale manifest .* is invalid/);
	});

	it("throws when a listed chunk does not exist", () => {
		writeFileSync(join(dir, "messages-en.js"), "");
		writeManifest(JSON.stringify({ locales: { en: "messages-en.js", de: "messages-de.js" } }));
		expect(() => readAdminLocaleManifest(dir)).toThrow(
			'lists "messages-de.js" for "de", but that file does not exist',
		);
	});
});

describe("resolveAdminLocales", () => {
	const available = ["en", "de", "en-GB", "es-419", "sr-Latn", "pt-BR"];

	it("adds en when it is not listed", () => {
		expect(resolveAdminLocales(["de"], available)).toEqual(["en", "de"]);
	});

	it("resolves an empty list to en", () => {
		expect(resolveAdminLocales([], available)).toEqual(["en"]);
	});

	it("puts en first and drops duplicates", () => {
		expect(resolveAdminLocales(["de", "en", "de"], available)).toEqual(["en", "de"]);
	});

	it("matches codes regardless of case and whitespace, returning the admin's codes", () => {
		expect(resolveAdminLocales(["EN-gb", " sr-latn ", "es-419"], available)).toEqual([
			"en",
			"en-GB",
			"sr-Latn",
			"es-419",
		]);
	});

	it("names every unknown code and lists the available codes", () => {
		expect(() => resolveAdminLocales(["de", "xx", "!!!", "fr"], available)).toThrow(
			'Unknown admin locales in `admin.locales`: "xx", "!!!", "fr". ' +
				"Available locales: de, en, en-GB, es-419, pt-BR, sr-Latn.",
		);
	});

	it("rejects a value that is not an array", () => {
		expect(() => resolveAdminLocales("de", available)).toThrow("must be an array");
	});
});

describe("createAdminLocaleResolverPlugin", () => {
	const manifest: AdminLocaleManifest = {
		en: "messages-en.js",
		de: "messages-de.js",
		fr: "messages-fr.js",
		"sr-Latn": "messages-sr.js",
	};

	function resolveWith(
		options: { adminDistPath: string; adminSourcePath?: string; locales: string[] },
		source: string,
		importer: string,
	) {
		const plugin = createAdminLocaleResolverPlugin({ ...options, manifest });
		const resolveId = unwrapHook(plugin.resolveId);
		// eslint-disable-next-line typescript/no-unsafe-type-assertion -- the hook does not use its Rollup context.
		return resolveId.call({} as never, source, importer, { attributes: {}, isEntry: false });
	}

	describe("with the built admin package", () => {
		const adminDistPath = "/site/node_modules/@emdash-cms/admin/dist";
		const importer = `${adminDistPath}/loadMessages-abc.js`;
		const options = { adminDistPath, locales: ["en", "de"] };

		it("resolves an excluded catalog chunk to the en chunk", () => {
			expect(resolveWith(options, "./messages-fr.js", importer)).toBe(
				`${adminDistPath}/messages-en.js`,
			);
			expect(resolveWith(options, "./messages-sr.js", importer)).toBe(
				`${adminDistPath}/messages-en.js`,
			);
		});

		it("leaves listed catalog chunks alone", () => {
			expect(resolveWith(options, "./messages-de.js", importer)).toBeUndefined();
			expect(resolveWith(options, "./messages-en.js", importer)).toBeUndefined();
		});

		it("leaves other imports alone", () => {
			expect(resolveWith(options, "./index.js", importer)).toBeUndefined();
			expect(resolveWith(options, "./messages-fr.js", "/site/src/pages/index.js")).toBeUndefined();
			expect(resolveWith(options, "react", importer)).toBeUndefined();
		});

		it("strips query and hash before matching hashed chunk imports", () => {
			expect(resolveWith(options, "./messages-fr.js?v=abc", importer)).toBe(
				`${adminDistPath}/messages-en.js`,
			);
			expect(resolveWith(options, "./messages-fr.js#polyfill", importer)).toBe(
				`${adminDistPath}/messages-en.js`,
			);
		});

		it("matches a Windows dist path against Vite's forward-slash importer", () => {
			const windowsOptions = {
				adminDistPath: "C:\\site\\node_modules\\@emdash-cms\\admin\\dist",
				locales: ["en"],
			};
			expect(
				resolveWith(
					windowsOptions,
					"./messages-fr.js",
					"C:/site/node_modules/@emdash-cms/admin/dist/loadMessages-abc.js",
				),
			).toBe("C:/site/node_modules/@emdash-cms/admin/dist/messages-en.js");
		});
	});

	describe("with the admin source in dev", () => {
		const adminDistPath = "/repo/packages/admin/dist";
		const adminSourcePath = "/repo/packages/admin/src";
		const importer = `${adminSourcePath}/locales/loadMessages.ts`;
		const options = { adminDistPath, adminSourcePath, locales: ["en", "de"] };

		it("resolves an excluded source catalog to the compiled en catalog", () => {
			expect(resolveWith(options, "./fr/messages.mjs", importer)).toBe(
				`${adminDistPath}/locales/en/messages.mjs`,
			);
			expect(resolveWith(options, "./sr-Latn/messages.mjs", importer)).toBe(
				`${adminDistPath}/locales/en/messages.mjs`,
			);
		});

		it("leaves listed source catalogs alone", () => {
			expect(resolveWith(options, "./de/messages.mjs", importer)).toBeUndefined();
			expect(resolveWith(options, "./en/messages.mjs", importer)).toBeUndefined();
		});

		it("strips query and hash before matching source catalog imports", () => {
			expect(resolveWith(options, "./fr/messages.mjs?import", importer)).toBe(
				`${adminDistPath}/locales/en/messages.mjs`,
			);
			expect(resolveWith(options, "./fr/messages.mjs#t=1", importer)).toBe(
				`${adminDistPath}/locales/en/messages.mjs`,
			);
		});
	});
});

describe("admin locale runtime config", () => {
	afterEach(async () => {
		vi.unstubAllGlobals();
		// oxlint-disable-next-line typescript/await-thenable -- vi.resetModules returns Promise<void>
		await vi.resetModules();
	});

	async function importLocaleConfig() {
		// oxlint-disable-next-line typescript/await-thenable -- vi.resetModules returns Promise<void>
		await vi.resetModules();
		return import("@emdash-cms/admin/locales/config");
	}

	it("applies no allowlist when loaded without the Vite define", async () => {
		const { SUPPORTED_LOCALE_CODES, resolveLocale } = await importLocaleConfig();
		expect(SUPPORTED_LOCALE_CODES.has("en")).toBe(true);
		expect(SUPPORTED_LOCALE_CODES.has("de")).toBe(true);
		expect(SUPPORTED_LOCALE_CODES.has("ja")).toBe(true);
		const request = new Request("https://example.com", { headers: { "accept-language": "fr" } });
		expect(resolveLocale(request)).toBe("fr");
	});

	it("applies no allowlist when the define is null", async () => {
		vi.stubGlobal("__EMDASH_ADMIN_LOCALES__", null);
		const { SUPPORTED_LOCALE_CODES } = await importLocaleConfig();
		expect(SUPPORTED_LOCALE_CODES.has("de")).toBe(true);
		expect(SUPPORTED_LOCALE_CODES.has("ja")).toBe(true);
	});

	it("offers only the allowlisted locales when the define is set", async () => {
		vi.stubGlobal("__EMDASH_ADMIN_LOCALES__", ["en", "de"]);
		const { SUPPORTED_LOCALES, resolveLocale } = await importLocaleConfig();
		expect(SUPPORTED_LOCALES.map((locale) => locale.code)).toEqual(["en", "de"]);
		const french = new Request("https://example.com", { headers: { "accept-language": "fr" } });
		expect(resolveLocale(french)).toBe("en");
		const german = new Request("https://example.com", { headers: { "accept-language": "de" } });
		expect(resolveLocale(german)).toBe("de");
	});
});
