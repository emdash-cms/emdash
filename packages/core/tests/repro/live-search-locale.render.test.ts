import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { describe, expect, it } from "vitest";

import LiveSearch from "../../src/components/LiveSearch.astro";

/**
 * The serialized config the client script reads. `locale` is sent as a query
 * parameter only when it is a non-empty string.
 */
async function renderConfig(props: Record<string, unknown>) {
	const container = await AstroContainer.create();
	const html = await container.renderToString(LiveSearch, { props, locals: {} });
	const match = html.match(/data-config="([^"]*)"/);
	if (!match) throw new Error("no data-config on the rendered component");
	const json = match[1].replaceAll("&#34;", '"').replaceAll("&quot;", '"');
	return JSON.parse(json) as { locale: string };
}

describe("LiveSearch locale", () => {
	it("sends no locale when the site has no i18n configuration", async () => {
		// The container has no `i18n` config, so `Astro.currentLocale` is
		// undefined — the same situation as a single-language site.
		expect((await renderConfig({})).locale).toBe("");
	});

	it("forwards an explicit locale", async () => {
		expect((await renderConfig({ locale: "fr" })).locale).toBe("fr");
	});

	it("sends no locale when passed null, so results span every locale", async () => {
		expect((await renderConfig({ locale: null })).locale).toBe("");
	});
});
