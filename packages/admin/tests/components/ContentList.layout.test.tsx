import { Sidebar } from "@cloudflare/kumo";
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";

import "../../dist/styles.css";
import { ContentList } from "../../src/components/ContentList.js";
import type { ContentItem } from "../../src/lib/api";
import { render } from "../utils/render.js";

vi.mock("@tanstack/react-router", async () => {
	const actual = await vi.importActual("@tanstack/react-router");
	return {
		...actual,
		Link: ({
			children,
			to,
			params: _params,
			search: _search,
			...props
		}: {
			children: React.ReactNode;
			to?: string;
			params?: Record<string, string>;
			search?: Record<string, unknown>;
			[key: string]: unknown;
		}) => (
			<a href={typeof to === "string" ? to : "#"} {...props}>
				{children}
			</a>
		),
	};
});

const posts: ContentItem[] = Array.from({ length: 50 }, (_, index) => ({
	id: `post-${index}`,
	type: "posts",
	slug: `post-${index}`,
	status: "draft",
	data: { title: `Post ${index}` },
	authorId: "user-1",
	createdAt: "2026-01-01T00:00:00Z",
	updatedAt: "2026-01-02T00:00:00Z",
	publishedAt: null,
	scheduledAt: null,
	liveRevisionId: null,
	draftRevisionId: null,
}));

function pagination(totalCount: number) {
	return {
		page: 1,
		perPage: 50,
		totalCount,
		isPending: false,
		onPageChange: vi.fn(),
		onPageSizeChange: vi.fn(),
	};
}

afterEach(async () => {
	await page.viewport(1280, 800);
});

describe("Content list pagination layout", () => {
	it("aligns a short list with the sidebar footer", async () => {
		const screen = await render(
			<div style={{ display: "flex", height: "100vh" }}>
				<aside style={{ display: "flex", flexDirection: "column", width: 260, flexShrink: 0 }}>
					<div style={{ flex: 1 }} />
					<Sidebar.Footer data-testid="sidebar-footer">My Blog</Sidebar.Footer>
				</aside>
				<main style={{ flex: 1, minWidth: 0, overflowY: "auto", padding: 24 }}>
					<ContentList
						collection="posts"
						collectionLabel="Posts"
						items={posts.slice(0, 3)}
						pagination={pagination(3)}
					/>
				</main>
			</div>,
		);
		const main = screen.getByRole("main").element();
		const footer = screen.getByRole("combobox", { name: "Page size" }).element().closest("footer")!;
		const sidebarFooter = screen.getByTestId("sidebar-footer").element().getBoundingClientRect();

		const bounds = footer.getBoundingClientRect();
		expect(main.scrollHeight).toBe(main.clientHeight);
		expect(bounds.bottom).toBeCloseTo(sidebarFooter.bottom, 0);
		expect(bounds.height).toBeCloseTo(sidebarFooter.height, 0);
	});

	it.each([
		{ width: 1280, direction: "ltr" },
		{ width: 320, direction: "rtl" },
	])(
		"keeps pagination visible while scrolling at $width px in $direction",
		async ({ width, direction }) => {
			await page.viewport(width, 800);
			const screen = await render(
				<main dir={direction} style={{ height: 600, overflowY: "auto", padding: 24 }}>
					<ContentList
						collection="posts"
						collectionLabel="Posts"
						items={posts}
						pagination={pagination(50)}
					/>
				</main>,
			);
			const main = screen.getByRole("main").element() as HTMLElement;
			const navigation = screen.getByRole("navigation", { name: "Posts pagination" }).element();
			const footer = navigation.closest("footer")!;
			const viewport = main.getBoundingClientRect();

			function expectPaginationInView() {
				expect(footer.getBoundingClientRect().bottom).toBeCloseTo(viewport.bottom, 0);
				const bounds = navigation.getBoundingClientRect();
				expect(bounds.top).toBeGreaterThanOrEqual(viewport.top);
				expect(bounds.bottom).toBeLessThanOrEqual(viewport.bottom);
				expect(bounds.left).toBeGreaterThanOrEqual(viewport.left);
				expect(bounds.right).toBeLessThanOrEqual(viewport.right);
			}

			expect(main.scrollHeight).toBeGreaterThan(main.clientHeight);
			expectPaginationInView();

			const link = screen
				.getByRole("link", { name: "Post 12", exact: true })
				.element() as HTMLElement;
			main.scrollTop +=
				link.getBoundingClientRect().bottom - footer.getBoundingClientRect().top - 10;
			link.focus();
			expect(link.getBoundingClientRect().bottom).toBeLessThanOrEqual(
				footer.getBoundingClientRect().top,
			);

			main.scrollTop = main.scrollHeight;
			expectPaginationInView();
			const lastTitle = screen.getByRole("link", { name: "Post 49", exact: true }).element();
			expect(lastTitle.getBoundingClientRect().bottom).toBeLessThan(
				footer.getBoundingClientRect().top,
			);
		},
	);
});
