import * as React from "react";
import { describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";

import "../../dist/styles.css";
import { CommentInbox } from "../../src/components/comments/CommentInbox.js";
import type { AdminComment } from "../../src/lib/api/comments.js";
import { render } from "../utils/render.js";

const createdAt = "2026-01-02T00:00:00Z";
const commentDate = new Intl.DateTimeFormat("en").format(new Date(createdAt));

function makeComment(overrides: Partial<AdminComment>): AdminComment {
	return {
		id: "comment-1",
		collection: "posts",
		contentId: "post-1",
		parentId: null,
		authorName: "Maya Chen",
		authorEmail: "maya@example.com",
		authorUserId: null,
		body: "Great write-up.",
		status: "pending",
		ipHash: null,
		userAgent: null,
		moderationMetadata: null,
		createdAt,
		updatedAt: createdAt,
		...overrides,
	};
}

const comments = [
	makeComment({
		id: "comment-1",
		authorName: "Bartholomew Featherstonehaugh-Whittington",
		authorEmail: "bartholomew.featherstonehaugh@averyveryverylongdomainname.example.com",
		body: "I have been reading this blog for years and this is the first time I felt I had to write in. The part about deploying to the edge was especially useful.",
	}),
	makeComment({
		id: "comment-2",
		authorName: "Sam",
		authorEmail: "sam@example.io",
		body: "Cheap watches here https://example.com/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
	}),
	makeComment({ id: "comment-3", authorName: "Maya Chen", status: "approved" }),
	makeComment({
		id: "comment-4",
		collection: "knowledge_base_articles_and_guides_for_customer_support_teams",
		authorName: "Priya",
		body: "Is there a version of this guide for self-hosted installs?",
	}),
	makeComment({
		id: "comment-5",
		authorName: "CheapDesignerWatches".repeat(5),
		authorEmail: "sales@watches.example",
		body: "Designer watches at outlet prices.",
	}),
];

function renderInbox({ dir = "ltr", width = 272 }: { dir?: "ltr" | "rtl"; width?: number } = {}) {
	return render(
		<div dir={dir} style={{ width }}>
			<CommentInbox
				comments={comments}
				counts={{ pending: 4, approved: 1, spam: 0, trash: 0 }}
				isLoading={false}
				collections={{ posts: { label: "Posts" } }}
				activeStatus="pending"
				onStatusChange={vi.fn()}
				collectionFilter=""
				onCollectionFilterChange={vi.fn()}
				searchQuery=""
				onSearchChange={vi.fn()}
				onCommentStatusChange={vi.fn().mockResolvedValue(undefined)}
				onCommentDelete={vi.fn().mockResolvedValue(undefined)}
				onBulkAction={vi.fn().mockResolvedValue(undefined)}
				onLoadMore={vi.fn()}
				isAdmin={true}
				isStatusPending={false}
				deleteError={null}
				onDeleteErrorReset={vi.fn()}
				bulkError={null}
				onBulkErrorReset={vi.fn()}
			/>
		</div>,
	);
}

function expectInside(element: Element, box: DOMRect) {
	const bounds = element.getBoundingClientRect();
	expect(bounds.left).toBeGreaterThanOrEqual(box.left);
	expect(bounds.right).toBeLessThanOrEqual(box.right);
}

describe("Comment inbox at phone width", () => {
	it.each(["ltr", "rtl"] as const)(
		"shows each comment with its details and actions in a 272px table in %s",
		async (dir) => {
			const screen = await renderInbox({ dir });
			const tray = screen.getByRole("table").element().parentElement!;
			const box = tray.getBoundingClientRect();

			expect(tray.scrollWidth).toBeLessThanOrEqual(tray.clientWidth);
			for (const name of ["Content", "Date"]) {
				expect(
					screen.getByRole("columnheader", { name, includeHidden: true }).element(),
				).not.toBeVisible();
			}
			for (const { authorName, body, collection } of comments) {
				const cell = page.elementLocator(
					screen.getByRole("button", { name: authorName, exact: true }).element().closest("td")!,
				);
				await expect.element(cell.getByRole("button", { name: body.slice(0, 20) })).toBeVisible();
				await expect.element(cell.getByText(collection, { exact: true })).toBeVisible();
				await expect.element(cell.getByText(commentDate, { exact: true })).toBeVisible();
				expectInside(cell.element(), box);
			}

			const menus = screen.getByRole("button", { name: /^Actions for comment by / }).elements();
			const approves = screen.getByRole("button", { name: "Approve", exact: true }).elements();
			expect(menus).toHaveLength(comments.length);
			expect(approves).toHaveLength(comments.filter((c) => c.status !== "approved").length);
			for (const button of [...menus, ...approves]) expectInside(button, box);
		},
	);

	it("fits the bulk actions for two selected comments", async () => {
		const screen = await renderInbox();
		const box = screen.container.firstElementChild!.getBoundingClientRect();

		await screen.getByRole("checkbox", { name: "Select comment by Sam" }).click();
		await screen.getByRole("checkbox", { name: "Select comment by Maya Chen" }).click();

		const bar = screen.getByText("2 selected").element().parentElement!;
		expectInside(bar, box);
		expect(bar.scrollWidth).toBeLessThanOrEqual(bar.clientWidth);
		for (const name of ["Approve", "Spam", "Trash", "Delete", "Clear"]) {
			const button = page.elementLocator(bar).getByRole("button", { name, exact: true });
			await expect.element(button).toBeVisible();
			expectInside(button.element(), bar.getBoundingClientRect());
		}
	});
});

describe("Comment inbox at desktop width", () => {
	it("fits a long unbroken author name and collection in a 716px table", async () => {
		const screen = await renderInbox({ width: 716 });
		const tray = screen.getByRole("table").element().parentElement!;

		await expect.element(screen.getByRole("columnheader", { name: "Content" })).toBeVisible();
		expect(tray.scrollWidth).toBeLessThanOrEqual(tray.clientWidth);
	});
});
