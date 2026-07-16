import {
	ArrowsLeftRight,
	Bell,
	BookOpen,
	CalendarBlank,
	ChatsCircle,
	ChartBar,
	ChartLine,
	ClockCounterClockwise,
	Code,
	Crop,
	Database,
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
	Palette,
	Plug,
	PuzzlePiece,
	SquaresFour,
	Stack,
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
	media: ImagesSquare,
	comments: ChatsCircle,
	menus: List,
	redirects: ArrowsLeftRight,
	widgets: PuzzlePiece,
	sections: Stack,
	taxonomy: Folders,
	tags: Tag,
	bylines: IdentificationCard,
	contentTypes: Database,
	plugins: Plug,
} as const satisfies Record<string, Icon>;

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

const lazyIconCache = new Map<string, React.ElementType>();

function isIconComponent(value: unknown): value is React.ComponentType<{ className?: string }> {
	return (
		typeof value === "function" ||
		(typeof value === "object" && value !== null && "$$typeof" in value)
	);
}

/** Resolve a plugin page icon while keeping uncommon Phosphor icons code-split. */
export function resolveNavIcon(name?: string): React.ElementType {
	if (!name) {
		return ADMIN_NAV_ICONS.plugins;
	}
	const mapped = PLUGIN_NAV_ICON_MAP[name];
	if (mapped) {
		return mapped;
	}
	const componentName = toPhosphorIconName(name);
	let icon = lazyIconCache.get(componentName);
	if (!icon) {
		icon = React.lazy(async () => {
			const mod = await import("@phosphor-icons/react");
			const candidate: unknown = Object.entries(mod).find(
				([exportName]) => exportName === componentName,
			)?.[1];
			return { default: isIconComponent(candidate) ? candidate : ADMIN_NAV_ICONS.plugins };
		});
		lazyIconCache.set(componentName, icon);
	}
	return icon;
}
