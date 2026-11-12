/**
 * The editor settings sidebar's sections: their labels, where each one is
 * available, and the plugin panels with their section IDs. The default order
 * lives in `admin-layout.ts`.
 */

import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";

import {
	BUILT_IN_EDITOR_SECTION_IDS,
	EMPTY_LIST_LAYOUT,
	resolveEditor,
	type BuiltInEditorSectionId,
	type PluginEditorSectionId,
} from "./admin-layout.js";
import type { AdminManifest } from "./api/client.js";
import {
	resolveContentEditorPanels,
	type ResolvedContentEditorPanel,
} from "./content-editor-panels.js";
import type { PluginAdmins } from "./plugin-context.js";
import {
	resolveSandboxedEditorPanels,
	type ResolvedSandboxedEditorPanel,
} from "./sandboxed-editor-extensions.js";

const ROLE_EDITOR = 40;

export const EDITOR_SECTION_LABELS: Record<BuiltInEditorSectionId, MessageDescriptor> = {
	publish: msg`Publish`,
	"url-language": msg`URL & language`,
	ownership: msg`Ownership`,
	bylines: msg`Bylines`,
	translations: msg`Translations`,
	taxonomies: msg`Taxonomies`,
	seo: msg`SEO`,
	outline: msg`Outline`,
	revisions: msg`Revisions`,
};

type EditorManifest = Pick<AdminManifest, "collections" | "plugins" | "taxonomies" | "i18n">;
type ManifestCollection = AdminManifest["collections"][string];

interface SiteContext {
	readonly manifest: EditorManifest;
	readonly role: number;
}

/**
 * A section is offered site-wide or by collection. Only the manifest and the
 * role count: entry-level conditions (a saved entry, a non-empty user list)
 * stay with the editor.
 */
type Availability =
	| { readonly site: (site: SiteContext) => boolean }
	| {
			readonly collection: (
				site: SiteContext,
				slug: string,
				collection: ManifestCollection,
			) => boolean;
	  };

const AVAILABILITY: Record<BuiltInEditorSectionId, Availability> = {
	publish: { site: () => true },
	"url-language": { site: () => true },
	ownership: { site: ({ role }) => role >= ROLE_EDITOR },
	bylines: { site: ({ role }) => role >= ROLE_EDITOR },
	translations: { site: ({ manifest }) => manifest.i18n != null },
	taxonomies: {
		collection: ({ manifest }, slug) =>
			manifest.taxonomies.some((taxonomy) => taxonomy.collections.includes(slug)),
	},
	seo: { collection: (_site, _slug, collection) => collection.hasSeo },
	outline: {
		collection: (_site, _slug, { fields }) =>
			fields.content?.kind === "portableText" && !fields.content.widget,
	},
	revisions: {
		collection: (_site, _slug, collection) => collection.supports.includes("revisions"),
	},
};

export type EditorExtensionSection =
	| {
			readonly kind: "trusted";
			readonly id: PluginEditorSectionId;
			readonly pluginId: string;
			readonly panel: ResolvedContentEditorPanel;
	  }
	| {
			readonly kind: "sandboxed";
			readonly id: PluginEditorSectionId;
			readonly pluginId: string;
			readonly panel: ResolvedSandboxedEditorPanel;
	  };

function byDeclaredOrder(a: EditorExtensionSection, b: EditorExtensionSection): number {
	return (
		(a.panel.extension.order ?? 0) - (b.panel.extension.order ?? 0) ||
		a.pluginId.localeCompare(b.pluginId) ||
		a.panel.extension.id.localeCompare(b.panel.extension.id)
	);
}

/**
 * Trusted React panels and Block Kit panels for one collection and role,
 * sorted by declared `order`, then plugin ID, then panel ID.
 */
export function resolveEditorExtensionSections(
	pluginAdmins: PluginAdmins,
	plugins: AdminManifest["plugins"] | undefined,
	collection: string,
	role: number,
): EditorExtensionSection[] {
	return [
		...resolveContentEditorPanels(pluginAdmins, collection, role, plugins).map(
			(panel): EditorExtensionSection => ({
				kind: "trusted",
				id: `plugin:${panel.pluginId}:${panel.extension.id}`,
				pluginId: panel.pluginId,
				panel,
			}),
		),
		...resolveSandboxedEditorPanels(plugins, collection).map(
			(panel): EditorExtensionSection => ({
				kind: "sandboxed",
				id: `sandbox-plugin:${panel.pluginId}:${panel.extension.id}`,
				pluginId: panel.pluginId,
				panel,
			}),
		),
	].toSorted(byDeclaredOrder);
}

export type EditorSectionEntry =
	| {
			readonly kind: "built-in";
			readonly id: BuiltInEditorSectionId;
			readonly label: MessageDescriptor;
	  }
	| {
			readonly kind: "plugin";
			readonly id: PluginEditorSectionId;
			/** The declared title: translate it with `declaredLabelTranslator`, not Lingui's compiler. */
			readonly label: string;
			/** The contributing plugin's name. */
			readonly meta: string;
	  };

/**
 * Every section the user would see in at least one collection, hidden
 * collections included, in default order.
 */
export function listEditorSections(
	manifest: EditorManifest,
	pluginAdmins: PluginAdmins,
	role: number,
): EditorSectionEntry[] {
	const site: SiteContext = { manifest, role };
	const collections = Object.entries(manifest.collections);

	const builtIns = BUILT_IN_EDITOR_SECTION_IDS.filter((id) => {
		const rule = AVAILABILITY[id];
		return "site" in rule
			? rule.site(site)
			: collections.some(([slug, collection]) => rule.collection(site, slug, collection));
	}).map((id): EditorSectionEntry => ({ kind: "built-in", id, label: EDITOR_SECTION_LABELS[id] }));

	const extensions = new Map<PluginEditorSectionId, EditorExtensionSection>();
	for (const [slug] of collections) {
		for (const section of resolveEditorExtensionSections(
			pluginAdmins,
			manifest.plugins,
			slug,
			role,
		)) {
			if (!extensions.has(section.id)) extensions.set(section.id, section);
		}
	}
	const plugins = [...extensions.values()].toSorted(byDeclaredOrder).map(
		(section): EditorSectionEntry => ({
			kind: "plugin",
			id: section.id,
			label: section.panel.extension.title,
			meta: manifest.plugins[section.pluginId]?.name ?? section.pluginId,
		}),
	);

	return resolveEditor([...builtIns, ...plugins], EMPTY_LIST_LAYOUT);
}
