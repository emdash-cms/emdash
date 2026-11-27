import { I18n } from "@lingui/core";
import { describe, expect, test, vi } from "vitest";

import { translateAdminShellStrings } from "../../src/locales/server.js";

describe("translateAdminShellStrings", () => {
	test("defaults to EmDash in English when siteName is omitted or blank", () => {
		expect(translateAdminShellStrings("en", {})).toEqual({
			pageTitle: "EmDash Admin",
			loading: "Loading EmDash...",
		});
		expect(translateAdminShellStrings("en", {}, "   ")).toEqual({
			pageTitle: "EmDash Admin",
			loading: "Loading EmDash...",
		});
	});

	test("interpolates a trimmed custom siteName", () => {
		expect(translateAdminShellStrings("en", {}, "  Acme  ")).toEqual({
			pageTitle: "Acme Admin",
			loading: "Loading Acme...",
		});
	});

	test("resolves compiled Lingui messages in LTR and RTL locales", () => {
		expect(
			translateAdminShellStrings(
				"es-419",
				{
					"adminShell.pageTitle": ["Administración de ", ["siteName"]],
					"adminShell.loading": ["Cargando ", ["siteName"], "..."],
				},
				"Gaucho en Red",
			),
		).toEqual({
			pageTitle: "Administración de Gaucho en Red",
			loading: "Cargando Gaucho en Red...",
		});

		expect(
			translateAdminShellStrings("ar", {
				"adminShell.pageTitle": ["لوحة تحكم ", ["siteName"]],
				"adminShell.loading": ["جارٍ تحميل ", ["siteName"], "..."],
			}),
		).toEqual({
			pageTitle: "لوحة تحكم EmDash",
			loading: "جارٍ تحميل EmDash...",
		});
	});

	test("falls back to the English source when catalog entries are missing", () => {
		expect(translateAdminShellStrings("fr", {}, "Mon Site")).toEqual({
			pageTitle: "Mon Site Admin",
			loading: "Loading Mon Site...",
		});
	});

	test("interpolates fallback strings without Lingui's runtime message compiler", () => {
		// Production builds omit Lingui's runtime ICU compiler; fallback defaults
		// must already be compiled so `{siteName}` interpolates with no warning.
		const compilerSpy = vi
			.spyOn(I18n.prototype, "setMessagesCompiler")
			.mockImplementation(function (this: I18n) {
				return this;
			});
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			expect(translateAdminShellStrings("fr", {}, "Mon Site")).toEqual({
				pageTitle: "Mon Site Admin",
				loading: "Loading Mon Site...",
			});
			expect(
				translateAdminShellStrings("es-419", {
					"adminShell.pageTitle": "",
					"adminShell.loading": [],
				}),
			).toEqual({
				pageTitle: "EmDash Admin",
				loading: "Loading EmDash...",
			});
			expect(warnSpy).not.toHaveBeenCalled();
		} finally {
			warnSpy.mockRestore();
			compilerSpy.mockRestore();
		}
	});
});
