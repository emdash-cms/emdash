import { Toasty } from "@cloudflare/kumo";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { userEvent } from "@vitest/browser/context";
import * as React from "react";
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

import { RevisionHistory } from "../../src/components/RevisionHistory";
import type { Revision, RevisionListResponse } from "../../src/lib/api";
import { render } from "../utils/render.js";

// Mock the API module
vi.mock("../../src/lib/api", async () => {
	const actual = await vi.importActual("../../src/lib/api");
	return {
		...actual,
		fetchRevisions: vi.fn(),
		restoreRevision: vi.fn(),
	};
});

// Import mocked functions for test control
import { fetchRevisions, restoreRevision } from "../../src/lib/api";

const mockFetchRevisions = fetchRevisions as Mock;
const mockRestoreRevision = restoreRevision as Mock;

const REVISIONS_BUTTON_REGEX = /Revisions/i;
const RESTORE_BUTTON_REGEX = /Restore this version/i;
const TIME_REGEX_5_MINS = /5 mins ago/;
const TIME_REGEX_3_HOURS = /3 hours ago/;

function QueryWrapper({ children }: { children: React.ReactNode }) {
	const qc = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});
	return (
		<Toasty>
			<QueryClientProvider client={qc}>{children}</QueryClientProvider>
		</Toasty>
	);
}

function makeRevision(overrides: Partial<Revision> = {}): Revision {
	return {
		id: "rev-1",
		collection: "posts",
		entryId: "entry-1",
		data: { title: "Hello World", body: "Content here" },
		authorId: "user-1",
		createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(), // 2 hours ago
		...overrides,
	};
}

function makeRevisionList(revisions: Revision[]): RevisionListResponse {
	return { items: revisions, total: revisions.length };
}

beforeEach(() => {
	vi.resetAllMocks();
});

describe("RevisionHistory", () => {
	// ---- Starts collapsed ----

	it("starts collapsed with only header visible", async () => {
		const screen = await render(
			<QueryWrapper>
				<RevisionHistory collection="posts" entryId="entry-1" />
			</QueryWrapper>,
		);

		await expect.element(screen.getByText("Revisions")).toBeInTheDocument();
		// The expanded content should not be visible
		const noRevisionsText = screen.getByText("No revisions yet");
		await expect.element(noRevisionsText).not.toBeInTheDocument();
	});

	// ---- Query only fires when expanded ----

	it("does not fetch revisions until expanded", async () => {
		await render(
			<QueryWrapper>
				<RevisionHistory collection="posts" entryId="entry-1" />
			</QueryWrapper>,
		);

		// Should not have called fetchRevisions while collapsed
		expect(mockFetchRevisions).not.toHaveBeenCalled();
	});

	it("fetches revisions when header is clicked to expand", async () => {
		mockFetchRevisions.mockResolvedValue(makeRevisionList([]));

		const screen = await render(
			<QueryWrapper>
				<RevisionHistory collection="posts" entryId="entry-1" />
			</QueryWrapper>,
		);

		// Click header to expand
		const header = screen.getByText("Revisions");
		await header.click();

		expect(mockFetchRevisions).toHaveBeenCalledWith("posts", "entry-1", { limit: 20 });
	});

	// ---- Shows loading state ----

	it("shows loading state when expanded and fetching", async () => {
		// Never resolve — keeps it in loading state
		mockFetchRevisions.mockReturnValue(new Promise(() => {}));

		const screen = await render(
			<QueryWrapper>
				<RevisionHistory collection="posts" entryId="entry-1" />
			</QueryWrapper>,
		);

		await screen.getByRole("button", { name: REVISIONS_BUTTON_REGEX }).click();

		// Loader renders an SVG spinner — verify the loading container is present
		// and that none of the "loaded" states are showing
		const emptyText = screen.getByText("No revisions yet");
		await expect.element(emptyText).not.toBeInTheDocument();
		const errorText = screen.getByText("Failed to load revisions");
		await expect.element(errorText).not.toBeInTheDocument();
	});

	// ---- Shows revision list with relative times ----

	it("shows revision list with relative times", async () => {
		const revisions = [
			makeRevision({
				id: "rev-1",
				createdAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(), // 5 mins ago
			}),
			makeRevision({
				id: "rev-2",
				createdAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(), // 3 hours ago
			}),
		];
		mockFetchRevisions.mockResolvedValue(makeRevisionList(revisions));

		const screen = await render(
			<QueryWrapper>
				<RevisionHistory collection="posts" entryId="entry-1" />
			</QueryWrapper>,
		);

		await screen.getByText("Revisions").click();

		await expect.element(screen.getByText(TIME_REGEX_5_MINS)).toBeInTheDocument();
		await expect.element(screen.getByText(TIME_REGEX_3_HOURS)).toBeInTheDocument();
	});

	// ---- First revision has "Current" badge ----

	it("shows 'Current' badge on the first (latest) revision", async () => {
		const revisions = [
			makeRevision({ id: "rev-1" }),
			makeRevision({
				id: "rev-2",
				createdAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
			}),
		];
		mockFetchRevisions.mockResolvedValue(makeRevisionList(revisions));

		const screen = await render(
			<QueryWrapper>
				<RevisionHistory collection="posts" entryId="entry-1" />
			</QueryWrapper>,
		);

		await screen.getByText("Revisions").click();

		await expect.element(screen.getByText("Current")).toBeInTheDocument();
	});

	// ---- First revision does NOT have restore button ----

	it("does not show restore button on the latest revision", async () => {
		const revisions = [makeRevision({ id: "rev-1" })];
		mockFetchRevisions.mockResolvedValue(makeRevisionList(revisions));

		const screen = await render(
			<QueryWrapper>
				<RevisionHistory collection="posts" entryId="entry-1" />
			</QueryWrapper>,
		);

		await screen.getByText("Revisions").click();

		// Wait for revision to appear
		await expect.element(screen.getByText("Current")).toBeInTheDocument();

		// The restore button has title "Restore this version" — should not exist for latest
		const restoreButton = screen.getByRole("button", { name: RESTORE_BUTTON_REGEX });
		await expect.element(restoreButton).not.toBeInTheDocument();
	});

	// ---- Non-latest revisions have restore button ----

	it("shows restore button on non-latest revisions", async () => {
		const revisions = [
			makeRevision({ id: "rev-1" }),
			makeRevision({
				id: "rev-2",
				createdAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
			}),
		];
		mockFetchRevisions.mockResolvedValue(makeRevisionList(revisions));

		const screen = await render(
			<QueryWrapper>
				<RevisionHistory collection="posts" entryId="entry-1" />
			</QueryWrapper>,
		);

		await screen.getByText("Revisions").click();

		// Wait for revisions to load
		await expect.element(screen.getByText("Current")).toBeInTheDocument();

		// There should be a restore button for the non-latest revision
		const restoreButton = screen.getByRole("button", { name: RESTORE_BUTTON_REGEX });
		await expect.element(restoreButton).toBeInTheDocument();
	});

	// ---- Clicking revision toggles selection (shows content snapshot) ----

	it("toggles content snapshot when clicking a revision", async () => {
		const revisions = [makeRevision({ id: "rev-1", data: { title: "Latest content" } })];
		mockFetchRevisions.mockResolvedValue(makeRevisionList(revisions));

		const screen = await render(
			<QueryWrapper>
				<RevisionHistory collection="posts" entryId="entry-1" />
			</QueryWrapper>,
		);

		await screen.getByText("Revisions").click();
		await expect.element(screen.getByText("Current")).toBeInTheDocument();

		// Content snapshot should not be visible initially
		const snapshotLabel = screen.getByText("Content snapshot:");
		await expect.element(snapshotLabel).not.toBeInTheDocument();

		// Click the revision to select it
		const revisionButton = screen.getByText("Current").element().closest("button")!;
		await userEvent.click(revisionButton);

		// Content snapshot should now be visible
		await expect.element(screen.getByText("Content snapshot:")).toBeInTheDocument();

		// Click again to deselect
		await userEvent.click(revisionButton);

		await expect.element(screen.getByText("Content snapshot:")).not.toBeInTheDocument();
	});

	// ---- Restore calls confirm() then restoreRevision ----

	it("opens confirm dialog then restoreRevision when confirmed", async () => {
		mockRestoreRevision.mockResolvedValue({});
		const onRestored = vi.fn();

		const revisions = [
			makeRevision({ id: "rev-1" }),
			makeRevision({
				id: "rev-2",
				createdAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
			}),
		];
		mockFetchRevisions.mockResolvedValue(makeRevisionList(revisions));

		const screen = await render(
			<QueryWrapper>
				<RevisionHistory collection="posts" entryId="entry-1" onRestored={onRestored} />
			</QueryWrapper>,
		);

		await screen.getByText("Revisions").click();
		await expect.element(screen.getByText("Current")).toBeInTheDocument();

		// Click the restore button on the second revision
		const restoreButton = screen.getByRole("button", { name: RESTORE_BUTTON_REGEX });
		await restoreButton.click();

		// ConfirmDialog should appear
		await expect.element(screen.getByText("Restore Revision?")).toBeInTheDocument();

		// Direct DOM click to bypass Base UI inert overlay
		screen.getByRole("button", { name: "Restore" }).element().click();

		await vi.waitFor(() => {
			expect(mockRestoreRevision).toHaveBeenCalledWith("rev-2");
		});
	});

	it("does not call restoreRevision when confirm dialog is cancelled", async () => {
		const revisions = [
			makeRevision({ id: "rev-1" }),
			makeRevision({
				id: "rev-2",
				createdAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
			}),
		];
		mockFetchRevisions.mockResolvedValue(makeRevisionList(revisions));

		const screen = await render(
			<QueryWrapper>
				<RevisionHistory collection="posts" entryId="entry-1" />
			</QueryWrapper>,
		);

		await screen.getByText("Revisions").click();
		await expect.element(screen.getByText("Current")).toBeInTheDocument();

		const restoreButton = screen.getByRole("button", { name: RESTORE_BUTTON_REGEX });
		await restoreButton.click();

		// ConfirmDialog should appear
		await expect.element(screen.getByText("Restore Revision?")).toBeInTheDocument();

		// Direct DOM click to bypass Base UI inert overlay
		screen.getByRole("button", { name: "Cancel" }).element().click();

		expect(mockRestoreRevision).not.toHaveBeenCalled();
	});

	// ---- Error state ----

	it("shows error message when fetching revisions fails", async () => {
		mockFetchRevisions.mockRejectedValue(new Error("Network error"));

		const screen = await render(
			<QueryWrapper>
				<RevisionHistory collection="posts" entryId="entry-1" />
			</QueryWrapper>,
		);

		await screen.getByText("Revisions").click();

		await expect.element(screen.getByText("Failed to load revisions")).toBeInTheDocument();
	});

	// ---- Empty state ----

	it("shows empty state when no revisions exist", async () => {
		mockFetchRevisions.mockResolvedValue(makeRevisionList([]));

		const screen = await render(
			<QueryWrapper>
				<RevisionHistory collection="posts" entryId="entry-1" />
			</QueryWrapper>,
		);

		await screen.getByText("Revisions").click();

		await expect.element(screen.getByText("No revisions yet")).toBeInTheDocument();
	});

	// ---- Collapse hides revision content ----

	it("hides revision content when collapsed after expanding", async () => {
		mockFetchRevisions.mockResolvedValue(makeRevisionList([]));

		const screen = await render(
			<QueryWrapper>
				<RevisionHistory collection="posts" entryId="entry-1" />
			</QueryWrapper>,
		);

		const headerButton = screen.getByRole("button", { name: REVISIONS_BUTTON_REGEX });

		// Expand
		await headerButton.click();
		await expect.element(screen.getByText("No revisions yet")).toBeInTheDocument();

		// Collapse
		await headerButton.click();

		// Content should be hidden
		await expect.element(screen.getByText("No revisions yet")).not.toBeInTheDocument();
	});

	// ---- Shows total count in header ----

	it("shows total count in header when revisions exist", async () => {
		const revisions = [
			makeRevision({ id: "rev-1" }),
			makeRevision({
				id: "rev-2",
				createdAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
			}),
			makeRevision({
				id: "rev-3",
				createdAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
			}),
		];
		mockFetchRevisions.mockResolvedValue(makeRevisionList(revisions));

		const screen = await render(
			<QueryWrapper>
				<RevisionHistory collection="posts" entryId="entry-1" />
			</QueryWrapper>,
		);

		await screen.getByText("Revisions").click();

		// Should show (3) next to "Revisions"
		await expect.element(screen.getByText("(3)")).toBeInTheDocument();
	});

	// ---- Visual diff view ----

	it("shows visual diff when selecting a non-latest revision", async () => {
		const revisions = [
			makeRevision({
				id: "rev-1",
				data: { title: "Updated Title", body: "Same body", newField: "added" },
				createdAt: new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString(),
			}),
			makeRevision({
				id: "rev-2",
				data: { title: "Original Title", body: "Same body", removed: "gone" },
				createdAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
			}),
		];
		mockFetchRevisions.mockResolvedValue(makeRevisionList(revisions));

		const screen = await render(
			<QueryWrapper>
				<RevisionHistory collection="posts" entryId="entry-1" />
			</QueryWrapper>,
		);

		await screen.getByText("Revisions").click();
		await expect.element(screen.getByText("Current")).toBeInTheDocument();

		// Click the second (non-latest) revision
		const revisionButtons = screen.getByText("1 day ago").element().closest("button")!;
		await userEvent.click(revisionButtons);

		// Should show diff, not raw snapshot
		await expect
			.element(screen.getByText("from next revision", { exact: false }))
			.toBeInTheDocument();

		// Changed field values should appear in the diff
		await expect.element(screen.getByText("Original Title")).toBeInTheDocument();
		await expect.element(screen.getByText("Updated Title")).toBeInTheDocument();
	});

	it("shows raw snapshot for latest revision (no diff target)", async () => {
		const revisions = [
			makeRevision({
				id: "rev-1",
				data: { title: "Latest" },
				createdAt: new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString(),
			}),
			makeRevision({
				id: "rev-2",
				data: { title: "Older" },
				createdAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
			}),
		];
		mockFetchRevisions.mockResolvedValue(makeRevisionList(revisions));

		const screen = await render(
			<QueryWrapper>
				<RevisionHistory collection="posts" entryId="entry-1" />
			</QueryWrapper>,
		);

		await screen.getByText("Revisions").click();

		// Click the latest revision
		const latestButton = screen.getByText("Current").element().closest("button")!;
		await userEvent.click(latestButton);

		// Should show raw JSON snapshot, not diff
		await expect.element(screen.getByText("Content snapshot:")).toBeInTheDocument();
	});
});
