/**
 * Admin CSS isolation (#1281)
 *
 * The admin shell imports the compiled Kumo/Tailwind v4 stylesheet. In
 * `astro dev`, Astro injects every CSS module reachable from the project's
 * Vite graph into every page's <head>, so a top-level `import "...styles.css"`
 * in the admin route leaked the admin theme onto public, non-admin routes —
 * overriding host `:root` tokens (`--text-base`, `--text-lg`, ...) and applying
 * admin author styling to otherwise-unstyled pages.
 *
 * Importing the stylesheet as `?url` keeps it out of the page CSS graph and
 * scopes it to a route-local <link>. These tests pin both halves: the leak is
 * gone from public routes, and the admin route still pulls the stylesheet in.
 */

import { test, expect } from "../fixtures";

const TAILWIND_SIGNATURE = "tailwindcss v4";
const KUMO_SIGNATURE = "kumo";
const ADMIN_STYLESHEET_LINK = /<link[^>]+rel="stylesheet"[^>]+href="([^"]+)"/;

test.describe("admin CSS isolation", () => {
	test("public routes do not include the admin stylesheet", async ({ page }) => {
		await page.goto("/");

		const inlineStyles = await page.$$eval("style", (nodes) =>
			nodes.map((n) => n.textContent ?? ""),
		);
		const leaked = inlineStyles.find(
			(css) => css.includes(TAILWIND_SIGNATURE) && css.includes(KUMO_SIGNATURE),
		);
		expect(leaked, "admin Tailwind/Kumo theme leaked into a public route's inline <style>").toBe(
			undefined,
		);

		const linkedHrefs = await page.$$eval("link[rel='stylesheet']", (nodes) =>
			nodes.map((n) => n.getAttribute("href") ?? ""),
		);
		expect(linkedHrefs.some((href) => href.includes("admin"))).toBe(false);

		const textBase = await page.evaluate(() =>
			getComputedStyle(document.documentElement).getPropertyValue("--text-base").trim(),
		);
		expect(textBase, "Kumo's --text-base bled onto the host :root").toBe("");
	});

	test("admin route still loads the admin stylesheet", async ({ request }) => {
		const response = await request.get("/_emdash/admin");
		const html = await response.text();

		const match = html.match(ADMIN_STYLESHEET_LINK);
		expect(match, "admin shell is missing its <link rel=stylesheet>").not.toBeNull();

		const cssResponse = await request.get(match![1]!);
		const css = await cssResponse.text();
		expect(css).toContain(TAILWIND_SIGNATURE);
		expect(css).toContain(KUMO_SIGNATURE);
	});
});
