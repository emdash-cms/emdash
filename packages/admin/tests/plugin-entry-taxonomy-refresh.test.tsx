import { Toasty } from "@cloudflare/kumo";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import * as React from "react";
import { afterEach, expect, it, vi } from "vitest";

import { ThemeProvider } from "../src/components/ThemeProvider.js";
import type { AdminManifest } from "../src/lib/api.js";
import { createAdminRouter } from "../src/router.js";
import { render } from "./utils/render.js";
import { createTestQueryClient } from "./utils/test-helpers.js";

const taxonomy = {
	id: "category",
	name: "category",
	label: "Categories",
	labelSingular: "Category",
	hierarchical: true,
	collections: ["posts"],
	locale: "en",
	translationGroup: "category",
};
const terms = ["Notes", "Design"].map((label) => ({
	id: label.toLowerCase(),
	taxonomy: "category",
	slug: label.toLowerCase(),
	label,
	parentId: null,
	children: [],
	locale: "en",
	translationGroup: label.toLowerCase(),
}));
const manifest: AdminManifest = {
	version: "1.0.0",
	hash: "test",
	authMode: "passkey",
	collections: {
		posts: {
			label: "Posts",
			labelSingular: "Post",
			supports: [],
			hasSeo: false,
			fields: { title: { kind: "string", label: "Title" } },
		},
	},
	taxonomies: [taxonomy],
	plugins: {
		categorizer: {
			enabled: true,
			adminMode: "blocks",
			editorPanels: [
				{ id: "categories", title: "Categorizer", route: "categories", collections: ["posts"] },
			],
		},
	},
};

const originalFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = originalFetch;
});

it("refreshes plugin-added categories before a later sidebar edit replaces the assignments", async () => {
	i18n.loadAndActivate({ locale: "en", messages: {} });
	let assignedIds = ["notes"];
	const savedSelections: string[][] = [];
	const json = (data: unknown) =>
		Promise.resolve(
			new Response(JSON.stringify({ data }), {
				headers: { "Content-Type": "application/json" },
			}),
		);
	globalThis.fetch = vi.fn((input: string | URL | Request, init?: RequestInit) => {
		const url = String(input instanceof Request ? input.url : input).split("?")[0];
		const method = init?.method ?? "GET";
		if (url === "/_emdash/api/manifest") return json(manifest);
		if (url === "/_emdash/api/taxonomies") return json({ taxonomies: [taxonomy] });
		if (url === "/_emdash/api/auth/me") return json({ id: "admin", role: 50 });
		if (url === "/_emdash/api/content/posts/post_1")
			return json({
				item: {
					id: "post_1",
					type: "posts",
					slug: "hello",
					status: "published",
					locale: "en",
					data: { title: "Hello" },
					authorId: null,
					createdAt: "2025-01-01T00:00:00Z",
					updatedAt: "2025-01-01T00:00:00Z",
				},
			});
		if (url === "/_emdash/api/taxonomies/category/terms") return json({ terms });
		if (url === "/_emdash/api/content/posts/post_1/terms/category") {
			if (method === "POST") {
				if (typeof init?.body !== "string") throw new Error("Expected a JSON request body");
				assignedIds = JSON.parse(init.body).termIds;
				savedSelections.push(assignedIds);
			}
			return json({
				terms: terms.filter((term) => assignedIds.includes(term.id)),
				entryLocale: "en",
			});
		}
		if (
			url === "/_emdash/api/content/posts/post_1/plugin-extensions/categorizer/panel/categories"
		) {
			if (typeof init?.body !== "string") throw new Error("Expected a JSON request body");
			const interaction = JSON.parse(init.body);
			if (interaction.type === "form_submit") {
				assignedIds = ["notes", "design"];
				return json({ blocks: [], refresh: true });
			}
			return json({
				blocks: [
					{
						type: "form",
						block_id: "add-category",
						fields: [],
						submit: { action_id: "add", label: "Add Design" },
					},
				],
			});
		}
		if (url === "/_emdash/api/admin/comments/counts") return json({ pending: 0 });
		return json({ items: [], translations: [] });
	}) as typeof fetch;
	const queryClient = createTestQueryClient();
	const router = createAdminRouter(queryClient);
	await router.navigate({
		to: "/content/$collection/$id",
		params: { collection: "posts", id: "post_1" },
	});
	const screen = await render(
		<I18nProvider i18n={i18n}>
			<ThemeProvider defaultTheme="light">
				<Toasty>
					<QueryClientProvider client={queryClient}>
						<RouterProvider router={router} />
					</QueryClientProvider>
				</Toasty>
			</ThemeProvider>
		</I18nProvider>,
	);
	await expect
		.element(screen.getByRole("button", { name: "Remove Notes", exact: true }))
		.toBeVisible();
	await screen.getByRole("button", { name: "Categorizer", exact: true }).click();
	await screen.getByRole("button", { name: "Add Design", exact: true }).click();
	await expect
		.element(screen.getByRole("button", { name: "Remove Design", exact: true }))
		.toBeVisible();
	await screen.getByRole("button", { name: "Remove Notes", exact: true }).click();
	await expect.poll(() => savedSelections).toEqual([["design"]]);
	await expect
		.element(screen.getByRole("button", { name: "Remove Design", exact: true }))
		.toBeVisible();
	expect(assignedIds).toEqual(["design"]);
});
