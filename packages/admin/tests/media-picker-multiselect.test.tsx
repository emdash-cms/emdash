/**
 * Multi-select behavior of MediaPickerModal (`multiple` + `onSelectMany`),
 * used by the gallery block's "Add Images" flow. The existing
 * `tests/components/MediaPickerModal.test.tsx` suite covers single-select —
 * this file guards the multi-select accumulation/toggle/order semantics
 * added for galleries (#1436), plus a regression check that single-select
 * mode still works.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";

import { MediaPickerModal } from "../src/components/MediaPickerModal";
import { render } from "./utils/render.tsx";

vi.mock("../src/lib/api", async () => {
	const actual = await vi.importActual("../src/lib/api");
	return {
		...actual,
		fetchMediaList: vi.fn().mockResolvedValue({
			items: [
				{
					id: "m1",
					filename: "photo.jpg",
					mimeType: "image/jpeg",
					url: "/media/photo.jpg",
					size: 1024,
					width: 800,
					height: 600,
					createdAt: "2024-01-01",
				},
				{
					id: "m2",
					filename: "landscape.png",
					mimeType: "image/png",
					url: "/media/landscape.png",
					size: 2048,
					width: 1200,
					height: 800,
					createdAt: "2024-01-02",
				},
				{
					id: "m3",
					filename: "portrait.png",
					mimeType: "image/png",
					url: "/media/portrait.png",
					size: 3072,
					width: 600,
					height: 900,
					createdAt: "2024-01-03",
				},
			],
		}),
		fetchMediaProviders: vi.fn().mockResolvedValue([]),
		fetchProviderMedia: vi.fn().mockResolvedValue({ items: [] }),
		uploadMedia: vi.fn().mockResolvedValue({ id: "m4", filename: "new.jpg" }),
		uploadToProvider: vi.fn().mockResolvedValue({}),
		updateMedia: vi.fn().mockResolvedValue({}),
	};
});

function QueryWrapper({ children }: { children: React.ReactNode }) {
	const qc = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});
	return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

function renderModal(props: Partial<React.ComponentProps<typeof MediaPickerModal>> = {}) {
	const defaultProps: React.ComponentProps<typeof MediaPickerModal> = {
		open: true,
		onOpenChange: vi.fn(),
		onSelect: vi.fn(),
		...props,
	};
	return render(
		<QueryWrapper>
			<MediaPickerModal {...defaultProps} />
		</QueryWrapper>,
	);
}

function optionButton(screen: Awaited<ReturnType<typeof renderModal>>, name: string) {
	const option = screen.getByRole("option", { name });
	return option.element().querySelector("button")!;
}

function footerInsertButton(): HTMLButtonElement {
	const allInsertBtns = [...document.querySelectorAll("button")];
	const insertBtns = allInsertBtns.filter((b) => b.textContent?.trim() === "Insert");
	return insertBtns.at(-1) as HTMLButtonElement;
}

describe("MediaPickerModal — multi-select", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("accumulates clicked items in click order", async () => {
		const onSelectMany = vi.fn();
		const screen = await renderModal({ multiple: true, onSelectMany });

		await expect.element(screen.getByRole("option", { name: "photo.jpg" })).toBeInTheDocument();

		// Click landscape, then photo, then portrait — order should be preserved
		// as the gallery insertion order, not the grid's display order.
		optionButton(screen, "landscape.png").click();
		await expect
			.element(screen.getByRole("option", { name: "landscape.png" }))
			.toHaveAttribute("aria-selected", "true");

		optionButton(screen, "photo.jpg").click();
		await expect
			.element(screen.getByRole("option", { name: "photo.jpg" }))
			.toHaveAttribute("aria-selected", "true");

		optionButton(screen, "portrait.png").click();
		await expect
			.element(screen.getByRole("option", { name: "portrait.png" }))
			.toHaveAttribute("aria-selected", "true");

		await vi.waitFor(() => {
			expect(footerInsertButton().disabled).toBe(false);
		});
		footerInsertButton().click();

		expect(onSelectMany).toHaveBeenCalledTimes(1);
		const selected = onSelectMany.mock.calls[0]![0] as Array<{ filename: string }>;
		expect(selected.map((item) => item.filename)).toEqual([
			"landscape.png",
			"photo.jpg",
			"portrait.png",
		]);
	});

	it("clicking a selected item deselects it", async () => {
		const onSelectMany = vi.fn();
		const screen = await renderModal({ multiple: true, onSelectMany });

		await expect.element(screen.getByRole("option", { name: "photo.jpg" })).toBeInTheDocument();

		optionButton(screen, "photo.jpg").click();
		await expect
			.element(screen.getByRole("option", { name: "photo.jpg" }))
			.toHaveAttribute("aria-selected", "true");

		optionButton(screen, "landscape.png").click();
		await expect
			.element(screen.getByRole("option", { name: "landscape.png" }))
			.toHaveAttribute("aria-selected", "true");

		// Deselect the first click
		optionButton(screen, "photo.jpg").click();
		await expect
			.element(screen.getByRole("option", { name: "photo.jpg" }))
			.toHaveAttribute("aria-selected", "false");

		await vi.waitFor(() => {
			expect(footerInsertButton().disabled).toBe(false);
		});
		footerInsertButton().click();

		expect(onSelectMany).toHaveBeenCalledTimes(1);
		const selected = onSelectMany.mock.calls[0]![0] as Array<{ filename: string }>;
		expect(selected.map((item) => item.filename)).toEqual(["landscape.png"]);
	});

	it("Insert button is disabled at zero selections", async () => {
		await renderModal({ multiple: true });

		await vi.waitFor(() => {
			expect(footerInsertButton().disabled).toBe(true);
		});
	});

	it("Insert button becomes enabled after one selection and disabled again after deselecting it", async () => {
		const screen = await renderModal({ multiple: true });
		await expect.element(screen.getByRole("option", { name: "photo.jpg" })).toBeInTheDocument();

		optionButton(screen, "photo.jpg").click();
		await vi.waitFor(() => {
			expect(footerInsertButton().disabled).toBe(false);
		});

		optionButton(screen, "photo.jpg").click();
		await vi.waitFor(() => {
			expect(footerInsertButton().disabled).toBe(true);
		});
	});

	it("regression: single-select mode still calls onSelect with one item", async () => {
		const onSelect = vi.fn();
		const onSelectMany = vi.fn();
		const screen = await renderModal({ onSelect, onSelectMany });

		await expect.element(screen.getByRole("option", { name: "photo.jpg" })).toBeInTheDocument();

		optionButton(screen, "photo.jpg").click();
		await expect
			.element(screen.getByRole("option", { name: "photo.jpg" }))
			.toHaveAttribute("aria-selected", "true");

		await vi.waitFor(() => {
			expect(footerInsertButton().disabled).toBe(false);
		});
		footerInsertButton().click();

		expect(onSelect).toHaveBeenCalledTimes(1);
		expect(onSelect).toHaveBeenCalledWith(
			expect.objectContaining({ id: "m1", filename: "photo.jpg" }),
		);
		expect(onSelectMany).not.toHaveBeenCalled();
	});
});
