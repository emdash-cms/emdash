/**
 * Typed admin extension slots for trusted (native) plugins.
 *
 * Native companions extend two admin surfaces without DOM bridges, global
 * hooks, or private patches:
 *
 *   - Content list columns (`contentListColumns` on the plugin admin module)
 *   - Content editor panels (`contentEditorPanels`)
 *
 * Contributions travel the existing trusted registration path: a native
 * plugin's `adminEntry` module exports them, the core integration bundles
 * that module into `virtual:emdash/admin-registry` (native descriptors only —
 * core rejects `adminEntry` on sandboxed/standard plugins at config time),
 * and `PluginAdminProvider` delivers them here. Sandboxed plugins never
 * appear in that registry, so they can never reach these React slots.
 *
 * This module is pure (no hooks, no React rendering) so selection semantics
 * — ordering, duplicate handling, collection/role filtering — are testable
 * without a DOM, mirroring the pure nav helpers in `components/Sidebar.tsx`.
 */

import type { MessageDescriptor } from "@lingui/core";
import type * as React from "react";

import type { ContentItem, ContentSeo, ContentSeoInput } from "./api";

// ── Contribution contexts (host → extension, read-only) ────────────

/** Context passed to a contributed list-column header component. */
export interface ContentListColumnHeaderContext {
	/** Collection slug the list is showing. */
	collection: string;
	/** Active list locale (undefined when the site has no i18n config). */
	locale?: string;
}

/**
 * Context passed to a contributed list-column cell component, one per row.
 * The entry field is named `item` to match the list domain (`ContentItem`
 * rows); the editor panel context names its saved entry `entry` because the
 * editor edits one entry, not a row in a list.
 */
export interface ContentListColumnCellContext extends ContentListColumnHeaderContext {
	/** The saved entry this row renders. Treat as read-only host data. */
	item: ContentItem;
}

/** Live draft state exposed to a contributed editor panel. */
export interface ContentEditorDraftState {
	/** Current unsaved field values. Treat as read-only host state. */
	data: Readonly<Record<string, unknown>>;
	/** Current unsaved slug. */
	slug: string;
	/** Current editor status. */
	status: string;
	/** Current saved SEO metadata, when SEO is enabled for the collection. */
	seo?: ContentSeo;
	/** Whether this editor is creating a never-saved entry. */
	isNew: boolean;
	/** Whether the field/slug draft differs from the last saved state. */
	isDirty: boolean;
}

/** Host-owned mutations a contributed editor panel may request. */
export interface ContentEditorPanelActions {
	/** Update one field in the live editor draft. */
	updateField(name: string, value: unknown): void;
	/** Update the live slug draft. */
	updateSlug(value: string): void;
	/** Persist SEO metadata through the host, when SEO is enabled. */
	updateSeo?: (seo: ContentSeoInput) => void;
}

/** Context passed to a contributed editor panel component. */
export interface ContentEditorPanelContext {
	/** Collection slug of the entry being edited. */
	collection: string;
	/** Saved entry snapshot, or null while creating a new entry. */
	entry: ContentItem | null;
	/** Locale the entry is bound to (undefined when i18n is off). */
	locale?: string;
	/** Live editor state. */
	draft: ContentEditorDraftState;
	/** Host-owned editor mutations. */
	actions: ContentEditorPanelActions;
}

// ── Contribution shapes (extension → host) ─────────────────────────

interface AdminExtensionBase {
	/**
	 * Stable unique id, unique within its slot. Convention:
	 * `"<plugin-id>:<name>"`. Duplicate ids are dropped deterministically
	 * (first in sorted plugin order wins) with a console warning.
	 */
	id: string;
	/**
	 * Sort key within the slot; lower renders first. Ties break by `id`,
	 * so ordering is deterministic regardless of registration order.
	 * @default 0
	 */
	order?: number;
	/**
	 * Collection applicability: a list of collection slugs, or a predicate
	 * over the slug. Omit to apply to every collection. A predicate that
	 * throws marks the contribution inapplicable (fault isolation).
	 */
	collections?: readonly string[] | ((collection: string) => boolean);
	/**
	 * Minimum numeric role required to see the contribution (matching
	 * `@emdash-cms/auth` levels, e.g. 40 = Editor, 50 = Admin). Omit for
	 * every authenticated admin user. This gates visibility only — server
	 * authorization still applies to any data the extension requests.
	 */
	minRole?: number;
}

/**
 * A content-list column contributed by a trusted plugin.
 *
 * The host renders the header `<th>` (from `label`, or `header` when given)
 * and one `<td>` per row mounting `cell`. Both are wrapped in an error
 * boundary, so a broken contribution degrades to a quiet placeholder without
 * breaking the table.
 *
 * Data loading: `cell` receives the already-loaded row (`item`) — the host
 * never issues per-row requests for extension columns. A cell that needs
 * remote data must batch it: use one react-query key shared by every cell
 * (e.g. `[pluginId, "list-data", collection, locale]`) whose fetcher loads
 * the whole collection's data in one request; concurrent cells share the
 * in-flight promise. Per-row query keys re-introduce N+1 and are a bug.
 * While loading, render a fixed-size placeholder to avoid layout shift.
 */
export interface ContentListColumnExtension extends AdminExtensionBase {
	/** Header label. Strings render as-is; descriptors are translated. */
	label: string | MessageDescriptor;
	/**
	 * Logical cell/header alignment (RTL-safe). Column width is intentionally
	 * not configurable: the list table auto-sizes to content.
	 * @default "start"
	 */
	align?: "start" | "end";
	/** Cell component, mounted once per visible row. */
	cell: React.ComponentType<ContentListColumnCellContext>;
	/** Optional custom header content; falls back to `label` on error. */
	header?: React.ComponentType<ContentListColumnHeaderContext>;
}

/**
 * A content-editor panel contributed by a trusted plugin.
 *
 * Rendered as a titled section in the main editor or settings sidebar. The
 * sidebar is narrow (20rem on small screens) and becomes an off-canvas
 * sheet below the `lg` breakpoint: sidebar panels must wrap instead of
 * forcing horizontal overflow and must not assume a wide viewport.
 */
export interface ContentEditorPanelExtension extends AdminExtensionBase {
	/** Section title. Strings render as-is; descriptors are translated. */
	title: string | MessageDescriptor;
	/** Preferred initial surface. Users may move it later. @default "sidebar" */
	placement?: "main" | "sidebar";
	/** Panel body component. */
	panel: React.ComponentType<ContentEditorPanelContext>;
}

/**
 * Structural view of the plugin admin registry consumed by the selectors —
 * kept structural (rather than importing `PluginAdmins`) so this module has
 * no dependency on the React context module.
 */
export type AdminExtensionSource = Record<
	string,
	| {
			contentListColumns?: readonly ContentListColumnExtension[];
			contentEditorPanels?: readonly ContentEditorPanelExtension[];
	  }
	| undefined
>;

export interface SelectAdminExtensionsOptions {
	/** Collection slug the host screen is showing. */
	collection: string;
	/** Current user's numeric role; use 0 while the user is still loading. */
	userRole: number;
	/**
	 * Plugin ids whose contributions must be skipped because the plugin is
	 * disabled in the runtime manifest (`plugins[id].enabled === false`) —
	 * the same lifecycle rule dashboard widgets and plugin pages follow.
	 */
	disabledPluginIds?: ReadonlySet<string>;
}

// ── Selection (pure) ────────────────────────────────────────────────

function compareStrings(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

function warn(message: string): void {
	console.warn(`[admin-extensions] ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

const REACT_COMPONENT_SYMBOLS = new Set([
	Symbol.for("react.memo"),
	Symbol.for("react.forward_ref"),
	Symbol.for("react.lazy"),
]);

function isReactComponent(value: unknown): boolean {
	if (typeof value === "function") return true;
	return isRecord(value) && REACT_COMPONENT_SYMBOLS.has(value.$$typeof as symbol);
}

function isDisplayText(value: unknown): value is string | MessageDescriptor {
	return (
		typeof value === "string" ||
		(isRecord(value) && typeof value.id === "string" && value.id.length > 0)
	);
}

function isValidExtensionShape<T extends AdminExtensionBase>(
	value: unknown,
	pluginId: string,
	textKey: "label" | "title",
	componentKey: "cell" | "panel",
): value is T {
	if (!isRecord(value) || typeof value.id !== "string" || value.id === "") {
		warn(`Ignoring a contribution without a string id from plugin "${pluginId}".`);
		return false;
	}

	if (!isDisplayText(value[textKey])) {
		warn(`Ignoring "${value.id}" (plugin "${pluginId}"): its ${textKey} is invalid.`);
		return false;
	}
	if (!isReactComponent(value[componentKey])) {
		warn(`Ignoring "${value.id}" (plugin "${pluginId}"): its component is not a React component.`);
		return false;
	}
	if (
		value.order !== undefined &&
		(typeof value.order !== "number" || !Number.isFinite(value.order))
	) {
		warn(`Ignoring "${value.id}" (plugin "${pluginId}"): order must be a finite number.`);
		return false;
	}
	if (
		value.minRole !== undefined &&
		(typeof value.minRole !== "number" || !Number.isFinite(value.minRole))
	) {
		warn(`Ignoring "${value.id}" (plugin "${pluginId}"): minRole must be a finite number.`);
		return false;
	}
	if (
		value.collections !== undefined &&
		typeof value.collections !== "function" &&
		(!Array.isArray(value.collections) ||
			!value.collections.every((collection) => typeof collection === "string"))
	) {
		warn(
			`Ignoring "${value.id}" (plugin "${pluginId}"): collections must be an array of strings or a predicate.`,
		);
		return false;
	}

	return true;
}

function isContentListColumnExtension(
	value: unknown,
	pluginId: string,
): value is ContentListColumnExtension {
	if (!isValidExtensionShape<ContentListColumnExtension>(value, pluginId, "label", "cell")) {
		return false;
	}
	if (value.align !== undefined && value.align !== "start" && value.align !== "end") {
		warn(`Ignoring "${value.id}" (plugin "${pluginId}"): align must be "start" or "end".`);
		return false;
	}
	if (value.header !== undefined && !isReactComponent(value.header)) {
		warn(`Ignoring "${value.id}" (plugin "${pluginId}"): its header is not a React component.`);
		return false;
	}
	return true;
}

function isContentEditorPanelExtension(
	value: unknown,
	pluginId: string,
): value is ContentEditorPanelExtension {
	if (!isValidExtensionShape<ContentEditorPanelExtension>(value, pluginId, "title", "panel")) {
		return false;
	}
	if (
		value.placement !== undefined &&
		value.placement !== "main" &&
		value.placement !== "sidebar"
	) {
		warn(`Ignoring "${value.id}" (plugin "${pluginId}"): placement must be "main" or "sidebar".`);
		return false;
	}
	return true;
}

function isApplicableToCollection(
	extension: AdminExtensionBase,
	pluginId: string,
	collection: string,
): boolean {
	const { collections } = extension;
	if (collections === undefined) return true;
	if (typeof collections === "function") {
		try {
			return collections(collection);
		} catch (error) {
			// A throwing predicate is a broken contribution; excluding it keeps
			// the host screen intact (fault isolation at selection time).
			console.error(
				`[admin-extensions] Collection predicate of "${extension.id}" (plugin "${pluginId}") threw; treating as not applicable.`,
				error,
			);
			return false;
		}
	}
	return collections.includes(collection);
}

/**
 * Collect one extension kind from the trusted plugin registry into a single
 * deterministic, filtered, ordered list:
 *
 * 1. Plugins are processed in sorted-id order (object key order is a build
 *    artifact, not a contract); plugins disabled in the runtime manifest
 *    are skipped entirely.
 * 2. A contributions export that isn't an array is ignored with a warning
 *    (an untyped plugin build can export anything) — one broken plugin
 *    never takes down the host screen.
 * 3. Malformed entries (missing string `id` or component) are dropped with
 *    a warning — one broken contribution never hides the rest.
 * 4. Duplicate ids keep the first occurrence and warn; never silently
 *    overwritten. The id is claimed even when that first occurrence is
 *    later filtered out for this screen, so a given id resolves to the
 *    same owner on every screen.
 * 5. Collection applicability, then `minRole`, filter the rest.
 * 6. Stable sort by (`order` ?? 0, `id`).
 */
function selectExtensions<T extends AdminExtensionBase>(
	source: AdminExtensionSource,
	pick: (module: NonNullable<AdminExtensionSource[string]>) => readonly T[] | undefined,
	validate: (extension: unknown, pluginId: string) => extension is T,
	options: SelectAdminExtensionsOptions,
): T[] {
	const seen = new Map<string, string>();
	const selected: T[] = [];

	for (const pluginId of Object.keys(source).toSorted(compareStrings)) {
		if (options.disabledPluginIds?.has(pluginId)) continue;
		const module = source[pluginId];
		if (!module) continue;
		const contributions = pick(module);
		if (contributions === undefined) continue;
		if (!Array.isArray(contributions)) {
			warn(`Ignoring contributions from plugin "${pluginId}": expected an array.`);
			continue;
		}

		for (const extension of contributions) {
			if (!validate(extension, pluginId)) continue;
			const owner = seen.get(extension.id);
			if (owner !== undefined) {
				warn(
					`Duplicate extension id "${extension.id}" from plugin "${pluginId}" ignored (already registered by plugin "${owner}").`,
				);
				continue;
			}
			seen.set(extension.id, pluginId);

			if (!isApplicableToCollection(extension, pluginId, options.collection)) continue;
			if (extension.minRole !== undefined && options.userRole < extension.minRole) continue;

			selected.push(extension);
		}
	}

	return selected.toSorted((a, b) => (a.order ?? 0) - (b.order ?? 0) || compareStrings(a.id, b.id));
}

/**
 * Content-list columns applicable to a collection for the current user,
 * deterministically ordered. Returns `[]` when no plugin contributes any —
 * the list renders exactly its classic markup in that case.
 */
export function selectContentListColumns(
	source: AdminExtensionSource,
	options: SelectAdminExtensionsOptions,
): ContentListColumnExtension[] {
	return selectExtensions(
		source,
		(module) => module.contentListColumns,
		isContentListColumnExtension,
		options,
	);
}

/**
 * Editor panels applicable to a collection for the current user,
 * deterministically ordered. Returns `[]` when no plugin contributes any —
 * the editor renders exactly its classic markup in that case.
 */
export function selectContentEditorPanels(
	source: AdminExtensionSource,
	options: SelectAdminExtensionsOptions,
): ContentEditorPanelExtension[] {
	return selectExtensions(
		source,
		(module) => module.contentEditorPanels,
		isContentEditorPanelExtension,
		options,
	);
}
