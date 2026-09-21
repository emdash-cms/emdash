import type { ConfirmDialog } from "@emdash-cms/blocks";

import type { AdminManifest } from "./api/client.js";

export interface SandboxedEditorPanelDeclaration {
	id: string;
	title: string;
	route: string;
	collections?: string[];
	order?: number;
}

export interface SandboxedEditorActionDeclaration {
	id: string;
	label: string;
	route: string;
	placement: "toolbar" | "overflow";
	collections?: string[];
	style?: "default" | "danger";
	confirm?: ConfirmDialog;
}

export interface ResolvedSandboxedEditorPanel {
	pluginId: string;
	extension: SandboxedEditorPanelDeclaration;
}

export interface ResolvedSandboxedEditorAction {
	pluginId: string;
	extension: SandboxedEditorActionDeclaration;
}

function appliesToCollection(collections: readonly string[] | undefined, collection: string) {
	return collections === undefined || collections.includes(collection);
}

export function resolveSandboxedEditorPanels(
	plugins: AdminManifest["plugins"] | undefined,
	collection: string,
): ResolvedSandboxedEditorPanel[] {
	const resolved: ResolvedSandboxedEditorPanel[] = [];
	const seen = new Set<string>();
	for (const pluginId of Object.keys(plugins ?? {}).toSorted()) {
		const plugin = plugins?.[pluginId];
		if (!plugin || plugin.enabled === false || plugin.adminMode !== "blocks") continue;
		for (const extension of plugin.editorPanels ?? []) {
			if (!extension.id || !extension.title || !extension.route) continue;
			const identity = `${pluginId}:${extension.id}`;
			if (seen.has(identity)) continue;
			seen.add(identity);
			if (!appliesToCollection(extension.collections, collection)) continue;
			resolved.push({ pluginId, extension });
		}
	}
	return resolved.toSorted(
		(a, b) =>
			(a.extension.order ?? 0) - (b.extension.order ?? 0) ||
			a.pluginId.localeCompare(b.pluginId) ||
			a.extension.id.localeCompare(b.extension.id),
	);
}

export function resolveSandboxedEditorActions(
	plugins: AdminManifest["plugins"] | undefined,
	collection: string,
): ResolvedSandboxedEditorAction[] {
	const resolved: ResolvedSandboxedEditorAction[] = [];
	const seen = new Set<string>();
	for (const pluginId of Object.keys(plugins ?? {}).toSorted()) {
		const plugin = plugins?.[pluginId];
		if (!plugin || plugin.enabled === false || plugin.adminMode !== "blocks") continue;
		for (const extension of plugin.editorActions ?? []) {
			if (
				!extension.id ||
				!extension.label ||
				!extension.route ||
				(extension.style === "danger" && !extension.confirm)
			) {
				continue;
			}
			const identity = `${pluginId}:${extension.id}`;
			if (seen.has(identity)) continue;
			seen.add(identity);
			if (!appliesToCollection(extension.collections, collection)) continue;
			resolved.push({ pluginId, extension });
		}
	}
	return resolved.toSorted(
		(a, b) => a.pluginId.localeCompare(b.pluginId) || a.extension.id.localeCompare(b.extension.id),
	);
}

export function editorExtensionUrl(
	collection: string,
	entryId: string,
	pluginId: string,
	kind: "panel" | "action",
	extensionId: string,
	locale?: string | null,
): string {
	const path = [collection, entryId, "plugin-extensions", pluginId, kind, extensionId]
		.map(encodeURIComponent)
		.join("/");
	const search = locale ? `?locale=${encodeURIComponent(locale)}` : "";
	return `/_emdash/api/content/${path}${search}`;
}
