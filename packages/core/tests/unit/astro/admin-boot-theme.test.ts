import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

import { describe, expect, it } from "vitest";

const adminRouteUrl = new URL("../../../src/astro/routes/admin.astro", import.meta.url);

async function readAdminRoute() {
	return readFile(adminRouteUrl, "utf8");
}

async function runThemeScript(storedPreference: string | null, systemDark: boolean) {
	const source = await readAdminRoute();
	const script = source.match(/<script is:inline>([\s\S]*?)<\/script>/)?.[1];
	let appliedMode: string | undefined;

	expect(script).toBeDefined();
	runInNewContext(script!, {
		localStorage: {
			getItem: () => storedPreference,
		},
		window: {
			matchMedia: () => ({ matches: systemDark }),
		},
		document: {
			documentElement: {
				setAttribute: (name: string, value: string) => {
					if (name === "data-mode") appliedMode = value;
				},
			},
		},
	});

	return appliedMode;
}

describe("admin boot loader theme", () => {
	it("runs the theme bootstrap before the admin stylesheet can paint", async () => {
		const source = await readAdminRoute();
		const themeScriptIndex = source.indexOf("emdash-theme");
		const stylesheetIndex = source.indexOf('<link rel="stylesheet"');

		expect(themeScriptIndex).toBeGreaterThan(-1);
		expect(themeScriptIndex).toBeLessThan(stylesheetIndex);
	});

	it.each([
		["dark", false, "dark"],
		["light", true, "light"],
		["system", true, "dark"],
		["system", false, "light"],
		[null, true, "dark"],
	] as const)(
		"resolves stored preference %s with system dark %s to %s",
		async (stored, systemDark, expected) => {
			await expect(runThemeScript(stored, systemDark)).resolves.toBe(expected);
		},
	);

	it("uses Kumo semantic tokens instead of raw colors", async () => {
		const source = await readAdminRoute();
		const loaderStyles = source.match(/#emdash-boot-loader \{[\s\S]*?<\/style>/)?.[0];

		expect(loaderStyles).toBeDefined();
		expect(loaderStyles).toContain("var(--color-kumo-elevated)");
		expect(loaderStyles).toContain("var(--text-color-kumo-subtle)");
		expect(loaderStyles).not.toContain("hsl(");
		expect(loaderStyles).not.toContain("light-dark(");
	});
});
