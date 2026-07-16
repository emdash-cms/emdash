import {
	ArrowsLeftRight,
	ChatsCircle,
	Database,
	Files,
	Folders,
	IdentificationCard,
	ImagesSquare,
	List,
	Plug,
	PuzzlePiece,
	SquaresFour,
	Stack,
	Tag,
} from "@phosphor-icons/react";
import { describe, expect, it } from "vitest";

import { ADMIN_NAV_ICONS, getTaxonomyNavIcon } from "../../src/components/admin-navigation-icons";

describe("ADMIN_NAV_ICONS", () => {
	it("keeps shared admin navigation surfaces on the approved icon set", () => {
		expect(ADMIN_NAV_ICONS).toEqual({
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
		});
	});
});

describe("getTaxonomyNavIcon", () => {
	it("uses the tag glyph for the tag taxonomy", () => {
		expect(getTaxonomyNavIcon("tag")).toBe(Tag);
	});

	it("uses folders for categories and custom taxonomies", () => {
		expect(getTaxonomyNavIcon("category")).toBe(Folders);
		expect(getTaxonomyNavIcon("topics")).toBe(Folders);
	});
});
