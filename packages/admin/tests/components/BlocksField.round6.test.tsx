import { Toasty } from "@cloudflare/kumo";
import * as React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";

import "../../dist/styles.css";
import { BlocksField, type BlocksFieldProps } from "../../src/components/BlocksField.js";
import type { BlockFieldDefinition, BlockType } from "../../src/lib/api/schema.js";
import type { StoredBlockValue } from "../../src/lib/block-field-state.js";
import { render } from "../utils/render.js";

const LINK_PATTERN = "^(?:$|(?:https?://|mailto:|tel:|/(?!/)|#).+)$";
const LINK_HINT = "Starts with /, https://, mailto:, tel: or #";
const LINK_PROBLEM = `Invalid link. ${LINK_HINT}`;

function blockType(slug: string, label: string, fields: BlockFieldDefinition[]): BlockType {
	return {
		id: `${slug}-type`,
		slug,
		label,
		category: "Layout",
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

const SHORT = blockType("short", "Short", [{ slug: "title", label: "Title", type: "string" }]);

const STATS = blockType("stats", "Stats", [
	{
		slug: "stats",
		label: "Stats",
		type: "repeater",
		validation: {
			subFields: [
				{ slug: "value", label: "Value", type: "string" },
				{ slug: "label", label: "Label", type: "string", required: true },
			],
		},
	},
]);

const LINKED = blockType("linked", "Linked", [
	{ slug: "title", label: "Title", type: "string" },
	{
		slug: "cta_url",
		label: "Link (starts with /, https://, mailto:, tel: or #)",
		type: "string",
		validation: { pattern: LINK_PATTERN },
	},
]);

const TYPES = [SHORT, STATS, LINKED];

const short = (key: string): StoredBlockValue => ({
	_type: "short",
	_version: 1,
	_key: key,
	title: key,
});
const stats = (): StoredBlockValue => ({
	_type: "stats",
	_version: 1,
	_key: "stats",
	stats: [
		{ value: "23%", label: "Lower spend" },
		{ value: "4x", label: "Faster" },
		{ value: "9", label: "Regions" },
	],
});
const linked = (): StoredBlockValue => ({
	_type: "linked",
	_version: 1,
	_key: "linked",
	title: "Contact",
});

function Harness({
	initial,
	retiredTypes = [],
}: {
	initial: StoredBlockValue[];
	retiredTypes?: string[];
}) {
	const [value, setValue] = React.useState(initial);
	const props: BlocksFieldProps = {
		id: "field-layout",
		fieldPath: "layout",
		label: "Layout",
		value,
		onChange: setValue,
		blockTypes: TYPES,
		allowedTypes: TYPES.map((type) => type.slug),
		retiredTypes,
		renderField: ({ name, value: fieldValue, onChange, chrome }) => (
			<input
				id={`field-${name}`}
				aria-labelledby={chrome.labelledBy}
				aria-invalid={chrome.invalid || undefined}
				className="h-8 w-full"
				value={typeof fieldValue === "string" ? fieldValue : ""}
				onChange={(event) => onChange(event.target.value)}
			/>
		),
	};
	return <BlocksField {...props} />;
}

function renderField(
	initial: StoredBlockValue[],
	{ width = 480, retiredTypes }: { width?: number; retiredTypes?: string[] } = {},
) {
	return render(
		<div style={{ width, marginInline: 80 }}>
			<Harness initial={initial} retiredTypes={retiredTypes} />
		</div>,
		{ wrapper: Toasty },
	);
}

const row = (key: string) => document.querySelector<HTMLElement>(`[data-block-key="${key}"]`)!;
const toggleOf = (key: string) => row(key).querySelector<HTMLElement>("[data-block-toggle]")!;
const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
const running = () => document.getAnimations().filter((a) => a.playState === "running");
const settled = () => expect.poll(() => running().length).toBe(0);
const textbox = (name: string) => page.getByRole("textbox", { name, exact: true });
const link = () => textbox("Link");

function shown(element: Element): boolean {
	return (
		!element.closest(".sr-only, [hidden]") &&
		element.getBoundingClientRect().width > 1 &&
		element.checkVisibility({ opacityProperty: true, visibilityProperty: true })
	);
}

function ownText(element: Element): string {
	return [...element.childNodes]
		.filter((node) => node.nodeType === 3)
		.map((node) => node.textContent ?? "")
		.join("")
		.trim();
}

/** Whether `text` shows anywhere in the blocks field. */
const showsText = (text: string) =>
	[...document.querySelectorAll("[data-blocks-field] *")].some(
		(element) => ownText(element) === text && shown(element),
	);

async function openLinked(width?: number) {
	await renderField([linked(), short("after")], { width });
	await page.getByRole("button", { name: "Linked", exact: true }).click();
	await settled();
}

afterEach(() => {
	// A test that fails part way could leave a press unlanded for the next one.
	document.body.dispatchEvent(new PointerEvent("pointercancel", { bubbles: true }));
});

describe("Focus left by a press that opens a popup", () => {
	it("still leaves the control it left", async () => {
		await openLinked();
		await link().fill("not a link");

		await page.getByRole("button", { name: "Linked actions" }).click();
		await expect.element(page.getByRole("menu")).toBeVisible();

		await expect.element(link()).toHaveAttribute("aria-invalid", "true");
		await userEvent.keyboard("{Escape}");
		await expect.element(page.getByRole("menu")).not.toBeInTheDocument();
		await expect.element(link()).toHaveAttribute("aria-invalid", "true");
	});

	it.each([
		["beside the value", 1100],
		["on the label's line", 400],
	])("stops showing the control's hint %s", async (_where, width) => {
		await openLinked(width);
		await link().fill("/contact");
		await expect.poll(() => showsText(LINK_HINT)).toBe(true);

		await page.getByRole("button", { name: "Linked actions" }).click();
		await expect.element(page.getByRole("menu")).toBeVisible();
		await userEvent.keyboard("{Escape}");
		await expect.element(page.getByRole("menu")).not.toBeInTheDocument();

		await expect.poll(() => showsText(LINK_HINT)).toBe(false);
	});
});

describe("Focus left by a press that moves the control in its list", () => {
	it("touches the control where it is once the press lands", async () => {
		await renderField([stats()]);
		await page.getByRole("button", { name: "Stats", exact: true }).click();
		await settled();
		await page
			.getByRole("table")
			.getByRole("button", { name: /actions$/ })
			.first()
			.click();
		await page.getByRole("menuitem", { name: "Delete" }).click();
		await expect.element(page.getByRole("button", { name: "Undo" })).toBeVisible();
		await settled();
		await expect.element(textbox("Label 2")).toHaveValue("Regions");

		await textbox("Label 2").fill("");
		await page.getByRole("button", { name: "Undo" }).click();
		await expect.element(textbox("Label 1")).toHaveValue("Lower spend");

		await expect.element(textbox("Label 3")).toHaveAttribute("aria-invalid", "true");
		expect(textbox("Label 2").element().getAttribute("aria-invalid")).toBeNull();
	});
});

describe("A press whose release the page never sees", () => {
	/** Presses a pointer down with `button` and lets nothing else of the press reach the page. */
	const pressDown = (button: number) =>
		document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button }));

	async function leaveByKeyboard() {
		(textbox("Title").element() as HTMLElement).focus();
		await expect.element(link()).toHaveAttribute("aria-invalid", "true");
	}

	it("doesn't hold back focus leaving when it was a secondary button", async () => {
		await openLinked();
		await link().fill("not a link");

		pressDown(2);
		await leaveByKeyboard();
	});

	it.each([
		[
			"a context menu opens",
			() => document.body.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true })),
		],
		[
			"a key is pressed",
			() =>
				document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true })),
		],
		["the window loses focus", () => window.dispatchEvent(new FocusEvent("blur"))],
		["the page is hidden", () => document.dispatchEvent(new Event("visibilitychange"))],
	])("counts as landed once %s", async (_what, lose) => {
		await openLinked();
		await link().fill("not a link");

		pressDown(0);
		lose();
		await leaveByKeyboard();
	});

	it.each([
		["a modifier is pressed", { key: "Shift" }],
		["a held key repeats", { key: "a", repeat: true }],
	])("keeps waiting when %s, as part of the click", async (_what, init) => {
		await openLinked();
		await link().fill("not a link");

		pressDown(0);
		document.body.dispatchEvent(new KeyboardEvent("keydown", { ...init, bubbles: true }));
		(textbox("Title").element() as HTMLElement).focus();
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(link().element().getAttribute("aria-invalid")).toBeNull();

		document.body.dispatchEvent(new PointerEvent("pointercancel", { bubbles: true }));
		await expect.element(link()).toHaveAttribute("aria-invalid", "true");
	});
});

describe("Focus left by a press that closes its block at once", () => {
	it("still leaves the control it left", async () => {
		await renderField([linked(), short("after")]);
		await page.getByRole("button", { name: "Expand all" }).click();
		await settled();
		await link().fill("not a link");

		await page.getByRole("button", { name: "Collapse all" }).click();
		await settled();
		await page.getByRole("button", { name: "Linked", exact: true }).click();
		await settled();

		await expect.element(link()).toHaveAttribute("aria-invalid", "true");
	});
});

describe("A settings row's problem line, as it goes", () => {
	it("keeps its problem until it has shrunk away", async () => {
		await openLinked(560);
		await link().fill("contact us");
		await textbox("Title").click();
		await expect.poll(() => showsText(LINK_PROBLEM)).toBe(true);
		await settled();
		const line = [...document.querySelectorAll("[data-blocks-field] p:not([hidden])")].find(
			(element) => element.textContent?.trim() === LINK_PROBLEM,
		)!;
		const panel = line.parentElement!;
		const full = panel.getBoundingClientRect().height;

		await link().click();
		await link().fill("/contact");
		(textbox("Title").element() as HTMLElement).focus();
		const frames: Array<{ height: number; text: string }> = [];
		for (let count = 0; count < 60; count++) {
			await frame();
			frames.push({
				height: panel.getBoundingClientRect().height,
				text: line.textContent?.trim() ?? "",
			});
		}

		const shrinking = frames.filter(({ height }) => height > 1 && height < full - 1);
		expect(shrinking.length).toBeGreaterThan(0);
		expect(shrinking.map(({ text }) => text)).toEqual(shrinking.map(() => LINK_PROBLEM));
		expect(frames.at(-1)!.height).toBeLessThan(1);
	});

	it("fades a problem fixed while typing, and holds its line until focus leaves", async () => {
		await openLinked(560);
		await link().fill("contact us");
		await textbox("Title").click();
		await expect.poll(() => showsText(LINK_PROBLEM)).toBe(true);
		await settled();
		const line = [...document.querySelectorAll("[data-blocks-field] p:not([hidden])")].find(
			(element) => element.textContent?.trim() === LINK_PROBLEM,
		)!;
		const panel = line.parentElement!;
		const full = panel.getBoundingClientRect().height;

		await link().click();
		await link().fill("/contact");
		await settled();
		expect(Number(getComputedStyle(line.firstElementChild!).opacity)).toBe(0);
		expect(panel.getBoundingClientRect().height).toBeCloseTo(full, 0);
	});
});

describe("A block's status badge", () => {
	it("opens and closes the block like the rest of its head", async () => {
		await renderField([short("old"), short("after")], { retiredTypes: ["short"] });
		const toggle = toggleOf("old");
		await expect.element(page.elementLocator(toggle)).toHaveAccessibleDescription(/Retired/);
		const badge = page.elementLocator(row("old")).getByText("Retired", { exact: true });

		await badge.click();
		await settled();
		expect(toggle.getAttribute("aria-expanded")).toBe("true");
		await badge.click();
		await settled();
		expect(toggle.getAttribute("aria-expanded")).toBe("false");
	});
});
