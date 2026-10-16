import * as React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RenderResult } from "vitest-browser-react";
import { cdp, userEvent, type Locator } from "vitest/browser";

import "../../dist/styles.css";
import type { MediaPickerModalProps } from "../../src/components/MediaPickerModal.js";
import { SeoImageField } from "../../src/components/SeoImageField.js";
import type { ContentSeoInput } from "../../src/lib/api/index.js";
import { render } from "../utils/render.js";

const picker = vi.hoisted(() => ({ finishClosing: () => {} }));

// Stands in for the Base UI dialog: focus moves in when it opens, the popup
// stays mounted with data-closed until `picker.finishClosing()` ends its exit
// animation, and then focus returns to the opener if it is still there.
vi.mock("../../src/components/MediaPickerModal", async () => {
	const { useEffect, useLayoutEffect, useRef, useState } = await import("react");

	function Picker({ open, title, confirmLabel, onSelect, onOpenChange }: MediaPickerModalProps) {
		const dialogRef = useRef<HTMLDivElement>(null);
		useLayoutEffect(() => {
			const dialog = dialogRef.current!;
			const opener = document.activeElement;
			dialog.querySelector("button")!.focus();
			return () => {
				const active = document.activeElement;
				const focusInDialog = !active || active === document.body || dialog.contains(active);
				if (focusInDialog && opener instanceof HTMLElement && opener.isConnected) opener.focus();
			};
		}, []);
		return (
			<div ref={dialogRef} role="dialog" aria-label={title} data-closed={open ? undefined : ""}>
				<button
					type="button"
					onClick={() => {
						onSelect({
							id: "picked-image",
							filename: "picked.png",
							mimeType: "image/png",
							url: "/_emdash/api/media/file/picked.png",
							storageKey: "picked.png",
							size: 1024,
							createdAt: "2026-10-09T00:00:00Z",
						});
						onOpenChange(false);
					}}
				>
					{confirmLabel ?? "Select"}
				</button>
			</div>
		);
	}

	return {
		MediaPickerModal(props: MediaPickerModalProps) {
			const [mounted, setMounted] = useState(props.open);
			if (props.open && !mounted) setMounted(true);
			useEffect(() => {
				if (props.open || !mounted) return;
				picker.finishClosing = () => setMounted(false);
				return () => {
					picker.finishClosing = () => {};
				};
			}, [props.open, mounted]);
			return mounted ? <Picker {...props} /> : null;
		},
	};
});

const FIELD_WIDTH = 320;
const PICKED_URL = "/_emdash/api/media/file/picked.png";
const REPLACE = "Replace OG Image";
const REMOVE = "Remove OG Image";
const DROP_TARGET = "Drop an image here or browse for OG Image";

let pendingSave: (() => void) | undefined;

function completeSave() {
	const save = pendingSave;
	pendingSave = undefined;
	save?.();
}

function Field({
	image = null,
	dir,
	deferSave = false,
	inputInDialog = false,
	onChange,
}: {
	image?: string | null;
	dir?: "ltr" | "rtl";
	/** Hold each change until `completeSave()`, like the editor's save round trip. */
	deferSave?: boolean;
	inputInDialog?: boolean;
	onChange?: (seo: ContentSeoInput) => void;
}) {
	const [savedImage, setSavedImage] = React.useState(image);
	const input = <input aria-label="SEO Title" />;
	return (
		<div dir={dir} style={{ width: FIELD_WIDTH }}>
			<SeoImageField
				seo={{ title: null, description: null, image: savedImage, canonical: null, noIndex: false }}
				onChange={(next) => {
					onChange?.(next);
					const save = () => setSavedImage(next.image ?? null);
					if (deferSave) pendingSave = save;
					else save();
				}}
			/>
			{inputInDialog ? (
				<div role="dialog" aria-label="Another dialog">
					{input}
				</div>
			) : (
				input
			)}
		</div>
	);
}

function solidImage(width: number, height: number) {
	const canvas = document.createElement("canvas");
	canvas.width = width;
	canvas.height = height;
	const context = canvas.getContext("2d")!;
	context.fillStyle = "#4f46e5";
	context.fillRect(0, 0, width, height);
	return canvas.toDataURL("image/png");
}

const WIDE_IMAGE = solidImage(1600, 840);

function button(screen: RenderResult, name: string) {
	return screen.getByRole("button", { name, exact: true });
}

async function loadedPreview(screen: RenderResult) {
	const img = await vi.waitFor(() => {
		const element = screen.container.querySelector("img");
		if (!element) throw new Error("The preview image has not rendered");
		return element;
	});
	await img.decode();
	return img;
}

/** "shown" when both an action can be seen and the pointer hits it, "hidden" when neither. */
function actionStates(screen: RenderResult) {
	return [REPLACE, REMOVE].map((name) => {
		const element = button(screen, name).element();
		let opacity = 1;
		for (let node: Element | null = element; node; node = node.parentElement) {
			opacity *= Number(getComputedStyle(node).opacity);
		}
		const { x, y, width, height } = element.getBoundingClientRect();
		const hit = element.contains(document.elementFromPoint(x + width / 2, y + height / 2));
		if (opacity === 1 && hit) return "shown";
		if (opacity === 0 && !hit) return "hidden";
		return `opacity ${opacity}, ${hit ? "hit" : "missed"} by the pointer`;
	});
}

function movePointerOffPreview(screen: RenderResult) {
	return userEvent.hover(screen.getByText("OG Image", { exact: true }));
}

async function removeImage(screen: RenderResult) {
	button(screen, REMOVE).element().focus();
	await userEvent.keyboard("{Enter}");
}

/** Picks an image from the drop target's picker, which is left closing. */
async function chooseImage(screen: RenderResult) {
	button(screen, DROP_TARGET).element().focus();
	await userEvent.keyboard("{Enter}");
	const dialog = screen.getByRole("dialog", { name: "Select OG Image", exact: true });
	await userEvent.click(dialog.getByRole("button"));
}

async function closePicker(screen: RenderResult) {
	picker.finishClosing();
	await expect
		.element(screen.getByRole("dialog", { name: "Select OG Image", exact: true }))
		.not.toBeInTheDocument();
}

function nextFrame() {
	return new Promise((resolve) => requestAnimationFrame(resolve));
}

async function expectFocusToStayOn(locator: Locator) {
	await expect.element(locator).toHaveFocus();
	await nextFrame();
	await nextFrame();
	expect(document.activeElement).toBe(locator.element());
}

beforeEach(() => {
	pendingSave = undefined;
});

describe("SeoImageField", () => {
	it.each([
		["wide", 1600, 840],
		["tall", 400, 1200],
		["tiny", 40, 40],
	])("crops a %s image to a full-width 1200:630 preview", async (_, width, height) => {
		const screen = await render(<Field image={solidImage(width, height)} />);
		const img = await loadedPreview(screen);

		const frame = img.getBoundingClientRect();
		expect(frame.width).toBeCloseTo(FIELD_WIDTH, 0);
		expect(frame.height).toBeCloseTo((FIELD_WIDTH * 630) / 1200, 0);
		expect(getComputedStyle(img).objectFit).toBe("cover");
	});

	it.each(["ltr", "rtl"] as const)(
		"pins the image actions inside the preview's top-end corner (%s)",
		async (dir) => {
			const screen = await render(<Field image={solidImage(40, 40)} dir={dir} />);
			const preview = (await loadedPreview(screen)).getBoundingClientRect();
			const group = screen.getByRole("group", { name: "Image actions", exact: true });
			await expect
				.element(group.getByRole("button", { name: REPLACE, exact: true }))
				.toHaveTextContent(/^Replace$/);
			await expect
				.element(group.getByRole("button", { name: REMOVE, exact: true }))
				.toBeInTheDocument();

			const actions = group.element().getBoundingClientRect();
			const fromStart = dir === "rtl" ? preview.right - actions.right : actions.left - preview.left;
			const fromEnd = dir === "rtl" ? actions.left - preview.left : preview.right - actions.right;
			const fromTop = actions.top - preview.top;
			expect(fromTop).toBeGreaterThanOrEqual(0);
			expect(fromTop).toBeLessThan(16);
			expect(fromEnd).toBeGreaterThanOrEqual(0);
			expect(fromEnd).toBeLessThan(16);
			expect(fromStart).toBeGreaterThan(fromEnd);
			expect(actions.bottom).toBeLessThanOrEqual(preview.bottom);
		},
	);

	it("shows the image actions only while the pointer is over the image", async () => {
		const screen = await render(<Field image={WIDE_IMAGE} />);
		const img = await loadedPreview(screen);

		await movePointerOffPreview(screen);
		await expect.poll(() => actionStates(screen)).toEqual(["hidden", "hidden"]);
		await userEvent.hover(img);
		await expect.poll(() => actionStates(screen)).toEqual(["shown", "shown"]);
		await movePointerOffPreview(screen);
		await expect.poll(() => actionStates(screen)).toEqual(["hidden", "hidden"]);
	});

	it("keeps the hidden image actions in the tab order and shows them on keyboard focus", async () => {
		const screen = await render(<Field image={WIDE_IMAGE} />);
		await loadedPreview(screen);
		await movePointerOffPreview(screen);
		await expect.poll(() => actionStates(screen)).toEqual(["hidden", "hidden"]);

		button(screen, "Why is this important for social sharing?").element().focus();
		await userEvent.tab();
		await expect.element(button(screen, REPLACE)).toHaveFocus();
		await expect.poll(() => actionStates(screen)).toEqual(["shown", "shown"]);
		await userEvent.tab();
		await expect.element(button(screen, REMOVE)).toHaveFocus();
		expect(actionStates(screen)).toEqual(["shown", "shown"]);
	});

	it("always shows the image actions on touch screens", async () => {
		await cdp().send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
		try {
			expect(matchMedia("(pointer: coarse)").matches).toBe(true);
			const screen = await render(<Field image={WIDE_IMAGE} />);
			await loadedPreview(screen);

			await expect.poll(() => actionStates(screen)).toEqual(["shown", "shown"]);
		} finally {
			await cdp().send("Emulation.setTouchEmulationEnabled", { enabled: false });
		}
	});

	it("says when the image can't be loaded and shows its actions", async () => {
		const screen = await render(<Field image="/_emdash/api/media/file/deleted.png" />);

		await expect.element(screen.getByText("Image not found", { exact: true })).toBeVisible();
		await movePointerOffPreview(screen);
		await expect.poll(() => actionStates(screen)).toEqual(["shown", "shown"]);
	});

	it("titles the media picker for choosing an image, then for replacing it", async () => {
		const onChange = vi.fn();
		const screen = await render(<Field onChange={onChange} />);

		await chooseImage(screen);
		// The image is already stored, but the closing picker keeps its title.
		await expect
			.element(screen.getByRole("dialog", { name: "Select OG Image", exact: true }))
			.toBeInTheDocument();
		await closePicker(screen);

		await userEvent.click(button(screen, REPLACE));
		const dialog = screen.getByRole("dialog", { name: "Replace OG Image", exact: true });
		await userEvent.click(dialog.getByRole("button", { name: "Replace", exact: true }));
		expect(onChange.mock.calls).toEqual([[{ image: PICKED_URL }], [{ image: PICKED_URL }]]);
	});

	it.each([
		["at once", false],
		["after saving", true],
	])(
		"moves focus to the drop target when the parent removes the image %s",
		async (_, deferSave) => {
			const onChange = vi.fn();
			const screen = await render(
				<Field image={WIDE_IMAGE} deferSave={deferSave} onChange={onChange} />,
			);

			await removeImage(screen);
			expect(onChange).toHaveBeenCalledWith({ image: null });
			completeSave();
			await expectFocusToStayOn(button(screen, DROP_TARGET));
		},
	);

	it.each([
		["at once", false],
		["after saving", true],
	])(
		"moves focus to Replace when the parent stores the image chosen from the drop target %s",
		async (_, deferSave) => {
			const onChange = vi.fn();
			const screen = await render(<Field deferSave={deferSave} onChange={onChange} />);

			await chooseImage(screen);
			expect(onChange).toHaveBeenCalledWith({ image: PICKED_URL });
			await closePicker(screen);
			completeSave();
			await expectFocusToStayOn(button(screen, REPLACE));
		},
	);

	it("leaves focus in an input the user moved to while the removal was saving", async () => {
		const screen = await render(<Field image={WIDE_IMAGE} deferSave />);

		await removeImage(screen);
		const input = screen.getByRole("textbox", { name: "SEO Title", exact: true });
		input.element().focus();
		completeSave();
		await expect.element(button(screen, DROP_TARGET)).toBeInTheDocument();
		await expectFocusToStayOn(input);
	});

	// Safari and Firefox on macOS don't focus a clicked button, so focus stays on the page.
	it.each([
		[
			"removing",
			WIDE_IMAGE,
			async (screen: RenderResult) => {
				button(screen, REMOVE).element().click();
				await expect.element(button(screen, DROP_TARGET)).toBeInTheDocument();
			},
		],
		[
			"choosing",
			null,
			async (screen: RenderResult) => {
				button(screen, DROP_TARGET).element().click();
				const dialog = screen.getByRole("dialog", { name: "Select OG Image", exact: true });
				await userEvent.click(dialog.getByRole("button"));
				await closePicker(screen);
				await expect.element(button(screen, REPLACE)).toBeInTheDocument();
			},
		],
	] as const)(
		"leaves focus on the page after %s an image with a click that didn't focus the button",
		async (_, image, act) => {
			const screen = await render(<Field image={image} />);
			expect(document.activeElement).toBe(document.body);

			await act(screen);
			await nextFrame();
			await nextFrame();
			expect(document.activeElement).toBe(document.body);
		},
	);

	it.each([
		["on the page", false],
		["in another open dialog", true],
	])(
		"leaves focus in an input %s the user moved to while the chosen image was saving",
		async (_, inputInDialog) => {
			const screen = await render(<Field deferSave inputInDialog={inputInDialog} />);

			await chooseImage(screen);
			await closePicker(screen);
			const input = screen.getByRole("textbox", { name: "SEO Title", exact: true });
			input.element().focus();
			completeSave();
			await expect.element(button(screen, REPLACE)).toBeInTheDocument();
			await expectFocusToStayOn(input);
		},
	);
});
