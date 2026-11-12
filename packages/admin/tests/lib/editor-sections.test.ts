import { describe, expect, it } from "vitest";

import type { AdminManifest } from "../../src/lib/api";
import { listEditorSections } from "../../src/lib/editor-sections";
import type { PluginAdmins } from "../../src/lib/plugin-context";

type Collection = AdminManifest["collections"][string];

const Panel = () => null;

function collection(overrides: Partial<Collection> = {}): Collection {
	return {
		label: "Posts",
		labelSingular: "Post",
		supports: [],
		hasSeo: false,
		fields: {},
		...overrides,
	};
}

function manifest(overrides: Partial<AdminManifest> = {}): AdminManifest {
	return {
		version: "1.0.0",
		hash: "test",
		collections: {},
		plugins: {},
		taxonomies: [],
		...overrides,
	} as AdminManifest;
}

const ids = (entries: ReturnType<typeof listEditorSections>) => entries.map((entry) => entry.id);

describe("listEditorSections", () => {
	it("lists only the site-wide sections when there are no collections", () => {
		expect(ids(listEditorSections(manifest(), {}, 30))).toEqual(["publish", "url-language"]);
	});

	it("places plugin sections between SEO and Outline", () => {
		const pluginAdmins: PluginAdmins = {
			insights: { contentEditorPanels: [{ id: "summary", title: "Insights", component: Panel }] },
		};
		const entries = listEditorSections(
			manifest({
				collections: {
					posts: collection({
						hasSeo: true,
						supports: ["revisions"],
						fields: { content: { kind: "portableText" } },
					}),
				},
				plugins: { insights: { name: "Insights plugin", enabled: true } },
			}),
			pluginAdmins,
			30,
		);

		expect(ids(entries)).toEqual([
			"publish",
			"url-language",
			"seo",
			"plugin:insights:summary",
			"outline",
			"revisions",
		]);
		expect(entries.find((entry) => entry.kind === "plugin")).toMatchObject({
			label: "Insights",
			meta: "Insights plugin",
		});
	});

	it("lists a section that only a hidden collection supports", () => {
		const entries = listEditorSections(
			manifest({
				collections: {
					posts: collection(),
					archive: collection({ hidden: true, supports: ["revisions"] }),
				},
			}),
			{},
			30,
		);

		expect(ids(entries)).toContain("revisions");
	});

	it("lists Ownership and Bylines only from the editor role up", () => {
		const site = manifest({ collections: { posts: collection() } });

		expect(ids(listEditorSections(site, {}, 30))).not.toContain("ownership");
		expect(ids(listEditorSections(site, {}, 30))).not.toContain("bylines");
		expect(ids(listEditorSections(site, {}, 40))).toEqual([
			"publish",
			"url-language",
			"ownership",
			"bylines",
		]);
	});

	it("lists Translations, Taxonomies, and Outline from the manifest", () => {
		const entries = listEditorSections(
			manifest({
				i18n: { defaultLocale: "en", locales: ["en", "fr"] },
				taxonomies: [{ name: "tags", label: "Tags", hierarchical: false, collections: ["pages"] }],
				collections: {
					posts: collection({ fields: { content: { kind: "portableText", widget: "md:editor" } } }),
					pages: collection(),
				},
			}),
			{},
			30,
		);

		expect(ids(entries)).toEqual(["publish", "url-language", "translations", "taxonomies"]);
	});

	it("honors a trusted panel's collections predicate and minimum role", () => {
		const pluginAdmins: PluginAdmins = {
			insights: {
				contentEditorPanels: [
					{
						id: "pages-only",
						title: "Pages only",
						component: Panel,
						collections: (slug) => slug === "pages",
					},
					{ id: "admins", title: "Admins", component: Panel, minRole: 50 },
				],
			},
		};
		const withPosts = manifest({
			collections: { posts: collection() },
			plugins: { insights: { enabled: true } },
		});
		const withPages = manifest({
			collections: { pages: collection() },
			plugins: { insights: { enabled: true } },
		});

		expect(ids(listEditorSections(withPosts, pluginAdmins, 40))).not.toContain(
			"plugin:insights:pages-only",
		);
		expect(ids(listEditorSections(withPages, pluginAdmins, 40))).toContain(
			"plugin:insights:pages-only",
		);
		expect(ids(listEditorSections(withPosts, pluginAdmins, 40))).not.toContain(
			"plugin:insights:admins",
		);
		expect(ids(listEditorSections(withPosts, pluginAdmins, 50))).toContain(
			"plugin:insights:admins",
		);
	});

	it("finds Block Kit panels per collection and skips disabled plugins", () => {
		const entries = listEditorSections(
			manifest({
				collections: { posts: collection(), pages: collection() },
				plugins: {
					forms: {
						enabled: true,
						adminMode: "blocks",
						editorPanels: [
							{ id: "late", title: "Late", route: "/late", collections: ["pages"], order: 2 },
							{ id: "early", title: "Early", route: "/early", collections: ["posts"], order: 1 },
						],
					},
					off: {
						enabled: false,
						adminMode: "blocks",
						editorPanels: [{ id: "panel", title: "Off", route: "/off" }],
					},
				},
			}),
			{},
			30,
		);

		expect(ids(entries).filter((id) => id.includes("plugin:"))).toEqual([
			"sandbox-plugin:forms:early",
			"sandbox-plugin:forms:late",
		]);
	});
});
