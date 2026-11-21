import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { TermResponse } from "../../../src/api/handlers/taxonomies.js";
import type { TestServerContext } from "../server.js";
import { assertNodeVersion, createTestServer } from "../server.js";

describe("taxonomy term slugs through Astro routing", () => {
	let ctx: TestServerContext;
	const taxonomy = "encoded_terms";

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
		const response = await fetch(`${ctx.baseUrl}/_emdash/api/taxonomies${path}`, init);
		const payload = (await response.json()) as { data: T };
		expect(response.ok, JSON.stringify(payload)).toBe(true);
		return payload.data;
	}

	beforeAll(async () => {
		assertNodeVersion();
		ctx = await createTestServer({ port: 4408 });
		await request("", "POST", { name: taxonomy, label: "Imported categories", locale: "en" });
	});

	afterAll(async () => {
		await ctx?.cleanup();
	});

	it.each([
		"plain-term",
		"その他",
		"%e3%81%9d%e3%81%ae%e4%bb%96",
		"%E3%81%9D%E3%81%AE%E4%BB%96",
		"term/with?reserved#characters%",
	])("preserves %s through editing, translations, and deletion", async (slug) => {
		const created = await request<TermResponse>(`/${taxonomy}/terms`, "POST", {
			slug,
			label: "その他",
			locale: "en",
		});
		const path = `/${taxonomy}/terms/${encodeURIComponent(slug)}`;
		const source = `${path}?locale=en`;
		expect((await request<TermResponse>(source)).term).toMatchObject({ id: created.term.id, slug });
		expect((await request<TermResponse>(source, "PUT", { label: "Updated" })).term).toMatchObject({
			id: created.term.id,
			slug,
			label: "Updated",
		});

		const translated = await request<TermResponse>(`${path}/translations?locale=en`, "POST", {
			locale: "fr",
		});
		expect(translated.term.slug).toBe(slug);
		const translations = await request<{ translations: Array<{ id: string }> }>(
			`${path}/translations?locale=en`,
		);
		expect(translations.translations.map((term: { id: string }) => term.id)).toContain(
			translated.term.id,
		);

		await request(source, "DELETE");
		const remaining = await request<{ terms: Array<{ id: string }> }>(
			`/${taxonomy}/terms?locale=en`,
		);
		expect(remaining.terms.some((term: { id: string }) => term.id === created.term.id)).toBe(false);
	});

	it("deletes an imported category without a decoded counterpart", async () => {
		const slug = encodeURIComponent("その他-削除").toLowerCase();
		const created = await request<TermResponse>(`/${taxonomy}/terms`, "POST", {
			slug,
			label: "その他",
			locale: "en",
		});
		await request(`/${taxonomy}/terms/${encodeURIComponent(slug)}?locale=en`, "DELETE");
		const remaining = await request<{ terms: Array<{ id: string }> }>(
			`/${taxonomy}/terms?locale=en`,
		);
		expect(remaining.terms.some((term) => term.id === created.term.id)).toBe(false);
	});

	it("deletes the encoded slug without deleting its decoded equivalent", async () => {
		const decoded = "日本語";
		const encoded = encodeURIComponent(decoded).toLowerCase();
		for (const slug of [decoded, encoded]) {
			await request(`/${taxonomy}/terms`, "POST", { slug, label: slug, locale: "en" });
		}
		await request(`/${taxonomy}/terms/${encodeURIComponent(encoded)}?locale=en`, "DELETE");
		const remaining = await request<TermResponse>(
			`/${taxonomy}/terms/${encodeURIComponent(decoded)}?locale=en`,
		);
		expect(remaining.term).toMatchObject({ slug: decoded, label: decoded });
		const terms = await request<{ terms: Array<{ slug: string }> }>(`/${taxonomy}/terms?locale=en`);
		expect(terms.terms.some((term: { slug: string }) => term.slug === encoded)).toBe(false);
	});
});
