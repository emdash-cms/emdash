import { describe, it, expect, vi, beforeEach } from "vitest";

import type { ContentItem, FindManyResult } from "../../src/lib/api";
import { render } from "../utils/render.tsx";

const mockFetchContentList = vi.fn<() => Promise<FindManyResult<ContentItem>>>();

vi.mock("../../src/lib/api", async () => {
	const actual = await vi.importActual("../../src/lib/api");
	return {
		...actual,
		fetchCollections: vi.fn(async () => []),
		fetchContentList: (...args: unknown[]) => mockFetchContentList(...(args as [])),
	};
});

const { ContentPickerModal } = await import("../../src/components/ContentPickerModal");

function makeItem(overrides: Partial<ContentItem> = {}): ContentItem {
	return {
		id: "post-en",
		type: "posts",
		slug: "jane-doe",
		status: "published",
		locale: "en",
		translationGroup: "grp-1",
		data: { title: "Jane Doe" },
		authorId: null,
		primaryBylineId: null,
		createdAt: "2026-01-01T00:00:00Z",
		updatedAt: "2026-01-01T00:00:00Z",
		publishedAt: "2026-01-01T00:00:00Z",
		scheduledAt: null,
		liveRevisionId: null,
		draftRevisionId: null,
		...overrides,
	};
}

describe("ContentPickerModal", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("disables an entry already linked through another locale variant", async () => {
		// The editor is at `fr` and the reference resolved to the `fr` row, but the
		// picker's result page only carries the `en` variant of that same entry
		// (search matched the English title; the rest is behind the cursor).
		mockFetchContentList.mockResolvedValue({
			items: [makeItem()],
			nextCursor: "cursor-1",
		});

		const screen = await render(
			<ContentPickerModal
				open
				onOpenChange={() => {}}
				collection="posts"
				multiple
				locale="fr"
				selectedIds={new Set(["grp-1"])}
				onConfirm={() => {}}
			/>,
		);

		await expect.element(screen.getByText("Jane Doe")).toBeInTheDocument();
		await expect.element(screen.getByRole("checkbox", { name: "Jane Doe" })).toBeDisabled();
		await expect.element(screen.getByRole("checkbox", { name: "Jane Doe" })).toBeChecked();
	});

	it("matches by row id when no locale is given (menu picker)", async () => {
		mockFetchContentList.mockResolvedValue({ items: [makeItem()] });

		const screen = await render(
			<ContentPickerModal
				open
				onOpenChange={() => {}}
				collection="posts"
				multiple
				selectedIds={new Set(["post-en"])}
				onConfirm={() => {}}
			/>,
		);

		await expect.element(screen.getByRole("checkbox", { name: "Jane Doe" })).toBeDisabled();
	});
});
