import { i18n } from "@lingui/core";
import * as React from "react";
import { beforeAll, beforeEach, describe, it, expect, vi } from "vitest";
import { page, userEvent } from "vitest/browser";

import { CommentInbox } from "../../src/components/comments/CommentInbox";
import type { AdminComment, BulkAction, CommentCounts } from "../../src/lib/api/comments.js";
// @ts-ignore — compiled lingui catalog has no .d.ts
import { messages as enMessages } from "../../src/locales/en/messages.mjs";
import { render } from "../utils/render.tsx";

beforeAll(() => {
	i18n.loadAndActivate({ locale: "en", messages: enMessages });
});

const sampleComment: AdminComment = {
	id: "01J000000000000000000000A1",
	collection: "posts",
	contentId: "01J000000000000000000000B1",
	parentId: null,
	authorName: "Author Dash",
	authorEmail: "authdash@example.com",
	authorUserId: null,
	body: "Lovely post!",
	status: "pending",
	ipHash: null,
	userAgent: null,
	moderationMetadata: null,
	createdAt: new Date("2026-01-01T00:00:00Z").toISOString(),
	updatedAt: new Date("2026-01-01T00:00:00Z").toISOString(),
};

const counts: CommentCounts = { pending: 1, approved: 0, spam: 0, trash: 0 };

const noopProps = {
	comments: [sampleComment],
	counts,
	isLoading: false,
	collections: { posts: { label: "Posts" } },
	activeStatus: "pending" as const,
	onStatusChange: vi.fn(),
	collectionFilter: "",
	onCollectionFilterChange: vi.fn(),
	searchQuery: "",
	onSearchChange: vi.fn(),
	onCommentStatusChange: vi.fn().mockResolvedValue(undefined),
	onCommentDelete: vi.fn().mockResolvedValue(undefined),
	onBulkAction: vi.fn().mockResolvedValue(undefined),
	onLoadMore: vi.fn(),
	isAdmin: true,
	isStatusPending: false,
	deleteError: null,
	onDeleteErrorReset: vi.fn(),
	bulkError: null,
	onBulkErrorReset: vi.fn(),
};

describe("CommentInbox", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("keeps status switching wired through the page header", async () => {
		const screen = await render(<CommentInbox {...noopProps} />);

		const pendingTab = screen.getByRole("tab", { name: /^Pending/ });
		const approvedTab = screen.getByRole("tab", { name: "Approved" });

		await expect.element(pendingTab).toHaveAttribute("aria-selected", "true");
		expect(pendingTab.element().querySelector("svg")).toHaveAttribute("aria-hidden", "true");
		expect(approvedTab.element().querySelector("svg")).toHaveAttribute("aria-hidden", "true");
		await approvedTab.click();

		expect(noopProps.onStatusChange).toHaveBeenCalledWith("approved");
	});

	it("shows page context and a standalone empty state without table chrome", async () => {
		const screen = await render(
			<CommentInbox
				{...noopProps}
				comments={[]}
				counts={{ pending: 0, approved: 0, spam: 0, trash: 0 }}
			/>,
		);

		await expect
			.element(screen.getByText("Review and moderate comments across your content."))
			.toBeInTheDocument();
		await expect.element(screen.getByText("No comments awaiting moderation.")).toBeInTheDocument();
		expect(screen.getByRole("table").query()).toBeNull();
	});

	it("toggles selection when a row checkbox is clicked", async () => {
		const screen = await render(<CommentInbox {...noopProps} />);

		const checkbox = screen.getByRole("checkbox", { name: "Select comment by Author Dash" });
		await expect.element(checkbox).toBeInTheDocument();

		await checkbox.click();

		// Bulk action bar appears only after at least one comment is selected.
		await expect.element(screen.getByText("1 selected")).toBeInTheDocument();
	});

	it("toggles all rows when the select-all checkbox is clicked", async () => {
		const screen = await render(<CommentInbox {...noopProps} />);

		const selectAll = screen.getByRole("checkbox", { name: "Select all on this page" });
		await selectAll.click();

		await expect.element(screen.getByText("1 selected")).toBeInTheDocument();
	});

	it("approves a comment with the Approve button on its row", async () => {
		const screen = await render(<CommentInbox {...noopProps} />);

		await screen.getByRole("button", { name: "Approve", exact: true }).click();

		expect(noopProps.onCommentStatusChange).toHaveBeenCalledWith(sampleComment.id, "approved");
	});

	it("moves focus to the next comment's Approve button once an approved comment leaves", async () => {
		const pending = [1, 2, 3].map((n) => ({
			...sampleComment,
			id: `comment-${n}`,
			authorName: `Author ${n}`,
		}));
		function ModeratedInbox() {
			const [comments, setComments] = React.useState(pending);
			const [isStatusPending, setStatusPending] = React.useState(false);
			return (
				<CommentInbox
					{...noopProps}
					comments={comments}
					isStatusPending={isStatusPending}
					onCommentStatusChange={async (id) => {
						setStatusPending(true);
						await new Promise((resolve) => setTimeout(resolve, 20));
						setStatusPending(false);
						// The list refetch lands after the status change settles.
						setTimeout(() => setComments((current) => current.filter((c) => c.id !== id)), 20);
					}}
				/>
			);
		}
		const screen = await render(<ModeratedInbox />);
		const approve = (author: string) =>
			screen
				.getByRole("row")
				.filter({ hasText: author })
				.getByRole("button", { name: "Approve", exact: true });
		await expect.element(approve("Author 2")).toBeInTheDocument();
		approve("Author 2").element().focus();

		await userEvent.keyboard("{Enter}");

		await expect.element(screen.getByText("Author 2")).not.toBeInTheDocument();
		await expect.element(approve("Author 3")).toHaveFocus();
	});

	it("leaves Approve off the row of an approved comment", async () => {
		const screen = await render(
			<CommentInbox
				{...noopProps}
				activeStatus="approved"
				comments={[{ ...sampleComment, status: "approved" }]}
			/>,
		);

		await expect
			.element(screen.getByRole("button", { name: "Actions for comment by Author Dash" }))
			.toBeVisible();
		expect(screen.getByRole("button", { name: "Approve", exact: true }).query()).toBeNull();
	});

	it.each([
		["Mark as spam", "spam"],
		["Trash", "trash"],
	] as const)("moves a comment with %s in its row's menu", async (item, status) => {
		const screen = await render(<CommentInbox {...noopProps} />);

		await screen.getByRole("button", { name: "Actions for comment by Author Dash" }).click();
		await screen.getByRole("menuitem", { name: item, exact: true }).click();

		expect(noopProps.onCommentStatusChange).toHaveBeenCalledWith(sampleComment.id, status);
	});

	it("offers Delete permanently in the row's menu only to admins", async () => {
		const screen = await render(<CommentInbox {...noopProps} isAdmin={false} />);
		const menuButton = screen.getByRole("button", { name: "Actions for comment by Author Dash" });

		await menuButton.click();
		await expect.element(screen.getByRole("menuitem", { name: "Trash" })).toBeVisible();
		expect(screen.getByRole("menuitem", { name: "Delete permanently" }).query()).toBeNull();
		await userEvent.keyboard("{Escape}");

		await screen.rerender(<CommentInbox {...noopProps} isAdmin={true} />);
		await menuButton.click();
		await screen.getByRole("menuitem", { name: "Delete permanently" }).click();

		await expect.element(screen.getByRole("dialog", { name: "Delete Comment?" })).toBeVisible();
		expect(noopProps.onCommentDelete).not.toHaveBeenCalled();
	});

	it("opens a comment's details from its author's name", async () => {
		const screen = await render(<CommentInbox {...noopProps} />);

		await screen.getByRole("button", { name: "Author Dash", exact: true }).click();

		await expect.element(screen.getByRole("heading", { name: "Comment Detail" })).toBeVisible();
	});

	it("asks before deleting the selected comments and deletes nothing on cancel", async () => {
		const screen = await render(<CommentInbox {...noopProps} />);
		const dialog = screen.getByRole("dialog", { name: "Delete Permanently?" });

		await screen.getByRole("checkbox", { name: "Select comment by Author Dash" }).click();
		await screen.getByRole("button", { name: "Delete", exact: true }).click();

		await expect.element(dialog).toBeVisible();
		await expect
			.element(dialog.getByText("Permanently delete 1 comment? This cannot be undone."))
			.toBeVisible();
		expect(noopProps.onBulkAction).not.toHaveBeenCalled();

		// Direct DOM clicks bypass Base UI's inert overlay, which covers the unstyled dialog.
		dialog.getByRole("button", { name: "Cancel" }).element().click();
		await expect.element(dialog).not.toBeInTheDocument();
		expect(noopProps.onBulkAction).not.toHaveBeenCalled();
		await expect.element(screen.getByText("1 selected")).toBeInTheDocument();

		await screen.getByRole("button", { name: "Delete", exact: true }).click();
		dialog.getByRole("button", { name: "Delete", exact: true }).element().click();

		expect(noopProps.onBulkAction).toHaveBeenCalledWith([sampleComment.id], "delete");
		await expect.element(dialog).not.toBeInTheDocument();
	});

	it("disables the bulk actions while another request is running", async () => {
		const screen = await render(<CommentInbox {...noopProps} />);
		await screen.getByRole("checkbox", { name: "Select comment by Author Dash" }).click();
		const count = screen.getByText("1 selected");
		await expect.element(count).toBeVisible();
		const barElement = count.element().parentElement!;

		await screen.rerender(<CommentInbox {...noopProps} isStatusPending={true} />);

		const bar = page.elementLocator(barElement);
		for (const name of ["Approve", "Spam", "Trash", "Delete"]) {
			await expect.element(bar.getByRole("button", { name, exact: true })).toBeDisabled();
		}
		await expect.element(count).toBeVisible();
	});

	it("says it is working on the selection while a bulk action runs", async () => {
		const approve = Promise.withResolvers<void>();
		const screen = await render(
			<CommentInbox {...noopProps} onBulkAction={vi.fn(() => approve.promise)} />,
		);
		await screen.getByRole("checkbox", { name: "Select comment by Author Dash" }).click();
		const count = screen.getByText("1 selected");
		await expect.element(count).toBeVisible();
		await page
			.elementLocator(count.element().parentElement!)
			.getByRole("button", { name: "Approve", exact: true })
			.click();

		const working = screen.getByText(/^Working on 1 items/);
		await expect.element(working).toBeVisible();
		await expect.element(screen.getByRole("button", { name: "Clear", exact: true })).toBeDisabled();
		approve.resolve();
		await expect.element(working).not.toBeInTheDocument();
	});

	it("deletes the comments the bulk Delete dialog named even after the selection clears", async () => {
		const spam = Promise.withResolvers<void>();
		const onBulkAction = vi.fn((_ids: string[], action: BulkAction) =>
			action === "spam" ? spam.promise : Promise.resolve(),
		);
		const screen = await render(<CommentInbox {...noopProps} onBulkAction={onBulkAction} />);
		const dialog = screen.getByRole("dialog", { name: "Delete Permanently?" });

		await screen.getByRole("checkbox", { name: "Select comment by Author Dash" }).click();
		await screen.getByRole("button", { name: "Spam", exact: true }).click();
		const working = screen.getByText(/^Working on 1 items/);
		await expect.element(working).toBeVisible();
		await screen.getByRole("button", { name: "Delete", exact: true }).click();
		await expect.element(dialog).toBeVisible();

		spam.resolve();
		await expect.element(working).not.toBeInTheDocument();
		dialog.getByRole("button", { name: "Delete", exact: true }).element().click();

		expect(onBulkAction).toHaveBeenLastCalledWith([sampleComment.id], "delete");
	});

	it("keeps the bulk delete dialog open while the delete runs", async () => {
		const onBulkAction = vi.fn(() => new Promise<void>(() => {}));
		const screen = await render(<CommentInbox {...noopProps} onBulkAction={onBulkAction} />);
		const dialog = screen.getByRole("dialog", { name: "Delete Permanently?" });

		await screen.getByRole("checkbox", { name: "Select comment by Author Dash" }).click();
		await screen.getByRole("button", { name: "Delete", exact: true }).click();
		await expect.element(dialog).toBeVisible();
		dialog.getByRole("button", { name: "Delete", exact: true }).element().click();
		await screen.rerender(
			<CommentInbox {...noopProps} onBulkAction={onBulkAction} isStatusPending={true} />,
		);

		await expect.element(dialog.getByRole("button", { name: "Cancel" })).toBeDisabled();
		await userEvent.keyboard("{Escape}");
		await expect.element(dialog).toBeVisible();
	});
});
