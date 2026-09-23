import { experimental_AstroContainer as AstroContainer } from "astro/container";
// @ts-ignore - virtual module
import { componentDataByCssVariable } from "virtual:astro:assets/fonts/internal";
import { afterEach, describe, expect, it } from "vitest";

import AdminPage from "../../src/astro/routes/admin.astro";

// client:only islands never render server-side, so a stand-in renderer is enough.
const fakeReactRenderer = {
	name: "@astrojs/react",
	check: () => false,
	renderToStaticMarkup: () => ({ html: "" }),
};

async function renderAdmin() {
	const container = await AstroContainer.create();
	container.addServerRenderer({ name: "@astrojs/react", renderer: fakeReactRenderer });
	container.addClientRenderer({ name: "@astrojs/react", entrypoint: "@astrojs/react/client.js" });
	return container.renderToString(AdminPage, { locals: {} });
}

describe("admin shell fonts", () => {
	afterEach(() => {
		componentDataByCssVariable.delete("--font-emdash");
	});

	it("renders when no font family is registered", async () => {
		const html = await renderAdmin();

		expect(html).toContain('id="admin-root"');
	});

	it("includes the registered admin font", async () => {
		componentDataByCssVariable.set("--font-emdash", {
			preloads: [],
			css: "@font-face{font-family:EmDashTestFont}",
		});

		const html = await renderAdmin();

		expect(html).toContain('id="admin-root"');
		expect(html).toContain("@font-face{font-family:EmDashTestFont}");
	});
});
