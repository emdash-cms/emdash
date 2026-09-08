import * as React from "react";
import { describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";

import {
	MediaImageCropper,
	type MediaCropSelection,
} from "../../src/components/MediaImageCropper.js";

import "../../src/media-image-cropper.css";
import { render } from "../utils/render.tsx";

function sourceUrl(width = 400, height = 200): string {
	const canvas = document.createElement("canvas");
	canvas.width = width;
	canvas.height = height;
	const context = canvas.getContext("2d")!;
	context.fillStyle = "blue";
	context.fillRect(0, 0, width, height);
	return canvas.toDataURL("image/png");
}

function Harness(props: {
	aspect?: number;
	disabled?: boolean;
	sourceWidth?: number;
	sourceHeight?: number;
	onSourceReady?: (size: { width: number; height: number }) => void;
	onCropComplete?: (crop: { x: number; y: number; width: number; height: number }) => void;
}) {
	const [crop, setCrop] = React.useState<MediaCropSelection>();
	const [completed, setCompleted] = React.useState({ x: 0, y: 0, width: 0, height: 0 });
	const handleCropComplete = React.useCallback(
		(next: { x: number; y: number; width: number; height: number }) => {
			setCompleted(next);
			props.onCropComplete?.(next);
		},
		[props.onCropComplete],
	);
	return (
		<>
			<MediaImageCropper
				src={sourceUrl(props.sourceWidth, props.sourceHeight)}
				crop={crop}
				aspect={props.aspect}
				disabled={props.disabled}
				onCropChange={setCrop}
				onCropComplete={handleCropComplete}
				onSourceReady={props.onSourceReady ?? vi.fn()}
				onSourceError={vi.fn()}
			/>
			<output aria-label="Crop selection">
				{crop ? `${crop.x},${crop.y},${crop.width},${crop.height}` : "pending"}
			</output>
			<output aria-label="Crop pixels">
				{`${completed.x},${completed.y},${completed.width},${completed.height}`}
			</output>
		</>
	);
}

function readCropPixels(element: HTMLElement): {
	x: number;
	y: number;
	width: number;
	height: number;
} {
	const [x, y, width, height] = element.textContent!.split(",").map(Number);
	return { x: x!, y: y!, width: width!, height: height! };
}

describe("MediaImageCropper", () => {
	it("does not emit crop pixels before the image loads", async () => {
		const onCropComplete = vi.fn();
		await render(
			<MediaImageCropper
				src=""
				sourceSize={{ width: 400, height: 200 }}
				onCropChange={vi.fn()}
				onCropComplete={onCropComplete}
				onSourceReady={vi.fn()}
				onSourceError={vi.fn()}
			/>,
		);
		await new Promise((resolve) => window.setTimeout(resolve, 0));
		expect(onCropComplete).not.toHaveBeenCalled();
	});

	it("loads the source without injecting runtime styles", async () => {
		const onSourceReady = vi.fn();
		const styleCount = document.head.querySelectorAll("style").length;
		const screen = await render(<Harness onSourceReady={onSourceReady} />);

		await vi.waitFor(() => expect(onSourceReady).toHaveBeenCalledWith({ width: 400, height: 200 }));
		expect(document.head.querySelectorAll("style")).toHaveLength(styleCount);
		await expect
			.element(
				screen.getByRole("group", { name: "Crop selection. Use the Arrow keys to move it." }),
			)
			.toBeVisible();
	});

	it("shows eight resize handles and a persistent rule-of-thirds grid", async () => {
		const screen = await render(<Harness />);
		const handleNames = [
			"top-left corner",
			"top edge",
			"top-right corner",
			"right edge",
			"bottom-right corner",
			"bottom edge",
			"bottom-left corner",
			"left edge",
		];
		for (const handle of handleNames) {
			await expect
				.element(screen.getByRole("button", { name: `Resize crop from ${handle}` }))
				.toBeVisible();
		}
		const cropBounds = screen
			.getByRole("group", { name: "Crop selection. Use the Arrow keys to move it." })
			.element()
			.getBoundingClientRect();
		for (const handle of handleNames) {
			const bounds = screen
				.getByRole("button", { name: `Resize crop from ${handle}` })
				.element()
				.getBoundingClientRect();
			expect(bounds.left).toBeGreaterThanOrEqual(cropBounds.left);
			expect(bounds.top).toBeGreaterThanOrEqual(cropBounds.top);
			expect(bounds.right).toBeLessThanOrEqual(cropBounds.right);
			expect(bounds.bottom).toBeLessThanOrEqual(cropBounds.bottom);
		}
		expect(
			getComputedStyle(
				screen
					.getByRole("group", { name: "Crop selection. Use the Arrow keys to move it." })
					.element(),
			).animationName,
		).toBe("none");
		const verticalGrid = document.querySelector<HTMLElement>(".ReactCrop__rule-of-thirds-vt")!;
		expect(getComputedStyle(verticalGrid, "::before").borderLeftStyle).toBe("dashed");
	});

	it("uses only corner resize handles for a fixed aspect ratio", async () => {
		const screen = await render(<Harness aspect={2} />);
		for (const corner of [
			"top-left corner",
			"top-right corner",
			"bottom-right corner",
			"bottom-left corner",
		]) {
			await expect
				.element(screen.getByRole("button", { name: `Resize crop from ${corner}` }))
				.toBeVisible();
		}
		for (const edge of ["top edge", "right edge", "bottom edge", "left edge"]) {
			expect(screen.getByRole("button", { name: `Resize crop from ${edge}` }).query()).toBeNull();
		}
	});

	it("keeps a small fixed-ratio corner drag proportional", async () => {
		const screen = await render(<Harness aspect={2} />);
		const cropPixels = screen.getByLabelText("Crop pixels");
		await vi.waitFor(() => expect(readCropPixels(cropPixels.element()).width).toBe(400));
		const corner = screen.getByRole("button", { name: "Resize crop from bottom-right corner" });
		const handle = corner.element();
		const bounds = handle.getBoundingClientRect();
		const start = { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 };
		handle.dispatchEvent(
			new PointerEvent("pointerdown", {
				bubbles: true,
				cancelable: true,
				button: 0,
				isPrimary: true,
				pointerId: 12,
				clientX: start.x,
				clientY: start.y,
			}),
		);
		document.dispatchEvent(
			new PointerEvent("pointermove", {
				bubbles: true,
				cancelable: true,
				isPrimary: true,
				pointerId: 12,
				clientX: start.x - 6,
				clientY: start.y - 3,
			}),
		);
		await new Promise((resolve) => window.setTimeout(resolve, 0));
		document.dispatchEvent(
			new PointerEvent("pointerup", {
				bubbles: true,
				pointerId: 12,
				clientX: start.x - 6,
				clientY: start.y - 3,
			}),
		);

		await vi.waitFor(() => {
			const resized = readCropPixels(cropPixels.element());
			expect(resized.width).toBeGreaterThan(380);
			expect(resized.width).toBeLessThan(400);
			expect(Math.abs(resized.width - resized.height * 2)).toBeLessThanOrEqual(1);
		});
	});

	it("updates crop pixels while a handle is moving", async () => {
		const screen = await render(<Harness />);
		const cropPixels = screen.getByLabelText("Crop pixels");
		await vi.waitFor(() => expect(readCropPixels(cropPixels.element()).width).toBe(400));
		const handle = screen.getByRole("button", { name: "Resize crop from right edge" }).element();
		const bounds = handle.getBoundingClientRect();
		const start = { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 };

		handle.dispatchEvent(
			new PointerEvent("pointerdown", {
				bubbles: true,
				cancelable: true,
				button: 0,
				isPrimary: true,
				pointerId: 18,
				clientX: start.x,
				clientY: start.y,
			}),
		);
		document.dispatchEvent(
			new PointerEvent("pointermove", {
				bubbles: true,
				cancelable: true,
				isPrimary: true,
				pointerId: 18,
				clientX: start.x - 20,
				clientY: start.y,
			}),
		);

		await vi.waitFor(() => expect(readCropPixels(cropPixels.element()).width).toBeLessThan(400));
		document.dispatchEvent(
			new PointerEvent("pointerup", {
				bubbles: true,
				pointerId: 18,
				clientX: start.x - 20,
				clientY: start.y,
			}),
		);
	});

	it("upscales a tiny source so all eight handles remain distinct", async () => {
		const screen = await render(<Harness sourceWidth={40} sourceHeight={20} />);
		const frame = screen.getByTestId("media-image-cropper-frame").element();
		frame.style.width = "400px";
		frame.style.height = "200px";
		const image = document.querySelector<HTMLImageElement>(".emdash-react-image-crop img")!;
		await vi.waitFor(() => expect(image.getBoundingClientRect().width).toBe(400));
		const resizeHandle = screen.getByRole("button", {
			name: "Resize crop from bottom-right corner",
		});
		resizeHandle.element().focus();
		for (let index = 0; index < 4; index += 1) {
			await userEvent.keyboard("{Control>}{ArrowLeft}{/Control}");
		}

		const handles = [
			"top-left corner",
			"top edge",
			"top-right corner",
			"right edge",
			"bottom-right corner",
			"bottom edge",
			"bottom-left corner",
			"left edge",
		].map((name) =>
			screen
				.getByRole("button", { name: `Resize crop from ${name}` })
				.element()
				.getBoundingClientRect(),
		);
		for (let index = 0; index < handles.length; index += 1) {
			for (let other = index + 1; other < handles.length; other += 1) {
				const first = handles[index]!;
				const second = handles[other]!;
				const overlaps =
					first.left < second.right &&
					first.right > second.left &&
					first.top < second.bottom &&
					first.bottom > second.top;
				expect(overlaps).toBe(false);
			}
		}
	});

	it("moves the crop frame with the keyboard", async () => {
		const screen = await render(<Harness aspect={1} />);
		const image = document.querySelector<HTMLImageElement>(".emdash-react-image-crop img")!;
		expect(image.draggable).toBe(false);
		const imageBoundsBefore = image.getBoundingClientRect();
		const selection = screen.getByLabelText("Crop selection", { exact: true });
		await expect.element(selection).not.toHaveTextContent("pending");
		const beforeX = Number(selection.element().textContent!.split(",")[0]);
		const cropArea = screen.getByRole("group", {
			name: "Crop selection. Use the Arrow keys to move it.",
		});
		cropArea.element().focus();
		await userEvent.keyboard("{ArrowRight}");
		await vi.waitFor(() => {
			expect(Number(selection.element().textContent!.split(",")[0])).toBeGreaterThan(beforeX);
		});
		const imageBoundsAfter = image.getBoundingClientRect();
		expect(imageBoundsAfter.x).toBe(imageBoundsBefore.x);
		expect(imageBoundsAfter.y).toBe(imageBoundsBefore.y);
		expect(getComputedStyle(image).transform).toBe("none");
	});

	it("preserves a fixed aspect ratio while resizing a small source", async () => {
		const screen = await render(<Harness aspect={2} sourceWidth={40} sourceHeight={20} />);
		const frame = screen.getByTestId("media-image-cropper-frame").element();
		frame.style.width = "400px";
		frame.style.height = "200px";
		const image = document.querySelector<HTMLImageElement>(".emdash-react-image-crop img")!;
		await vi.waitFor(() => expect(image.getBoundingClientRect().width).toBe(400));
		const cropPixels = screen.getByLabelText("Crop pixels");
		await vi.waitFor(() => expect(readCropPixels(cropPixels.element()).width).toBe(40));
		const corner = screen.getByRole("button", { name: "Resize crop from bottom-right corner" });
		corner.element().focus();
		await userEvent.keyboard("{Shift>}{ArrowLeft}{/Shift}");

		await vi.waitFor(() => {
			const resized = readCropPixels(cropPixels.element());
			expect(resized.width).toBeLessThan(40);
			expect(Math.abs(resized.width - resized.height * 2)).toBeLessThanOrEqual(1);
		});
	});

	it("resizes both dimensions from a freeform corner", async () => {
		const screen = await render(<Harness />);
		const cropPixels = screen.getByLabelText("Crop pixels");
		await vi.waitFor(() => expect(readCropPixels(cropPixels.element()).width).toBe(400));
		const corner = screen.getByRole("button", { name: "Resize crop from bottom-right corner" });
		corner.element().focus();
		await userEvent.keyboard("{Shift>}{ArrowLeft}{/Shift}");

		await vi.waitFor(() => {
			const resized = readCropPixels(cropPixels.element());
			expect(resized.width).toBeLessThan(400);
			expect(resized.height).toBeLessThan(200);
		});
	});

	it("resizes one dimension from a freeform edge", async () => {
		const screen = await render(<Harness />);
		const cropPixels = screen.getByLabelText("Crop pixels");
		await vi.waitFor(() => expect(readCropPixels(cropPixels.element()).width).toBe(400));
		const rightEdge = screen.getByRole("button", { name: "Resize crop from right edge" });
		rightEdge.element().focus();
		await userEvent.keyboard("{Shift>}{ArrowLeft}{/Shift}");

		await vi.waitFor(() => {
			const resized = readCropPixels(cropPixels.element());
			expect(resized.width).toBeLessThan(400);
			expect(resized.height).toBe(200);
		});
	});

	it("removes disabled crop handles from keyboard interaction", async () => {
		const screen = await render(<Harness disabled />);
		await expect
			.element(screen.getByLabelText("Crop selection", { exact: true }))
			.not.toHaveTextContent("pending");
		expect(screen.getByRole("button", { name: "Resize crop from top edge" }).query()).toBeNull();
		await expect.element(screen.getByTestId("media-image-cropper-frame")).toHaveAttribute("inert");
	});
});
