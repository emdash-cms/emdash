import {
	Browser,
	CardsThree,
	Chats,
	Database,
	Download,
	Files,
	Folders,
	IdentificationCard,
	ImagesSquare,
	Newspaper,
	Path,
	Plug,
	PuzzlePiece,
	Rows,
	Signature,
	SquaresFour,
	Tag,
} from "@phosphor-icons/react";
import { describe, expect, it } from "vitest";

import {
	ADMIN_NAV_ICONS,
	getCollectionNavIcon,
	getTaxonomyNavIcon,
} from "../../src/components/admin-navigation-icons";

describe("ADMIN_NAV_ICONS", () => {
	it("keeps shared admin navigation surfaces on the approved icon set", () => {
		expect(ADMIN_NAV_ICONS).toEqual({
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
		});
	});
});

describe("getCollectionNavIcon", () => {
	it("uses the approved overrides for pages and posts", () => {
		expect(getCollectionNavIcon("pages")).toBe(Browser);
		expect(getCollectionNavIcon("posts")).toBe(Newspaper);
	});

	it("uses files for custom collections", () => {
		expect(getCollectionNavIcon("products")).toBe(Files);
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
