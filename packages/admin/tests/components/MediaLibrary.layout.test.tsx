import { Sidebar, Toasty } from "@cloudflare/kumo";
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";

import "../../dist/styles.css";
import { MediaLibrary } from "../../src/components/MediaLibrary.js";
import type { LocalMediaItem, MediaFolder, MediaItem } from "../../src/lib/api/media.js";
import { formatFileSize } from "../../src/lib/media-utils.js";
import { render } from "../utils/render.js";

vi.mock("../../src/lib/api", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../src/lib/api")>()),
	fetchMediaProviders: vi.fn().mockResolvedValue([]),
}));

vi.mock("@tanstack/react-router", async (importOriginal) => ({
	...(await importOriginal<typeof import("@tanstack/react-router")>()),
	Link: ({
		children,
		to,
		params: _params,
		search: _search,
		...props
	}: React.ComponentProps<"a"> & { to?: string; params?: unknown; search?: unknown }) => (
		<a href={typeof to === "string" ? to : "#"} {...props}>
			{children}
		</a>
	),
}));

vi.mock("../../src/lib/api/current-user.js", () => ({
	useCurrentUser: () => ({ data: { id: "user-1", role: 30 } }),
}));

const items: MediaItem[] = Array.from({ length: 35 }, (_, index) => ({
	id: `media-${index}`,
	filename: `document-${index}.txt`,
	mimeType: "text/plain",
	url: `/media/document-${index}.txt`,
	size: 1024,
	createdAt: "2026-01-01T00:00:00Z",
}));

function localItem(id: string, overrides: Partial<LocalMediaItem>): LocalMediaItem {
	return {
		id,
		filename: `${id}.txt`,
		mimeType: "text/plain",
		url: `/media/${id}`,
		size: 1024,
		createdAt: "2026-01-01T00:00:00Z",
		storageKey: id,
		authorId: "user-1",
		folderId: null,
		...overrides,
	};
}

const listItems = [
	localItem("hero", {
		filename: "campaign_hero_banner_final_approved_version_2026_q1_export_retina.png",
		mimeType: "image/png",
		size: 2_457_600,
		alt: "A hero banner",
	}),
	localItem("report", {
		filename: "quarterly-report.docx",
		mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
		size: 48_000,
	}),
	localItem("note", { filename: "a.txt", size: 12 }),
];

const folders: MediaFolder[] = [
	{ id: "folder-1", name: "Campaign assets with a deliberately long folder name for spring" },
	{ id: "folder-2", name: "ProductPhotographyForTheSpringCatalogueWithoutAnySpaces" },
];

function renderListView({ dir = "ltr", width }: { dir?: "ltr" | "rtl"; width: number }) {
	return render(
		<Toasty>
			<div dir={dir} style={{ width }}>
				<MediaLibrary
					items={listItems}
					folders={folders}
					canManageFolders
					onCreateFolder={vi.fn()}
					onRenameFolder={vi.fn()}
					onDeleteFolder={vi.fn()}
					canMoveMedia={() => true}
					onMoveMedia={vi.fn().mockResolvedValue(undefined)}
				/>
			</div>
		</Toasty>,
	);
}

function expectInside(element: Element, box: DOMRect) {
	const bounds = element.getBoundingClientRect();
	expect(bounds.left).toBeGreaterThanOrEqual(box.left);
	expect(bounds.right).toBeLessThanOrEqual(box.right);
}

function pointer(type: string, target: EventTarget, { x, y }: { x: number; y: number }) {
	target.dispatchEvent(
		new PointerEvent(type, { bubbles: true, isPrimary: true, clientX: x, clientY: y }),
	);
}

function center(element: Element) {
	const bounds = element.getBoundingClientRect();
	return { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 };
}

function lineCount(element: Element) {
	const text = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
	const range = document.createRange();
	const tops = new Set<number>();
	for (let node = text.nextNode(); node; node = text.nextNode()) {
		range.selectNodeContents(node);
		for (const rect of range.getClientRects()) tops.add(Math.round(rect.top));
	}
	return tops.size;
}

afterEach(async () => {
	await page.viewport(1280, 800);
});

describe("Media Library pagination layout", () => {
	it("aligns a short library with the sidebar footer as the viewport expands and contracts", async () => {
		const screen = await render(
			<Toasty>
				<div style={{ display: "flex", height: "100vh" }}>
					<aside style={{ display: "flex", flexDirection: "column", width: 260, flexShrink: 0 }}>
						<div style={{ flex: 1 }} />
						<Sidebar.Footer data-testid="sidebar-footer">My Blog</Sidebar.Footer>
					</aside>
					<main style={{ flex: 1, minWidth: 0, overflowY: "auto", padding: 24 }}>
						<MediaLibrary
							items={items.slice(0, 7)}
							pagination={{
								page: 1,
								perPage: 35,
								totalCount: 7,
								isPending: false,
								onPageChange: vi.fn(),
								onPageSizeChange: vi.fn(),
							}}
						/>
					</main>
				</div>
			</Toasty>,
		);
		const main = screen.getByRole("main").element();
		const footer = screen.getByRole("combobox", { name: "Page size" }).element().closest("footer")!;
		const sidebarFooter = screen.getByTestId("sidebar-footer").element();
		for (const [width, height] of [
			[1280, 800],
			[1920, 1200],
			[2560, 1600],
			[1280, 800],
		] as const) {
			await page.viewport(width, height);
			for (const view of ["Grid view", "List view"]) {
				await screen.getByRole("tab", { name: view }).click();
				const bounds = footer.getBoundingClientRect();
				const reference = sidebarFooter.getBoundingClientRect();
				expect(main.scrollHeight).toBe(main.clientHeight);
				expect(bounds.bottom).toBeCloseTo(reference.bottom, 0);
				expect(bounds.top).toBeCloseTo(reference.top, 0);
				expect(bounds.height).toBeCloseTo(reference.height, 0);
			}
		}
	});

	it.each([
		{ width: 1280, direction: "ltr" },
		{ width: 320, direction: "rtl" },
	])(
		"keeps pagination visible while scrolling at $width px in $direction",
		async ({ width, direction }) => {
			await page.viewport(width, 800);
			const screen = await render(
				<Toasty>
					<main dir={direction} style={{ height: 600, overflowY: "auto", padding: 24 }}>
						<MediaLibrary
							items={items}
							pagination={{
								page: 1,
								perPage: 35,
								totalCount: 35,
								isPending: false,
								onPageChange: vi.fn(),
								onPageSizeChange: vi.fn(),
							}}
						/>
					</main>
				</Toasty>,
			);
			const main = screen.getByRole("main").element() as HTMLElement;
			const pagination = screen.getByRole("navigation", { name: "Media pagination" }).element();
			const pageSize = screen.getByRole("combobox", { name: "Page size" }).element();
			const footer = pageSize.closest("footer")!;
			const viewport = main.getBoundingClientRect();

			function expectPaginationInView() {
				expect(footer.getBoundingClientRect().bottom).toBeCloseTo(viewport.bottom, 0);
				for (const control of [pagination, pageSize]) {
					const bounds = control.getBoundingClientRect();
					expect(bounds.top).toBeGreaterThanOrEqual(viewport.top);
					expect(bounds.bottom).toBeLessThanOrEqual(viewport.bottom);
					expect(bounds.left).toBeGreaterThanOrEqual(viewport.left);
					expect(bounds.right).toBeLessThanOrEqual(viewport.right);
				}
			}

			for (const view of ["Grid view", "List view"]) {
				main.scrollTop = 0;
				await screen.getByRole("tab", { name: view }).click();
				expect(main.scrollHeight).toBeGreaterThan(main.clientHeight);
				expectPaginationInView();
				const item = screen
					.getByRole("button", { name: "document-12.txt", exact: true })
					.element() as HTMLElement;
				main.scrollTop +=
					item.getBoundingClientRect().bottom - footer.getBoundingClientRect().top - 10;
				expect(item.getBoundingClientRect().bottom).toBeGreaterThan(
					footer.getBoundingClientRect().top,
				);
				item.focus();
				expect(item.getBoundingClientRect().bottom).toBeLessThanOrEqual(
					footer.getBoundingClientRect().top,
				);
				main.scrollTop = (main.scrollHeight - main.clientHeight) / 2;
				expect(main.scrollTop).toBeGreaterThan(0);
				expectPaginationInView();
				main.scrollTop = main.scrollHeight;
				expectPaginationInView();
				const lastFilename = screen.getByText("document-34.txt", { exact: true }).element();
				expect(lastFilename.getBoundingClientRect().bottom).toBeLessThan(
					footer.getBoundingClientRect().top,
				);
			}
		},
	);
});

describe("Media Library list view at phone width", () => {
	it.each(["ltr", "rtl"] as const)(
		"shows each file's name and details and each folder's controls in a 272px table in %s",
		async (dir) => {
			const screen = await renderListView({ dir, width: 272 });
			await screen.getByRole("tab", { name: "List view" }).click();
			const tray = screen.getByRole("table").element().parentElement!;
			const box = tray.getBoundingClientRect();

			expect(tray.scrollWidth).toBeLessThanOrEqual(tray.clientWidth);
			for (const name of ["Type", "Size", "Alt text"]) {
				expect(
					screen.getByRole("columnheader", { name, includeHidden: true }).element(),
				).not.toBeVisible();
			}
			for (const item of listItems) {
				const filename = screen.getByRole("button", { name: item.filename, exact: true });
				await expect.element(filename).toBeVisible();
				expectInside(filename.element(), box);
				const cell = page.elementLocator(filename.element().closest("td")!);
				for (const detail of [
					item.mimeType,
					formatFileSize(item.size),
					item.alt ? "Alt text set" : "No alt text",
				]) {
					const text = cell.getByText(detail, { exact: true });
					await expect.element(text).toBeVisible();
					expectInside(text.element(), box);
				}
			}
			for (const folder of folders) {
				for (const control of [
					screen.getByRole("link", { name: `Open folder ${folder.name}` }),
					screen.getByRole("button", { name: `Edit folder ${folder.name}` }),
				]) {
					await expect.element(control).toBeVisible();
					expectInside(control.element(), box);
				}
			}
		},
	);
});

describe("Media Library list view at desktop width", () => {
	it("keeps each file's size and alt text on one line beside a long filename in a 716px table", async () => {
		const screen = await renderListView({ width: 716 });
		await screen.getByRole("tab", { name: "List view" }).click();
		const tray = screen.getByRole("table").element().parentElement!;

		expect(tray.scrollWidth).toBeLessThanOrEqual(tray.clientWidth);
		for (const item of listItems) {
			const row = screen
				.getByRole("button", { name: item.filename, exact: true })
				.element()
				.closest("tr")!;
			for (const cell of [...row.cells].slice(3)) {
				expect(cell.checkVisibility()).toBe(true);
				expect(lineCount(cell)).toBe(1);
			}
		}
	});
});

describe("Media Library list view drop target", () => {
	it.each([
		{ position: "first", dir: "ltr" },
		{ position: "first", dir: "rtl" },
		{ position: "second", dir: "ltr" },
		{ position: "second", dir: "rtl" },
	] as const)(
		"outlines the $position folder row while a file is dragged over it in $dir",
		async ({ position, dir }) => {
			const screen = await renderListView({ dir, width: 900 });
			await screen.getByRole("tab", { name: "List view" }).click();
			const source = screen
				.getByRole("button", { name: "a.txt", exact: true })
				.element()
				.closest("tr")!;
			const folderRow = (folder: MediaFolder) =>
				screen
					.getByRole("link", { name: `Open folder ${folder.name}` })
					.element()
					.closest("tr")!;
			const first = folderRow(folders[0]!);
			const second = folderRow(folders[1]!);
			const [target, other] = position === "first" ? [first, second] : [second, first];
			expect(first.sectionRowIndex).toBe(0);
			const cardCorner = getComputedStyle(first.cells[0]!).borderStartStartRadius;
			expect(parseFloat(cardCorner)).toBeGreaterThan(0);
			const brand = document.createElement("span");
			brand.style.color = "var(--color-kumo-brand)";
			screen.container.append(brand);

			const start = center(source);
			pointer("pointerdown", source, start);
			pointer("pointermove", document, { x: start.x, y: start.y - 20 });
			pointer("pointermove", document, center(target));
			try {
				await expect.poll(() => target.hasAttribute("data-drop-active")).toBe(true);
				const outline = getComputedStyle(target);
				expect(outline.outlineStyle).toBe("dashed");
				expect(parseFloat(outline.outlineWidth)).toBeGreaterThanOrEqual(2);
				expect(outline.outlineColor).toBe(getComputedStyle(brand).color);
				const top = position === "first" ? cardCorner : "0px";
				expect([
					outline.borderTopLeftRadius,
					outline.borderTopRightRadius,
					outline.borderBottomRightRadius,
					outline.borderBottomLeftRadius,
				]).toEqual([top, top, "0px", "0px"]);
				expect(target.cells).toHaveLength(other.cells.length);
				for (const [index, cell] of [...target.cells].entries()) {
					expect(getComputedStyle(cell).backgroundColor).not.toBe(
						getComputedStyle(other.cells[index]!).backgroundColor,
					);
				}
				expect(getComputedStyle(other).outlineStyle).toBe("none");
			} finally {
				pointer("pointercancel", document, center(target));
				// dnd-kit keeps stopping clicks for 50ms after a drag ends.
				await new Promise((resolve) => setTimeout(resolve, 50));
			}
		},
	);
});

describe("Media Library list view hover", () => {
	it("tints a file row under the pointer but not a folder row", async () => {
		const screen = await renderListView({ width: 900 });
		await screen.getByRole("tab", { name: "List view" }).click();
		const fileRow = (filename: string) =>
			screen.getByRole("button", { name: filename, exact: true }).element().closest("tr")!;
		const folderRow = screen
			.getByRole("link", { name: `Open folder ${folders[0]!.name}` })
			.element()
			.closest("tr")!;
		const backgrounds = (row: HTMLTableRowElement) =>
			Array.from(row.cells, (cell) => getComputedStyle(cell).backgroundColor);
		const hovered = fileRow("a.txt");
		const resting = backgrounds(fileRow("quarterly-report.docx"));
		const folderResting = backgrounds(folderRow);

		await userEvent.hover(hovered.cells[2]!);
		const tinted = backgrounds(hovered);
		expect(new Set(tinted).size).toBe(1);
		expect(tinted).not.toEqual(resting);

		await userEvent.hover(folderRow.cells[2]!);
		expect(backgrounds(folderRow)).toEqual(folderResting);
	});
});
