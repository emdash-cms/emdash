import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
const SAVE_IMAGE_URL = "Save image URL";
const SHARING_URL_TITLE = "Sharing image needs a URL";
const SHARING_URL_DESCRIPTION =
	"The saved media ID may not work in shared links. Save the image URL to use this file for sharing.";

let pendingSave: (() => void) | undefined;
let mediaInterception: {
	session: ReturnType<typeof cdp>;
	handler: (event: { requestId: string }) => Promise<void>;
} | null = null;

async function serveMediaFiles() {
	const session = cdp();
	const body = WIDE_IMAGE.slice(WIDE_IMAGE.indexOf(",") + 1);
	const handler = async ({ requestId }: { requestId: string }) => {
		await session.send("Fetch.fulfillRequest", {
			requestId,
			responseCode: 200,
			responseHeaders: [{ name: "Content-Type", value: "image/png" }],
			body,
		});
	};
	await session.send("Fetch.enable", {
		patterns: [{ urlPattern: "*/_emdash/api/media/file/*", requestStage: "Request" }],
	});
	session.on("Fetch.requestPaused", handler);
	mediaInterception = { session, handler };
}

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

afterEach(async () => {
	if (mediaInterception) {
		const { session, handler } = mediaInterception;
		session.off("Fetch.requestPaused", handler);
		await session.send("Fetch.disable");
		mediaInterception = null;
	}
	vi.restoreAllMocks();
});

describe("SeoImageField", () => {
	it("resolves a bare media ID before requesting its storage key", async () => {
		const id = "01J00000000000000000000000";
		const filename = "photo [summer] #?.jpg";
		const storageKey = "objects/seo-image-2026-10-09.webp";
		const publicFileUrl = `/_emdash/api/media/file/${storageKey}`;
		const metadata = {
			id,
			filename,
			mimeType: "image/jpeg",
			url: `/_emdash/api/media/asset/${encodeURIComponent(id)}/${encodeURIComponent(filename)}`,
			storageKey,
			size: 1024,
			createdAt: "2026-10-09T00:00:00Z",
			status: "ready",
		};
		let resolveMetadata!: (response: Response) => void;
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockImplementation(() => new Promise((resolve) => (resolveMetadata = resolve)));
		performance.clearResourceTimings();
		const onChange = vi.fn();
		await serveMediaFiles();
		const screen = await render(<Field image={id} onChange={onChange} />);
		const idFileUrl = `/_emdash/api/media/file/${id}`;

		await vi.waitFor(() =>
			expect(fetchSpy).toHaveBeenCalledWith(
				`/_emdash/api/media/${encodeURIComponent(id)}`,
				expect.objectContaining({ signal: expect.any(AbortSignal) }),
			),
		);
		expect(screen.container.querySelector("img")).toBeNull();
		expect(onChange).not.toHaveBeenCalled();
		expect(
			performance.getEntriesByName(new URL(idFileUrl, window.location.origin).href),
		).toHaveLength(0);

		resolveMetadata(Response.json({ success: true, data: { item: metadata } }));
		await loadedPreview(screen);
		await vi.waitFor(() => {
			expect(
				performance.getEntriesByName(new URL(publicFileUrl, window.location.origin).href).length,
			).toBeGreaterThan(0);
		});
		expect(screen.getByRole("note")).toHaveTextContent(SHARING_URL_TITLE);
		expect(screen.getByRole("note")).toHaveTextContent(SHARING_URL_DESCRIPTION);
		await expect.element(button(screen, SAVE_IMAGE_URL)).toBeVisible();
		expect(onChange).not.toHaveBeenCalled();
	});

	it.each([false, true])(
		"saves the resolved storage URL explicitly and removes the warning (%s deferred)",
		async (deferSave) => {
			const id = "01J00000000000000000000003";
			const storageKey = "objects/seo-image-ready.jpg";
			const onChange = vi.fn();
			vi.spyOn(globalThis, "fetch").mockResolvedValue(
				Response.json({
					success: true,
					data: {
						item: {
							id,
							filename: "ready.jpg",
							mimeType: "image/jpeg",
							url: "/_emdash/api/media/asset/ready.jpg",
							storageKey,
							size: 1024,
							createdAt: "2026-10-09T00:00:00Z",
							status: "ready",
						},
					},
				}),
			);
			await serveMediaFiles();
			const screen = await render(<Field image={id} deferSave={deferSave} onChange={onChange} />);
			await loadedPreview(screen);
			const savedUrl = `/_emdash/api/media/file/${storageKey}`;

			await expect.element(button(screen, SAVE_IMAGE_URL)).toBeVisible();
			await userEvent.click(button(screen, SAVE_IMAGE_URL));
			expect(onChange).toHaveBeenCalledTimes(1);
			expect(onChange).toHaveBeenCalledWith({ image: savedUrl });
			if (deferSave) {
				await expect.element(button(screen, SAVE_IMAGE_URL)).toBeVisible();
				completeSave();
			}
			await expect.element(screen.getByRole("note")).not.toBeInTheDocument();
			expect(onChange).toHaveBeenCalledTimes(1);
			await expectFocusToStayOn(button(screen, REPLACE));
		},
	);

	it("does not steal focus when the user moves to an input before saving the URL", async () => {
		const id = "01J00000000000000000000004";
		const storageKey = "objects/seo-image-ready-input.jpg";
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			Response.json({
				success: true,
				data: { item: { id, storageKey, status: "ready" } },
			}),
		);
		await serveMediaFiles();
		const screen = await render(<Field image={id} deferSave />);
		await loadedPreview(screen);
		await expect.element(button(screen, SAVE_IMAGE_URL)).toBeVisible();
		await userEvent.click(button(screen, SAVE_IMAGE_URL));
		const input = screen.getByRole("textbox", { name: "SEO Title", exact: true });
		input.element().focus();
		completeSave();
		await expect.element(screen.getByRole("note")).not.toBeInTheDocument();
		await expectFocusToStayOn(input);
	});

	it("shows the existing error state when bare media metadata fails", async () => {
		const id = "01J00000000000000000000001";
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			Response.json({ success: false }, { status: 500 }),
		);
		const onChange = vi.fn();
		const screen = await render(<Field image={id} onChange={onChange} />);

		await expect.element(screen.getByText("Image not found", { exact: true })).toBeVisible();
		await expect.element(button(screen, SAVE_IMAGE_URL)).not.toBeInTheDocument();
		await removeImage(screen);
		expect(onChange).toHaveBeenCalledWith({ image: null });
	});

	it("falls back to the bare ID as an extensionless storage key after a 404", async () => {
		const id = "01j00000000000000000000002";
		const fileUrl = `/_emdash/api/media/file/${id}`;
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(Response.json({ success: false }, { status: 404 }));
		performance.clearResourceTimings();
		const onChange = vi.fn();
		const screen = await render(<Field image={id} onChange={onChange} />);

		await vi.waitFor(() =>
			expect(fetchSpy).toHaveBeenCalledWith(
				`/_emdash/api/media/${id}`,
				expect.objectContaining({ signal: expect.any(AbortSignal) }),
			),
		);
		await vi.waitFor(() => {
			expect(
				performance.getEntriesByName(new URL(fileUrl, window.location.origin).href).length,
			).toBeGreaterThan(0);
		});
		await expect.element(screen.getByText("Image not found", { exact: true })).toBeVisible();
		await expect.element(button(screen, SAVE_IMAGE_URL)).not.toBeInTheDocument();
		expect(onChange).not.toHaveBeenCalled();
	});

	it("shows an error for ready metadata when its storage object is unavailable", async () => {
		const id = "01J00000000000000000000006";
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			Response.json({
				success: true,
				data: { item: { id, storageKey: "objects/unserved.jpg", status: "ready" } },
			}),
		);
		const onChange = vi.fn();
		const screen = await render(<Field image={id} onChange={onChange} />);

		await expect.element(screen.getByText("Image not found", { exact: true })).toBeVisible();
		await expect.element(button(screen, SAVE_IMAGE_URL)).not.toBeInTheDocument();
		expect(onChange).not.toHaveBeenCalled();
	});

	it("does not offer to save a media URL while media is not ready", async () => {
		const id = "01J00000000000000000000005";
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			Response.json({
				success: true,
				data: { item: { id, storageKey: "objects/pending.jpg", status: "pending" } },
			}),
		);
		const screen = await render(<Field image={id} />);
		await expect.element(screen.getByText("Image not found", { exact: true })).toBeVisible();
		await expect.element(button(screen, SAVE_IMAGE_URL)).not.toBeInTheDocument();
	});

	it.each([
		["uploads/og.png", "/_emdash/api/media/file/uploads/og.png"],
		["/images/og.png", "/images/og.png"],
		["https://cdn.example.com/og.png", "https://cdn.example.com/og.png"],
		["data:image/png;base64,AAAA", "data:image/png;base64,AAAA"],
	])("preserves or normalizes a non-ID image reference (%s)", async (image, expected) => {
		const screen = await render(<Field image={image} />);
		expect(screen.container.querySelector("img")?.getAttribute("src")).toBe(expected);
		await expect.element(button(screen, SAVE_IMAGE_URL)).not.toBeInTheDocument();
	});

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
