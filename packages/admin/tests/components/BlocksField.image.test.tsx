import { Toasty } from "@cloudflare/kumo";
import * as React from "react";
import { createPortal } from "react-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page, userEvent, type Locator } from "vitest/browser";

import "../../dist/styles.css";
import { ContentEditor, type FieldDescriptor } from "../../src/components/ContentEditor.js";
import type { ContentItem } from "../../src/lib/api";
import type { BlockFieldDefinition, BlockType } from "../../src/lib/api/schema.js";
import { render } from "../utils/render.js";

vi.mock("@tanstack/react-router", async () => {
	const actual = await vi.importActual("@tanstack/react-router");
	return {
		...actual,
		Link: ({ children, ...props }: React.ComponentProps<"a">) => <a {...props}>{children}</a>,
		useBlocker: () => ({ status: "idle" }),
	};
});

vi.mock("../../src/lib/api", async () => {
	const actual = await vi.importActual("../../src/lib/api");
	return {
		...actual,
		fetchBylines: vi.fn(async () => ({ items: [], nextCursor: null })),
		fetchReferenceChildren: vi.fn(async () => ({ children: [] })),
	};
});

vi.mock("../../src/components/TaxonomySidebar", () => ({
	TaxonomySidebar: () => null,
	useHasApplicableTaxonomies: () => false,
}));

// Like the real modal, it closes on Escape and hands focus back to the element that opened it.
vi.mock("../../src/components/MediaPickerModal", () => ({
	MediaPickerModal: (props: { open: boolean; onOpenChange: (open: boolean) => void }) => {
		const opener = React.useRef<HTMLElement | null>(null);
		const wasOpen = React.useRef(false);
		if (props.open && !wasOpen.current) opener.current = document.activeElement as HTMLElement;
		wasOpen.current = props.open;
		React.useEffect(() => {
			if (!props.open) opener.current?.focus();
		}, [props.open]);
		return props.open
			? createPortal(
					<div
						role="dialog"
						aria-label="Media library"
						onKeyDown={(event) => {
							if (event.key === "Escape") props.onOpenChange(false);
						}}
					>
						<button type="button" autoFocus>
							Upload
						</button>
					</div>,
					document.body,
				)
			: null;
	},
}));

const PHOTO =
	"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='9'/%3E";

function blockType(slug: string, label: string, fields: BlockFieldDefinition[]): BlockType {
	return {
		id: `${slug}-type`,
		slug,
		label,
		currentVersion: 1,
		source: "seed",
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		versions: [
			{
				id: `${slug}-v1`,
				blockTypeId: `${slug}-type`,
				version: 1,
				fields,
				fingerprint: slug,
				active: true,
				createdAt: "2026-01-01T00:00:00.000Z",
				updatedAt: "2026-01-01T00:00:00.000Z",
			},
		],
	};
}

const cta = blockType("cta", "Call to action", [
	{ slug: "headline", label: "Headline", type: "string" },
	{ slug: "body", label: "Body", type: "text" },
	{ slug: "background", label: "Background image", type: "image" },
]);

const logos = blockType("logos", "Logo wall", [
	{
		slug: "logos",
		label: "Logos",
		type: "repeater",
		validation: {
			subFields: [
				{ slug: "name", label: "Company name", type: "string" },
				{ slug: "logo", label: "Logo", type: "image" },
			],
		},
	},
]);

const ctaBlock = {
	_type: "cta",
	_version: 1,
	_key: "cta-1",
	headline: "See what your buildings could save.",
	body: "Book a walkthrough with a building engineer.",
	background: { id: "media-1", src: PHOTO, alt: "", width: 16, height: 9 },
};

function renderEditor(content: unknown[], blockTypes: BlockType[]) {
	const fields: Record<string, FieldDescriptor> = {
		title: { kind: "string", label: "Title" },
		content: {
			kind: "blocks",
			label: "Content",
			validation: { allowedTypes: blockTypes.map((type) => type.slug), retiredTypes: [] },
			blockTypes,
		},
	};
	const item: ContentItem = {
		id: "page-1",
		type: "pages",
		slug: "home",
		status: "draft",
		data: { title: "Home", content },
		authorId: null,
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		publishedAt: null,
		scheduledAt: null,
		liveRevisionId: null,
		draftRevisionId: null,
	};
	return render(
		<ContentEditor
			collection="pages"
			collectionLabel="Page"
			fields={fields}
			isNew={false}
			item={item}
			onSave={vi.fn()}
		/>,
		{ wrapper: Toasty },
	);
}

function photo(): Locator {
	return page.getByRole("group", { name: "Background image", exact: true });
}

function opacityOf(locator: Locator): number {
	let opacity = 1;
	for (let el: Element | null = locator.element(); el; el = el.parentElement) {
		opacity *= Number(getComputedStyle(el).opacity);
	}
	return opacity;
}

function textStart(element: Element, rtl: boolean): number {
	const range = document.createRange();
	range.selectNodeContents(element);
	const rect = range.getBoundingClientRect();
	return rtl ? rect.right : rect.left;
}

async function park() {
	await userEvent.hover(page.getByRole("textbox", { name: "Title" }));
}

afterEach(async () => {
	document.documentElement.dir = "ltr";
	await page.viewport(1280, 800);
});

describe("An image inside a block", () => {
	it.each([false, true])(
		"lines the photo up with the label text and the other fields' text (rtl: %s)",
		async (rtl) => {
			document.documentElement.dir = rtl ? "rtl" : "ltr";
			await renderEditor([ctaBlock], [cta]);
			await page.getByRole("button", { name: "Call to action", exact: true }).click();
			const img = photo().element().querySelector("img")!;
			await expect.poll(() => img.getBoundingClientRect().width).toBeGreaterThan(0);

			const label = document.getElementById(photo().element().getAttribute("aria-labelledby")!)!;
			const body = page.getByRole("textbox", { name: "Body" }).element();
			const bodyStyle = getComputedStyle(body);
			const bodyRect = body.getBoundingClientRect();
			const textEnd = rtl
				? bodyRect.left + Number.parseFloat(bodyStyle.paddingLeft)
				: bodyRect.right - Number.parseFloat(bodyStyle.paddingRight);
			const rect = img.getBoundingClientRect();

			expect(rtl ? rect.right : rect.left).toBeCloseTo(textStart(label, rtl), 0);
			expect(rtl ? rect.left : rect.right).toBeCloseTo(textEnd, 0);
		},
	);

	it("shows quiet, neutral actions over the photo only while it is hovered", async () => {
		await renderEditor([ctaBlock], [cta]);
		await page.getByRole("button", { name: "Call to action", exact: true }).click();
		const replace = photo().getByRole("button", { name: "Replace", exact: true });
		const edit = photo().getByRole("button", { name: "Edit asset" });
		const remove = photo().getByRole("button", { name: "Remove image" });
		await expect.element(edit).toHaveTextContent("");
		await expect.element(remove).toHaveTextContent("");

		await park();
		await expect.poll(() => opacityOf(replace)).toBe(0);
		await userEvent.hover(photo().element().querySelector("img")!);
		await expect.poll(() => opacityOf(replace)).toBe(1);
		expect(opacityOf(remove)).toBe(1);

		await remove.click();
		await expect.element(page.getByRole("button", { name: "Select image" })).toBeVisible();
	});

	it("hides the actions again once the picker opened with the pointer closes, but shows them for the keyboard", async () => {
		await renderEditor([ctaBlock], [cta]);
		await page.getByRole("button", { name: "Call to action", exact: true }).click();
		const replace = photo().getByRole("button", { name: "Replace", exact: true });

		await userEvent.hover(photo().element().querySelector("img")!);
		await replace.click();
		await expect.element(page.getByRole("dialog", { name: "Media library" })).toBeVisible();
		await userEvent.keyboard("{Escape}");
		await expect
			.element(page.getByRole("dialog", { name: "Media library" }))
			.not.toBeInTheDocument();
		await expect.element(replace).toHaveFocus();
		await park();
		await expect.poll(() => opacityOf(replace)).toBe(0);

		await userEvent.keyboard("{Tab}");
		await expect.element(photo().getByRole("button", { name: "Edit asset" })).toHaveFocus();
		await expect.poll(() => opacityOf(replace)).toBe(1);
	});

	it("shows the actions to the keyboard after a picker opened with the pointer hands focus elsewhere", async () => {
		await renderEditor([ctaBlock], [cta]);
		await page.getByRole("button", { name: "Call to action", exact: true }).click();
		const body = page.getByRole("textbox", { name: "Body" });
		const replace = photo().getByRole("button", { name: "Replace", exact: true });

		// As in Safari, the click doesn't focus the button, so the picker hands focus back to Body.
		body.element().focus();
		replace
			.element()
			.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }));
		await expect.element(page.getByRole("dialog", { name: "Media library" })).toBeVisible();
		await userEvent.keyboard("{Escape}");
		await expect.element(body).toHaveFocus();
		await park();

		await userEvent.keyboard("{Tab}");
		await expect.element(replace).toHaveFocus();
		await expect.poll(() => opacityOf(replace)).toBe(1);
	});

	it("outlines an empty logo cell only while its row is hovered", async () => {
		await renderEditor(
			[
				{
					_type: "logos",
					_version: 1,
					_key: "logos-1",
					logos: [{ name: "Arc" }, { name: "Norma" }],
				},
			],
			[logos],
		);
		await page.getByRole("button", { name: "Logo wall", exact: true }).click();
		const cell = page.getByRole("button", { name: "Select Logo" }).first();
		const borderAlpha = () => {
			const color = getComputedStyle(cell.element()).borderTopColor;
			return color === "transparent" || /,\s*0\)$/.test(color) ? 0 : 1;
		};

		await park();
		await expect.poll(borderAlpha).toBe(0);
		await userEvent.hover(page.getByRole("textbox", { name: "Company name 1" }));
		await expect.poll(borderAlpha).toBe(1);
	});

	it("hides a logo cell's remove button again once the picker opened with the pointer closes", async () => {
		await renderEditor(
			[
				{
					_type: "logos",
					_version: 1,
					_key: "logos-1",
					logos: [{ name: "Arc", logo: { id: "media-1", src: PHOTO } }],
				},
			],
			[logos],
		);
		await page.getByRole("button", { name: "Logo wall", exact: true }).click();
		const cell = page.getByRole("button", { name: "Replace Logo" });
		const remove = page.getByRole("button", { name: "Remove Logo" });

		await cell.click();
		await expect.element(page.getByRole("dialog", { name: "Media library" })).toBeVisible();
		await userEvent.keyboard("{Escape}");
		await expect.element(cell).toHaveFocus();
		await park();
		await expect.poll(() => opacityOf(remove)).toBe(0);

		await userEvent.keyboard("{Tab}");
		await expect.element(remove).toHaveFocus();
		await expect.poll(() => opacityOf(remove)).toBe(1);
	});
});
