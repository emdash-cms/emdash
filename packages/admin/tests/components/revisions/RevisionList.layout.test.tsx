import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import "../../../dist/styles.css";
import { RevisionHistory } from "../../../src/components/RevisionHistory";
import { REVISION_LIST_LIMIT } from "../../../src/components/revisions/revision-query.js";
import { RevisionViewProvider } from "../../../src/components/revisions/revision-view-context.js";
import type { RevisionListItem } from "../../../src/lib/api";
import { render } from "../../utils/render.tsx";

vi.mock("../../../src/lib/api", async () => {
	const actual = await vi.importActual("../../../src/lib/api");
	return { ...actual, fetchRevisions: vi.fn() };
});

import { fetchRevisions } from "../../../src/lib/api";

function revision(id: string, title: string, hoursAgo: number): RevisionListItem {
	const date = new Date(Date.now() - hoursAgo * 3_600_000);
	return {
		id,
		collection: "posts",
		entryId: "entry-1",
		data: { title },
		authorId: "u-maya",
		author: { id: "u-maya", name: "Maya Chen" },
		createdAt: date.toISOString().replace("T", " ").slice(0, 19),
	};
}

/** Where a element's text starts, ignoring its padding. */
function textStart(element: Element): number {
	const range = document.createRange();
	range.selectNodeContents(element);
	return range.getBoundingClientRect().left;
}

beforeEach(() => {
	vi.resetAllMocks();
	(fetchRevisions as Mock).mockResolvedValue({
		items: [
			revision("rev-3", "First draft", 1),
			revision("rev-2", "Second draft", 2),
			revision("rev-1", "First draft", 3),
		],
		total: 3,
	});
});

describe("RevisionList layout", () => {
	it("lines up a version's time, author, restore note and changes on one edge", async () => {
		const screen = await render(
			<div style={{ width: 320 }}>
				<RevisionViewProvider
					value={{
						viewingId: "rev-3",
						viewingDiff: {
							hasPrevious: true,
							fields: [],
							slug: null,
							changes: [
								{ kind: "restored", revisionId: "rev-1" },
								{ kind: "title", field: { slug: "title", label: "Title" }, target: "f-title" },
							],
						},
						currentRevisionId: "rev-3",
						liveRevisionId: null,
						fields: { title: { kind: "string", label: "Title" } },
						rowToFocus: null,
						clearRowToFocus: vi.fn(),
						listLimit: REVISION_LIST_LIMIT,
						showOlderVersions: vi.fn(),
						view: vi.fn(),
						exit: vi.fn(),
						goToChange: vi.fn(),
					}}
				>
					<RevisionHistory collection="posts" entryId="entry-1" />
				</RevisionViewProvider>
			</div>,
		);
		await screen.getByRole("button", { name: /^Revisions/ }).click();
		const change = screen.getByRole("button", { name: "Changed the title" });
		await expect.element(change).toBeVisible();

		const row = screen.getByRole("button", { name: /Current version/ }).element();
		const edge = textStart(row.querySelector("time")!);
		const author = [...row.querySelectorAll("bdi")].find((bdi) => bdi.textContent === "Maya Chen")!;
		expect(textStart(author)).toBeCloseTo(edge, 0);
		const restoreNote = screen.getByText(/^Restored from/).element().parentElement!;
		expect(restoreNote.getBoundingClientRect().left).toBeCloseTo(edge, 0);
		expect(textStart(change.element())).toBeCloseTo(edge, 0);
	});
});
