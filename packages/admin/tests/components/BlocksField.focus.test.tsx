import { Toasty } from "@cloudflare/kumo";
import * as React from "react";
import { flushSync } from "react-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";

import "../../dist/styles.css";
import { BlocksField, type BlocksFieldProps } from "../../src/components/BlocksField.js";
import { useQuietReturnFocus } from "../../src/components/useQuietReturnFocus.js";
import type { BlockFieldDefinition, BlockType } from "../../src/lib/api/schema.js";
import type { StoredBlockValue } from "../../src/lib/block-field-state.js";
import { render } from "../utils/render.js";

const LINK_PATTERN = "^(?:$|(?:https?://|mailto:|tel:|/(?!/)|#).+)$";

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
		label: "Link",
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

type HarnessProps = Partial<Omit<BlocksFieldProps, "value" | "onChange">> & {
	initial: StoredBlockValue[];
};

function Harness({ initial, ...extraProps }: HarnessProps) {
	const [value, setValue] = React.useState(initial);
	const props: BlocksFieldProps = {
		id: "field-layout",
		fieldPath: "layout",
		label: "Layout",
		value,
		onChange: setValue,
		blockTypes: TYPES,
		allowedTypes: TYPES.map((type) => type.slug),
		retiredTypes: [],
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
		...extraProps,
	};
	return <BlocksField {...props} />;
}

function renderField(
	initial: StoredBlockValue[],
	{ width = 480, ...props }: Omit<HarnessProps, "initial"> & { width?: number } = {},
) {
	return render(
		<div style={{ width, marginInline: 80 }}>
			<Harness initial={initial} {...props} />
		</div>,
		{ wrapper: Toasty },
	);
}

const advanced = blockType("advanced", "Advanced", [
	{ slug: "title", label: "Title", type: "string" },
	{
		slug: "anchor_id",
		label: "Section ID",
		type: "string",
		validation: { pattern: "^(?:$|[a-z][a-z0-9_-]*)$" },
	},
]);

const advancedBlock = (key: string, anchor_id = "section"): StoredBlockValue => ({
	_type: "advanced",
	_version: 1,
	_key: key,
	title: key,
	anchor_id,
});

const row = (key: string) => document.querySelector<HTMLElement>(`[data-block-key="${key}"]`)!;
const menuButtonOf = (key: string) =>
	page.elementLocator(row(key)).getByRole("button", { name: /actions$/ });
const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
const running = () => document.getAnimations().filter((a) => a.playState === "running");
const settled = () => expect.poll(() => running().length).toBe(0);
const toastOf = () =>
	document.querySelector<HTMLElement>('[role="region"][aria-live] > [role="dialog"]');
const textbox = (name: string) => page.getByRole("textbox", { name, exact: true });
const link = () => textbox("Link");

/** Waits, frame by frame, for `done`. */
async function until(done: () => boolean) {
	for (let count = 0; count < 120 && !done(); count++) await frame();
	expect(done()).toBe(true);
}

async function openLinked() {
	await renderField([linked(), short("after")]);
	await page.getByRole("button", { name: "Linked", exact: true }).click();
	await settled();
}

afterEach(() => {
	// A test that fails part way could leave a press unlanded for the next one.
	document.body.dispatchEvent(new PointerEvent("pointercancel", { bubbles: true }));
});

describe("A linked field focus request", () => {
	it("opens only the addressed block and focuses its field", async () => {
		const onFieldFocused = vi.fn();
		await renderField([short("first"), short("target"), short("last")], {
			focusField: "layout.target.title",
			onFieldFocused,
		});

		await expect.element(textbox("Title")).toHaveFocus();
		expect(onFieldFocused).toHaveBeenCalledOnce();
		expect(textbox("Title").all()).toHaveLength(1);
		await expect
			.element(
				page.elementLocator(row("target")).getByRole("button", { name: "Short", exact: true }),
			)
			.toHaveAttribute("aria-expanded", "true");
		for (const key of ["first", "last"])
			await expect
				.element(page.elementLocator(row(key)).getByRole("button", { name: "Short", exact: true }))
				.toHaveAttribute("aria-expanded", "false");
	});

	it("does not refocus the same request when a field value changes", async () => {
		const onFieldFocused = vi.fn();
		await renderField([linked()], { focusField: "layout.linked.title", onFieldFocused });
		await expect.element(textbox("Title")).toHaveFocus();

		await link().fill("https://example.com");
		await expect.element(link()).toHaveFocus();
		expect(onFieldFocused).toHaveBeenCalledOnce();
	});

	it("opens Advanced for an anchor_id field and focuses it", async () => {
		await renderField([advancedBlock("target")], {
			blockTypes: [advanced],
			allowedTypes: ["advanced"],
			focusField: "layout.target.anchor_id",
		});

		await expect.element(textbox("Section ID")).toHaveFocus();
		await expect
			.element(page.getByRole("button", { name: "Advanced: Advanced" }))
			.toHaveAttribute("aria-expanded", "true");
	});

	it("focuses the add button for an empty repeater", async () => {
		await renderField([{ ...stats(), stats: [] }], { focusField: "layout.stats.stats" });
		await expect.element(page.getByRole("button", { name: "Add item to Stats" })).toHaveFocus();
	});

	it.each([false, true])(
		"focuses a repeater before paused animation frames resume (empty: %s)",
		async (empty) => {
			const servicesType = blockType("services", "Services", [
				{ slug: "heading", label: "Heading", type: "string" },
				{
					slug: "items",
					label: "Items",
					type: "repeater",
					validation: {
						subFields: [
							{ slug: "title", label: "Title", type: "string" },
							{ slug: "text", label: "Text", type: "text" },
						],
					},
				},
			]);
			const initial = [
				{
					_type: "services",
					_version: 1,
					_key: "services",
					heading: "Our services",
					items: empty
						? []
						: [
								{ title: "First service", text: "First description" },
								{ title: "Second service", text: "Second description" },
								{ title: "Third service", text: "Third description" },
							],
				},
			];
			const props = { initial, blockTypes: [servicesType], allowedTypes: ["services"] };
			const screen = await render(<Harness {...props} />, { wrapper: Toasty });
			const onFieldFocused = vi.fn();
			const requestFrame = window.requestAnimationFrame.bind(window);
			const pendingFrames: FrameRequestCallback[] = [];
			const frames = vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
				pendingFrames.push(callback);
				return -pendingFrames.length;
			});
			try {
				await screen.rerender(
					<Harness {...props} focusField="layout.services.items" onFieldFocused={onFieldFocused} />,
				);
				await expect
					.poll(() =>
						row("services").querySelector("[data-block-toggle]")?.getAttribute("aria-expanded"),
					)
					.toBe("true");
				const firstControl = () =>
					empty
						? page.getByRole("button", { name: "Add item to Items", exact: true }).query()
						: row("services").querySelector('[data-field="items"] [data-item-focus]');
				await expect.poll(firstControl).not.toBeNull();
				await expect.poll(() => document.activeElement).toBe(firstControl());
				expect(onFieldFocused).toHaveBeenCalledOnce();
			} finally {
				frames.mockRestore();
				for (const callback of pendingFrames) requestFrame(callback);
				await frame();
			}
		},
	);

	it("focuses a target in read-only mode", async () => {
		await renderField([short("first"), short("target")], {
			focusField: "layout.target.title",
			readOnly: true,
		});

		const target = page.elementLocator(document.querySelector("#field-layout\\.target\\.title")!);
		await expect.element(target).toHaveFocus();
		await expect.element(target).toHaveValue("target");
	});

	it.each(["layout.missing.title", "layout.target.missing"])(
		"does not expand or focus a missing target: %s",
		async (focusField) => {
			const onFieldFocused = vi.fn();
			await renderField([short("target")], { focusField, onFieldFocused });

			await frame();
			expect(textbox("Title").query()).toBeNull();
			expect(onFieldFocused).not.toHaveBeenCalled();
			await expect
				.element(
					page.elementLocator(row("target")).getByRole("button", { name: "Short", exact: true }),
				)
				.toHaveAttribute("aria-expanded", "false");
		},
	);

	it.each(["-1.label", "01.label", "99.label", "one.label", "1.missing", "1.label.extra"])(
		"leaves an invalid indexed repeater target unopened: %s",
		async (path) => {
			const onFieldFocused = vi.fn();
			await renderField([stats()], { focusField: `layout.stats.stats.${path}`, onFieldFocused });
			await frame();
			await expect
				.element(page.getByRole("button", { name: "Stats", exact: true }))
				.toHaveAttribute("aria-expanded", "false");
			expect(onFieldFocused).not.toHaveBeenCalled();
		},
	);

	it("focuses the requested field without revealing another validation issue", async () => {
		await renderField(
			[
				{
					_type: "linked",
					_version: 1,
					_key: "target",
					title: "Target",
					cta_url: "not a link",
				},
			],
			{ focusField: "layout.target.title" },
		);

		await expect.element(textbox("Title")).toHaveFocus();
		await expect.element(textbox("Link")).not.toHaveAttribute("aria-invalid", "true");
	});
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

describe("Focus coming back to an opener from a toast", () => {
	/** An opener whose popup didn't open, as a picker that fails to load. */
	function Opener() {
		const quiet = useQuietReturnFocus();
		return (
			<button type="button" {...quiet.groupProps} onClick={quiet.markOpener}>
				Choose
			</button>
		);
	}

	it("counts as focus from anywhere else, so the opener's controls show", async () => {
		await render(
			<>
				<div style={{ width: 480, marginInline: 80 }}>
					<Harness initial={[short("one"), short("two")]} />
				</div>
				<Opener />
			</>,
			{ wrapper: Toasty },
		);
		await menuButtonOf("one").click();
		await page.getByRole("menuitem", { name: "Delete" }).click();
		await until(() => toastOf() !== null);
		await settled();
		const opener = page.getByRole("button", { name: "Choose", exact: true });
		await opener.click();

		toastOf()!.querySelector<HTMLElement>("button")!.focus();
		(opener.element() as HTMLElement).focus();
		await frame();

		await expect.element(opener).toHaveFocus();
		expect(opener.element().closest("[data-quiet-focus]")).toBeNull();
	});
});

describe("The block picker", () => {
	it("opened by a tap while it still closes from a keyboard opening keeps its search out of focus", async () => {
		await renderField([short("one")]);
		const add = page
			.getByRole("button", { name: "Add block", exact: true })
			.element() as HTMLElement;
		add.focus();
		await userEvent.keyboard("{Enter}");
		const search = () =>
			document.querySelector<HTMLInputElement>(
				'[role="combobox"][aria-label="Search block types"]',
			);
		await until(() => document.activeElement === search());
		await settled();

		flushSync(() => {
			search()!.dispatchEvent(
				new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
			);
		});
		expect(search()).not.toBeNull();
		flushSync(() => {
			add.dispatchEvent(
				new PointerEvent("pointerdown", { pointerType: "touch", bubbles: true, isPrimary: true }),
			);
			add.click();
		});
		for (let count = 0; count < 4; count++) await frame();

		expect(search()?.tabIndex).toBe(-1);
		expect(document.activeElement).not.toBe(search());
	});
});
