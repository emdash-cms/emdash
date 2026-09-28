import {
	Bell,
	BookOpen,
	Browser,
	CalendarBlank,
	CardsThree,
	Chats,
	ChartBar,
	ChartLine,
	ClockCounterClockwise,
	Code,
	Crop,
	Database,
	Download,
	FileText,
	Files,
	Folder,
	Folders,
	Gear,
	GridFour,
	IdentificationCard,
	Image,
	ImagesSquare,
	LinkSimple,
	List,
	MagnifyingGlass,
	Medal,
	Newspaper,
	Palette,
	Path,
	Plug,
	PuzzlePiece,
	Rows,
	Signature,
	SquaresFour,
	Star,
	Tag,
	Trophy,
	Upload,
	Users,
} from "@phosphor-icons/react";
import type { Icon } from "@phosphor-icons/react";
import * as React from "react";

/** Shared icon vocabulary for first-party admin entities and navigation surfaces. */
export const ADMIN_NAV_ICONS = {
	dashboard: SquaresFour,
	collection: Files,
	pages: Browser,
	posts: Newspaper,
	media: ImagesSquare,
	comments: Chats,
	menus: Rows,
	redirects: Path,
	widgets: PuzzlePiece,
	sections: CardsThree,
	taxonomy: Folders,
	tags: Tag,
	bylines: Signature,
	bylineSchema: IdentificationCard,
	contentTypes: Database,
	plugins: Plug,
	import: Download,
	folder: Folder,
} as const satisfies Record<string, Icon>;

const COLLECTION_NAV_ICON_OVERRIDES: Record<string, Icon> = {
	pages: ADMIN_NAV_ICONS.pages,
	posts: ADMIN_NAV_ICONS.posts,
};

/**
 * A collection's declared icon wins; built-in collections have distinct
 * defaults and custom collections share the generic one. An icon name that
 * does not resolve falls back to that default.
 */
export function getCollectionNavIcon(name: string, iconName?: string): React.ElementType {
	const fallback = Object.hasOwn(COLLECTION_NAV_ICON_OVERRIDES, name)
		? COLLECTION_NAV_ICON_OVERRIDES[name]!
		: ADMIN_NAV_ICONS.collection;
	return iconName ? resolveNavIcon(iconName, fallback) : fallback;
}

/** Tags have a distinct meaning; other taxonomies are collections of terms. */
export function getTaxonomyNavIcon(name: string): Icon {
	return name === "tag" ? ADMIN_NAV_ICONS.tags : ADMIN_NAV_ICONS.taxonomy;
}

/** Common plugin-declared icon names that should resolve without loading another chunk. */
const PLUGIN_NAV_ICON_MAP: Record<string, React.ElementType> = {
	settings: Gear,
	gear: Gear,
	chart: ChartBar,
	"chart-line": ChartLine,
	dashboard: ADMIN_NAV_ICONS.dashboard,
	history: ClockCounterClockwise,
	image: Image,
	award: Medal,
	trophy: Trophy,
	grid: GridFour,
	crop: Crop,
	book: BookOpen,
	plug: Plug,
	code: Code,
	file: FileText,
	document: FileText,
	users: Users,
	database: Database,
	list: List,
	calendar: CalendarBlank,
	bell: Bell,
	folder: Folder,
	star: Star,
	tag: Tag,
	link: LinkSimple,
	search: MagnifyingGlass,
	palette: Palette,
	upload: Upload,
};

const ICON_NAME_SEPARATOR = /[-_\s]+/;

/** Convert kebab, snake, or space-separated names to Phosphor's PascalCase exports. */
export function toPhosphorIconName(name: string): string {
	return name
		.split(ICON_NAME_SEPARATOR)
		.filter(Boolean)
		.map((word) => word.charAt(0).toUpperCase() + word.slice(1))
		.join("");
}

const lazyIconCache = new Map<React.ComponentType, Map<string, React.ElementType>>();

function isIconComponent(value: unknown): value is React.ComponentType<{ className?: string }> {
	return (
		typeof value === "function" ||
		(typeof value === "object" && value !== null && "$$typeof" in value)
	);
}

/**
 * Resolve a declared icon name while keeping uncommon Phosphor icons
 * code-split. Missing or unknown names render `fallback`.
 */
export function resolveNavIcon(
	name?: string,
	fallback: React.ComponentType = ADMIN_NAV_ICONS.plugins,
): React.ElementType {
	if (!name) {
		return fallback;
	}
	if (Object.hasOwn(PLUGIN_NAV_ICON_MAP, name)) {
		return PLUGIN_NAV_ICON_MAP[name]!;
	}
	const componentName = toPhosphorIconName(name);
	let perFallback = lazyIconCache.get(fallback);
	if (!perFallback) {
		perFallback = new Map();
		lazyIconCache.set(fallback, perFallback);
	}
	let icon = perFallback.get(componentName);
	if (!icon) {
		icon = React.lazy(async () => {
			const mod = await import("@phosphor-icons/react");
			const candidate: unknown = (mod as Record<string, unknown>)[componentName];
			return { default: isIconComponent(candidate) ? candidate : fallback };
		});
		perFallback.set(componentName, icon);
	}
	return icon;
}
