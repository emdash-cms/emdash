import { describe, expect, it } from "vitest";

import type { RevisionListItem, RevisionListResponse } from "../../src/lib/api";
import { withAutosavedDraft } from "../../src/lib/revision-list-cache";

const maya = { id: "user_1", name: "Maya Chen" };
const ben = { id: "user_2", name: "Ben Okafor" };

function revision(id: string): RevisionListItem {
	return {
		id,
		collection: "posts",
		entryId: "post_1",
		data: { title: id },
		authorId: "user_1",
		author: maya,
		createdAt: "2026-10-01 10:00:00",
		editedBy: null,
	};
}

function list(ids: string[], total = ids.length): RevisionListResponse {
	return { items: ids.map(revision), total };
}

const autosaved = revision("rev-autosaved");

describe("withAutosavedDraft", () => {
	it("puts the autosaved draft in place of the draft it replaced", () => {
		const next = withAutosavedDraft(list(["rev-draft", "rev-live"]), {
			draft: autosaved,
			previousDraftId: "rev-draft",
			previousIsAutosave: true,
			liveRevisionId: "rev-live",
			limit: 21,
		});
		expect(next.items.map((item) => item.id)).toEqual(["rev-autosaved", "rev-live"]);
		expect(next.total).toBe(2);
	});

	it("keeps a replaced draft that is also the live version", () => {
		const next = withAutosavedDraft(list(["rev-live", "rev-old"]), {
			draft: autosaved,
			previousDraftId: "rev-live",
			previousIsAutosave: true,
			liveRevisionId: "rev-live",
			limit: 21,
		});
		expect(next.items.map((item) => item.id)).toEqual(["rev-autosaved", "rev-live", "rev-old"]);
		expect(next.items[0]?.editedBy).toBeNull();
		expect(next.total).toBe(3);
	});

	it("keeps a draft this client didn't autosave, such as one saved with Save", () => {
		const saved = { ...revision("rev-saved"), authorId: ben.id, author: ben };
		const next = withAutosavedDraft(
			{ items: [saved, revision("rev-live")], total: 2 },
			{
				draft: autosaved,
				previousDraftId: "rev-saved",
				previousIsAutosave: false,
				liveRevisionId: "rev-live",
				limit: 21,
			},
		);
		expect(next.items.map((item) => item.id)).toEqual(["rev-autosaved", "rev-saved", "rev-live"]);
		expect(next.items[0]?.editedBy).toBeNull();
		expect(next.total).toBe(3);
	});

	it("names the autosave's editor first, then each editor of the draft it replaced once", () => {
		const replaced = {
			...revision("rev-draft"),
			authorId: ben.id,
			author: ben,
			editedBy: [ben, maya],
		};
		const next = withAutosavedDraft(
			{ items: [replaced, revision("rev-live")], total: 2 },
			{
				draft: autosaved,
				previousDraftId: "rev-draft",
				previousIsAutosave: true,
				liveRevisionId: "rev-live",
				limit: 21,
			},
		);
		expect(next.items[0]?.editedBy).toEqual([maya, ben]);
	});

	it("adds the first draft at the top and keeps the list within its limit", () => {
		const next = withAutosavedDraft(list(["rev-live", "rev-2", "rev-1"], 5), {
			draft: autosaved,
			previousDraftId: null,
			previousIsAutosave: false,
			liveRevisionId: "rev-live",
			limit: 3,
		});
		expect(next.items.map((item) => item.id)).toEqual(["rev-autosaved", "rev-live", "rev-2"]);
		expect(next.total).toBe(6);
	});

	it("counts the autosaved draft as new when the draft it replaced isn't in the list", () => {
		const next = withAutosavedDraft(list(["rev-live", "rev-old"], 4), {
			draft: autosaved,
			previousDraftId: "rev-elsewhere",
			previousIsAutosave: true,
			liveRevisionId: "rev-live",
			limit: 21,
		});
		expect(next.items.map((item) => item.id)).toEqual(["rev-autosaved", "rev-live", "rev-old"]);
		expect(next.total).toBe(5);
	});

	it("leaves a list that already holds the autosaved draft as it is", () => {
		const next = withAutosavedDraft(list(["rev-autosaved", "rev-live"]), {
			draft: autosaved,
			previousDraftId: "rev-draft",
			previousIsAutosave: true,
			liveRevisionId: "rev-live",
			limit: 21,
		});
		expect(next.items.map((item) => item.id)).toEqual(["rev-autosaved", "rev-live"]);
		expect(next.total).toBe(2);
	});
});
