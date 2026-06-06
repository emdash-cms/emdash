import { i18n } from "@lingui/core";
import * as React from "react";
import { beforeAll, describe, it, expect, vi } from "vitest";

import { CommentInbox } from "../../src/components/comments/CommentInbox";
import type { AdminComment, CommentCounts } from "../../src/lib/api/comments.js";
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
};

describe("CommentInbox", () => {
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

		const selectAll = screen.getByRole("checkbox", { name: "Select all" });
		await selectAll.click();

		await expect.element(screen.getByText("1 selected")).toBeInTheDocument();
	});
});
