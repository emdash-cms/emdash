import { afterEach, beforeEach, expect, it } from "vitest";
import { page } from "vitest/browser";

import "../dist/styles.css";

let theme: HTMLStyleElement;
let root: HTMLDivElement;

beforeEach(() => {
	theme = document.createElement("style");
	theme.textContent = `@layer theme {
		body { background-color: rgb(12, 34, 56); color: rgb(210, 220, 230); }
		[role="dialog"] { position: fixed; inset: 0; width: 100vw; }
	}`;
	document.head.append(theme);
	root = document.createElement("div");
	document.body.append(root);
});

afterEach(async () => {
	theme.remove();
	root.remove();
	await page.viewport(1280, 800);
});

it("preserves a public theme's layered body colors when admin CSS is loaded", () => {
	expect(getComputedStyle(document.body).backgroundColor).toBe("rgb(12, 34, 56)");
	expect(getComputedStyle(document.body).color).toBe("rgb(210, 220, 230)");
});

it("preserves a public full-width mobile dialog when admin CSS is loaded", async () => {
	await page.viewport(375, 800);
	const dialog = document.createElement("div");
	dialog.setAttribute("role", "dialog");
	root.append(dialog);
	expect(dialog.getBoundingClientRect().width).toBe(375);
});

it("keeps portaled admin dialogs within the mobile viewport", async () => {
	await page.viewport(375, 800);
	root.id = "admin-root";
	const portal = document.createElement("div");
	const dialog = document.createElement("div");
	dialog.setAttribute("role", "dialog");
	dialog.style.minWidth = "512px";
	portal.append(dialog);
	document.body.append(portal);
	try {
		expect(dialog.getBoundingClientRect().width).toBe(343);
	} finally {
		portal.remove();
	}
});
