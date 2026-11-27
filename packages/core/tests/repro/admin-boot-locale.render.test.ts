import type { Messages } from "@lingui/core";
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { afterEach, describe, expect, it, vi } from "vitest";

const catalogOverrides = new Map<string, Messages>();

vi.mock("@emdash-cms/admin/locales", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@emdash-cms/admin/locales")>();
	return {
		...actual,
		loadMessages: async (locale: string) =>
			catalogOverrides.get(locale) ?? (await actual.loadMessages(locale)),
	};
});

import AdminPage from "../../src/astro/routes/admin.astro";

// client:only islands never render server-side, so a stand-in renderer is enough.
const fakeReactRenderer = {
	name: "@astrojs/react",
	check: () => false,
	renderToStaticMarkup: () => ({ html: "" }),
};

async function renderAdmin(options?: {
	acceptLanguage?: string;
	siteName?: string;
}): Promise<string> {
	const container = await AstroContainer.create();
	container.addServerRenderer({ name: "@astrojs/react", renderer: fakeReactRenderer });
	container.addClientRenderer({ name: "@astrojs/react", entrypoint: "@astrojs/react/client.js" });
	const headers = new Headers();
	if (options?.acceptLanguage) {
		headers.set("accept-language", options.acceptLanguage);
	}
	return container.renderToString(AdminPage, {
		request: new Request("https://example.com/_emdash/admin/", { headers }),
		locals: options?.siteName
			? { emdash: { config: { admin: { siteName: options.siteName } } } }
			: {},
	});
}

function extractBootLoaderText(html: string): string | undefined {
	const match = html.match(/id="emdash-boot-loader"[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/);
	return match?.[1];
}

describe("admin boot shell localization", () => {
	afterEach(() => {
		catalogOverrides.clear();
	});

	it("renders localized title and boot loader text from the resolved locale catalog", async () => {
		catalogOverrides.set("es-419", {
			"adminShell.pageTitle": ["Administración de ", ["siteName"]],
			"adminShell.loading": ["Cargando ", ["siteName"], "..."],
		});

		const html = await renderAdmin({ acceptLanguage: "es-419", siteName: "Acme" });

		expect(html).toContain('lang="es-419"');
		expect(html).toContain('dir="ltr"');
		expect(html).toContain("<title>Administración de Acme</title>");
		expect(extractBootLoaderText(html)).toBe("Cargando Acme...");
	});

	it("renders RTL locale strings and falls back to EmDash when siteName is omitted", async () => {
		catalogOverrides.set("ar", {
			"adminShell.pageTitle": ["لوحة تحكم ", ["siteName"]],
			"adminShell.loading": ["جارٍ تحميل ", ["siteName"], "..."],
		});

		const html = await renderAdmin({ acceptLanguage: "ar" });

		expect(html).toContain('lang="ar"');
		expect(html).toContain('dir="rtl"');
		expect(html).toContain("<title>لوحة تحكم EmDash</title>");
		expect(extractBootLoaderText(html)).toBe("جارٍ تحميل EmDash...");
	});

	it("interpolates siteName in the English fallback when keys are missing from the catalog", async () => {
		catalogOverrides.set("fr", {});

		const html = await renderAdmin({ acceptLanguage: "fr", siteName: "Mon Site" });

		expect(html).toContain('lang="fr"');
		expect(html).toContain("<title>Mon Site Admin</title>");
		expect(extractBootLoaderText(html)).toBe("Loading Mon Site...");
	});
});
