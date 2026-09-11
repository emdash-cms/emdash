import {
	Browser,
	CalendarBlank,
	CardsThree,
	Chats,
	Database,
	Download,
	Files,
	Folder,
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
	Trophy,
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
			folder: Folder,
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

	it("prefers a declared icon over the slug defaults", () => {
		expect(getCollectionNavIcon("pages", "calendar")).toBe(CalendarBlank);
		expect(getCollectionNavIcon("products", "trophy")).toBe(Trophy);
	});

	it("never treats object prototype members as icons", () => {
		for (const name of ["constructor", "valueOf", "__proto__", "hasOwnProperty"]) {
			expect(getCollectionNavIcon(name)).toBe(ADMIN_NAV_ICONS.collection);
			const declared = getCollectionNavIcon("pages", name);
			expect(declared).not.toBe(Object.prototype);
			expect(declared).not.toBe((Object.prototype as Record<string, unknown>)[name]);
		}
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
