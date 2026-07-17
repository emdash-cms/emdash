import type { ContentEditorPanelExtension } from "./admin-extensions.js";

export const CONTENT_EDITOR_PANEL_LAYOUT_VERSION = 1 as const;

export type ContentEditorPanelPlacement = "main" | "sidebar";

export interface ContentEditorPanelLayout {
	version: typeof CONTENT_EDITOR_PANEL_LAYOUT_VERSION;
	main: string[];
	sidebar: string[];
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/** Parse an untrusted browser preference without letting it break the editor. */
export function parseContentEditorPanelLayout(raw: string | null): ContentEditorPanelLayout | null {
	if (!raw) return null;
	try {
		const value: unknown = JSON.parse(raw);
		if (
			!isRecord(value) ||
			value.version !== CONTENT_EDITOR_PANEL_LAYOUT_VERSION ||
			!isStringArray(value.main) ||
			!isStringArray(value.sidebar)
		) {
			return null;
		}
		return {
			version: CONTENT_EDITOR_PANEL_LAYOUT_VERSION,
			main: [...value.main],
			sidebar: [...value.sidebar],
		};
	} catch {
		return null;
	}
}

/**
 * Reconcile a saved layout with the currently registered panels. Stale and
 * duplicate ids disappear; new panels append to their declared placement in
 * registry order.
 */
export function resolveContentEditorPanelLayout(
	panels: readonly ContentEditorPanelExtension[],
	stored: ContentEditorPanelLayout | null,
): ContentEditorPanelLayout {
	const known = new Set(panels.map((panel) => panel.id));
	const seen = new Set<string>();
	const takeKnown = (ids: readonly string[] | undefined) =>
		(ids ?? []).filter((id) => {
			if (!known.has(id) || seen.has(id)) return false;
			seen.add(id);
			return true;
		});

	const main = takeKnown(stored?.main);
	const sidebar = takeKnown(stored?.sidebar);

	for (const panel of panels) {
		if (seen.has(panel.id)) continue;
		(panel.placement === "main" ? main : sidebar).push(panel.id);
		seen.add(panel.id);
	}

	return { version: CONTENT_EDITOR_PANEL_LAYOUT_VERSION, main, sidebar };
}

export function moveContentEditorPanel(
	layout: ContentEditorPanelLayout,
	id: string,
	direction: "up" | "down",
): ContentEditorPanelLayout {
	const placement: ContentEditorPanelPlacement | null = layout.main.includes(id)
		? "main"
		: layout.sidebar.includes(id)
			? "sidebar"
			: null;
	if (!placement) return layout;

	const current = layout[placement];
	const index = current.indexOf(id);
	const target = direction === "up" ? index - 1 : index + 1;
	if (target < 0 || target >= current.length) return layout;

	const next = [...current];
	const currentValue = next[index];
	const targetValue = next[target];
	if (currentValue === undefined || targetValue === undefined) return layout;
	next[index] = targetValue;
	next[target] = currentValue;
	return { ...layout, [placement]: next };
}

/** Reorder a panel relative to another panel on the same editor surface. */
export function reorderContentEditorPanel(
	layout: ContentEditorPanelLayout,
	id: string,
	overId: string,
): ContentEditorPanelLayout {
	const placement: ContentEditorPanelPlacement | null = layout.main.includes(id)
		? "main"
		: layout.sidebar.includes(id)
			? "sidebar"
			: null;
	if (!placement || id === overId) return layout;

	const current = layout[placement];
	const from = current.indexOf(id);
	const to = current.indexOf(overId);
	if (from < 0 || to < 0) return layout;

	const next = [...current];
	const [moved] = next.splice(from, 1);
	if (!moved) return layout;
	next.splice(to, 0, moved);
	return { ...layout, [placement]: next };
}

export function placeContentEditorPanel(
	layout: ContentEditorPanelLayout,
	id: string,
	placement: ContentEditorPanelPlacement,
): ContentEditorPanelLayout {
	const main = layout.main.filter((entry) => entry !== id);
	const sidebar = layout.sidebar.filter((entry) => entry !== id);
	const target = placement === "main" ? main : sidebar;
	target.push(id);
	return { ...layout, main, sidebar };
}
