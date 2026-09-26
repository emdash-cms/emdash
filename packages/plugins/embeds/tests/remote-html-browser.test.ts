import type { Server } from "node:http";

import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import Gist from "../src/astro/Gist.astro";
import Mastodon from "../src/astro/Mastodon.astro";
import { startMaliciousServer, XSS } from "./malicious-remote.js";

let server: Server;
let origin: string;
let browser: Browser;

beforeAll(async () => {
	({ server, origin } = await startMaliciousServer());
	browser = await chromium.launch();
}, 60_000);

afterAll(async () => {
	await browser?.close();
	server?.close();
});

const ALERT_TRAP = `<script>window.__alerts=[];window.alert=(m)=>{window.__alerts.push(String(m))};</script>`;

async function openPage(html: string): Promise<Page> {
	const page = await browser.newPage({ javaScriptEnabled: true });
	await page.setContent(`<!doctype html><html><body>${ALERT_TRAP}${html}</body></html>`, {
		waitUntil: "load",
	});
	return page;
}

function firedAlerts(page: Page): Promise<string[]> {
	return page.evaluate(() => (window as unknown as { __alerts: string[] }).__alerts);
}

describe("embed payloads in a real browser", () => {
	it("detects execution for the unsanitized payload, so the assertions below can fail", async () => {
		const page = await openPage(
			`<astro-embed-mastodon><template shadowrootmode="open">${XSS}</template></astro-embed-mastodon>`,
		);
		await page.waitForFunction(
			() => (window as unknown as { __alerts: string[] }).__alerts.length > 0,
		);
		expect(await firedAlerts(page)).toContain("1");
		await page.close();
	}, 20_000);

	it("does not execute the payload from a sanitized Mastodon embed", async () => {
		const container = await AstroContainer.create();
		const html = await container.renderToString(Mastodon, {
			props: { node: { _type: "mastodon", _key: "m", id: `${origin}/@m/123` } },
		});
		const page = await openPage(html);
		await page.waitForTimeout(500);
		expect(await firedAlerts(page)).toEqual([]);
		const shadow = await page.evaluate(() => {
			const host = document.querySelector("astro-embed-mastodon");
			const root = host?.shadowRoot;
			return root
				? { text: root.textContent ?? "", scripts: root.querySelectorAll("script").length }
				: null;
		});
		expect(shadow).not.toBeNull();
		expect(shadow?.scripts).toBe(0);
		expect(shadow?.text).toContain("Mallory");
		await page.close();
	}, 20_000);

	it("does not execute the payload for a gist block pointing at a raw-file URL", async () => {
		const container = await AstroContainer.create();
		const html = await container.renderToString(Gist, {
			props: { node: { _type: "gist", _key: "g", id: `${origin}/gist` } },
		});
		const page = await openPage(html);
		await page.waitForTimeout(500);
		expect(await firedAlerts(page)).toEqual([]);
		await page.close();
	}, 20_000);
});
