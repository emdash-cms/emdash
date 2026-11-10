import { i18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
	analyzeWxr,
	createMenu,
	createRedirect,
	createTaxonomy,
	createWidgetArea,
	duplicateContent,
	fetchApiTokens,
	fetchBylines,
	fetchCollection,
	fetchCollections,
	fetchMarketplacePlugin,
	fetchRelations,
	fetchRevision,
	fetchTheme,
	fetchUser,
	requestSignup,
	restoreRevision,
	searchThemes,
	updateCommentStatus,
} from "../../../src/lib/api/index.js";

const originalFetch = globalThis.fetch;
const previousLocale = i18n.locale;

afterEach(() => {
	globalThis.fetch = originalFetch;
	i18n.loadAndActivate({ locale: previousLocale, messages: {} });
});

describe("API error fallbacks", () => {
	it.each([
		{ name: "API tokens", message: msg`Failed to fetch API tokens`, action: fetchApiTokens },
		{ name: "bylines", message: msg`Failed to fetch bylines`, action: () => fetchBylines() },
		{
			name: "comment status",
			message: msg`Failed to update comment status`,
			action: () => updateCommentStatus("c1", "approved"),
		},
		{
			name: "duplicate content",
			message: msg`Failed to duplicate content`,
			action: () => duplicateContent("posts", "post_1"),
		},
		{
			name: "import analysis",
			message: msg`Failed to analyze file`,
			action: () => analyzeWxr(new File(["<rss/>"], "export.xml")),
		},
		{
			name: "marketplace plugin",
			message: msg`Failed to fetch plugin`,
			action: () => fetchMarketplacePlugin("seo"),
		},
		{
			name: "menu",
			message: msg`Failed to create menu`,
			action: () => createMenu({ name: "main", label: "Main" }),
		},
		{
			name: "redirect",
			message: msg`Failed to create redirect`,
			action: () => createRedirect({ source: "/old", destination: "/new" }),
		},
		{ name: "relations", message: msg`Failed to fetch relations`, action: () => fetchRelations() },
		{ name: "collections", message: msg`Failed to fetch collections`, action: fetchCollections },
		{
			name: "taxonomy",
			message: msg`Failed to create taxonomy`,
			action: () => createTaxonomy({ name: "genre", label: "Genres" }),
		},
		{ name: "theme search", message: msg`Theme search failed`, action: () => searchThemes() },
		{
			name: "signup request",
			message: msg`Signup request failed`,
			action: () => requestSignup("editor@example.com"),
		},
		{
			name: "widget area",
			message: msg`Failed to create widget area`,
			action: () => createWidgetArea({ name: "sidebar", label: "Sidebar" }),
		},
	])("uses the active catalog for the $name fallback", async ({ message, action }) => {
		i18n.loadAndActivate({ locale: "de", messages: { [message.id]: "Translated API error" } });
		globalThis.fetch = vi.fn(
			async () =>
				new Response("<html>Upstream failed</html>", { status: 502, statusText: "Bad Gateway" }),
		);
		await expect(action()).rejects.toThrow(/^Translated API error/);
	});
});

describe("API not-found errors", () => {
	const id = "missing";
	const slug = "missing";
	const revisionId = "missing";

	it.each([
		{ name: "theme", message: msg`Theme "${id}" not found`, action: () => fetchTheme(id) },
		{
			name: "marketplace plugin",
			message: msg`Plugin "${id}" not found in marketplace`,
			action: () => fetchMarketplacePlugin(id),
		},
		{
			name: "collection",
			message: msg`Collection "${slug}" not found`,
			action: () => fetchCollection(slug),
		},
		{
			name: "revision",
			message: msg`Revision not found: ${revisionId}`,
			action: () => fetchRevision(revisionId),
		},
		{
			name: "revision restore",
			message: msg`Revision not found: ${revisionId}`,
			action: () => restoreRevision(revisionId),
		},
		{ name: "user", message: msg`User not found: ${id}`, action: () => fetchUser(id) },
	])("uses the active catalog for the $name error", async ({ message, action }) => {
		i18n.loadAndActivate({
			locale: "de",
			messages: { [message.id]: "Translated not-found error" },
		});
		globalThis.fetch = vi.fn(async () => new Response("Not Found", { status: 404 }));
		await expect(action()).rejects.toThrow(/^Translated not-found error$/);
	});
});
