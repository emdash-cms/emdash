import { Toasty } from "@cloudflare/kumo";
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";

import "../../dist/styles.css";
import { MediaLibrary } from "../../src/components/MediaLibrary.js";
import type { MediaItem } from "../../src/lib/api/media.js";
import { render } from "../utils/render.js";

vi.mock("../../src/lib/api", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../src/lib/api")>()),
	fetchMediaProviders: vi.fn().mockResolvedValue([]),
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

afterEach(async () => {
	await page.viewport(1280, 800);
});

describe("Media Library pagination layout", () => {
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
				if (view === "Grid view") {
					const card = screen
						.getByRole("button", { name: "document-12.txt" })
						.element() as HTMLElement;
					main.scrollTop +=
						card.getBoundingClientRect().bottom - footer.getBoundingClientRect().top - 10;
					card.focus();
					expect(card.getBoundingClientRect().bottom).toBeLessThanOrEqual(
						footer.getBoundingClientRect().top,
					);
				}
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
