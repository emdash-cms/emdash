import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { describe, expect, it } from "vitest";

import AdminPage from "../../src/astro/routes/admin.astro";

// admin.astro renders AdminWrapper with client:only="react" - Astro only
// needs a renderer registered under a matching name to emit the hydration
// island (client:only never calls check/renderToStaticMarkup server-side),
// so a minimal stand-in is enough here without pulling in real React SSR.
const fakeReactRenderer = {
	name: "@astrojs/react",
	check: () => false,
	renderToStaticMarkup: () => ({ html: "" }),
};

describe("admin shell with no fonts registered", () => {
	it("renders instead of throwing FontFamilyNotFound", async () => {
		// No fonts are configured for this container (mirrors `fonts: false`
		// in the emdash() integration option, which injects an empty fonts
		// array into Astro's config). Before the fix, admin.astro rendered
		// <Font cssVariable="--font-emdash" /> unconditionally, and Astro's
		// Font component throws AstroError(FontFamilyNotFound) when no family
		// is registered for that cssVariable -- which happens mid-stream,
		// after the response has already started, producing a 200 with a
		// completely empty body in production.
		const container = await AstroContainer.create();
		container.addServerRenderer({ name: "@astrojs/react", renderer: fakeReactRenderer });
		container.addClientRenderer({ name: "@astrojs/react", entrypoint: "@astrojs/react/client.js" });

		const html = await container.renderToString(AdminPage, { locals: {} });

		expect(html).toContain('id="admin-root"');
	});
});
