import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { TestServerContext } from "../server.js";
import { assertNodeVersion, createTestServer } from "../server.js";

describe("menu names through Astro routing", () => {
	let ctx: TestServerContext;

	beforeAll(async () => {
		assertNodeVersion();
		ctx = await createTestServer({ port: 4407 });
	});

	afterAll(async () => {
		await ctx?.cleanup();
	});

	async function request<T>(path: string, method = "GET", data?: unknown): Promise<T> {
		const init: RequestInit = {
			method,
			headers: {
				Cookie: ctx.sessionCookie,
				"X-EmDash-Request": "1",
				"Content-Type": "application/json",
			},
		};
		if (data !== undefined) init.body = JSON.stringify(data);
		const response = await fetch(`${ctx.baseUrl}/_emdash/api/menus${path}`, init);
		const payload = (await response.json()) as { data: T };
		expect(response.ok, JSON.stringify(payload)).toBe(true);
		return payload.data;
	}

	it.each([
		"primary-encoded-test",
		"サイドメニュー",
		"%e3%82%b5%e3%82%a4%e3%83%89%e3%83%a1%e3%83%8b%e3%83%a5%e3%83%bc",
		"%E3%82%B5%E3%82%A4%E3%83%89%E3%83%A1%E3%83%8B%E3%83%A5%E3%83%BC",
		"menu/with?reserved#characters%",
	])("preserves %s through menu, item, and translation operations", async (name) => {
		await request("", "POST", { name, label: "Imported menu", locale: "en" });
		const path = `/${encodeURIComponent(name)}`;
		const source = `${path}?locale=en`;
		const menu = await request<{ name: string }>(source);
		expect(menu.name).toBe(name);

		const updated = await request<{ label: string }>(source, "PUT", { label: "Updated menu" });
		expect(updated.label).toBe("Updated menu");

		const item = await request<{ id: string }>(`${path}/items?locale=en`, "POST", {
			type: "custom",
			label: "Home",
			customUrl: "/",
		});
		const updatedItem = await request<{ label: string }>(
			`${path}/items/${item.id}?locale=en`,
			"PUT",
			{ label: "Updated item" },
		);
		expect(updatedItem.label).toBe("Updated item");

		await request(`${path}/reorder?locale=en`, "POST", {
			items: [{ id: item.id, parentId: null, sortOrder: 0 }],
		});
		const translation = await request<{ name: string }>(`${path}/translations?locale=en`, "POST", {
			locale: "fr",
		});
		expect(translation.name).toBe(name);
		const translations = await request<{ translations: Array<{ name: string }> }>(
			`${path}/translations?locale=en`,
		);
		expect(translations.translations.map((entry) => entry.name)).toEqual([name, name]);

		await request(`${path}/items/${item.id}?locale=en`, "DELETE");
		await request(`${path}?locale=fr`, "DELETE");
		await request(source, "DELETE");
	});

	it("distinguishes encoded and decoded names stored at the same time", async () => {
		const decoded = "日本語";
		const encoded = encodeURIComponent(decoded).toLowerCase();
		await request("", "POST", { name: decoded, label: "Decoded", locale: "en" });
		await request("", "POST", { name: encoded, label: "Encoded", locale: "en" });

		for (const [name, label] of [
			[decoded, "Decoded"],
			[encoded, "Encoded"],
		]) {
			const menu = await request<{ name: string; label: string }>(
				`/${encodeURIComponent(name)}?locale=en`,
			);
			expect(menu).toMatchObject({ name, label });
		}
	});
});
