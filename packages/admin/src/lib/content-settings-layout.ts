export const CONTENT_SETTINGS_LAYOUT_VERSION = 1 as const;

export const DEFAULT_CONTENT_SETTINGS_SECTION_ORDER = [
	"publish",
	"ownership",
	"bylines",
	"translations",
	"taxonomies",
	"seo",
	"outline",
	"revisions",
] as const;

export type ContentSettingsSectionId = string;

export interface ContentSettingsLayout {
	version: typeof CONTENT_SETTINGS_LAYOUT_VERSION;
	order: ContentSettingsSectionId[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/** Parse a browser preference without allowing malformed state to break the editor. */
export function parseContentSettingsLayout(raw: string | null): ContentSettingsLayout | null {
	if (!raw) return null;

	try {
		const value: unknown = JSON.parse(raw);
		if (
			!isRecord(value) ||
			value.version !== CONTENT_SETTINGS_LAYOUT_VERSION ||
			!Array.isArray(value.order)
		) {
			return null;
		}

		return {
			version: CONTENT_SETTINGS_LAYOUT_VERSION,
			order: value.order.filter((id): id is ContentSettingsSectionId => typeof id === "string"),
		};
	} catch {
		return null;
	}
}

/**
 * Reconcile saved order with the sections available in the current editor.
 * Duplicate and unavailable ids disappear, while newly registered sections append.
 */
export function resolveContentSettingsLayout(
	stored: ContentSettingsLayout | null,
	availableSectionIds: readonly ContentSettingsSectionId[] = DEFAULT_CONTENT_SETTINGS_SECTION_ORDER,
): ContentSettingsLayout {
	const seen = new Set<ContentSettingsSectionId>();
	const available = new Set(availableSectionIds);
	const order = (stored?.order ?? []).filter((id) => {
		if (!available.has(id) || seen.has(id)) return false;
		seen.add(id);
		return true;
	});

	for (const id of availableSectionIds) {
		if (seen.has(id)) continue;
		order.push(id);
		seen.add(id);
	}

	return { version: CONTENT_SETTINGS_LAYOUT_VERSION, order };
}

export function reorderContentSettingsLayout(
	layout: ContentSettingsLayout,
	activeId: ContentSettingsSectionId,
	overId: ContentSettingsSectionId,
): ContentSettingsLayout {
	if (activeId === overId) return layout;

	const from = layout.order.indexOf(activeId);
	const to = layout.order.indexOf(overId);
	if (from < 0 || to < 0) return layout;

	const order = [...layout.order];
	const [moved] = order.splice(from, 1);
	if (!moved) return layout;
	order.splice(to, 0, moved);
	return { ...layout, order };
}
