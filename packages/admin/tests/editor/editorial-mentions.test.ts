import { describe, expect, it } from "vitest";

import {
	bodyToDraft,
	draftToBody,
	updateDraftText,
	type MentionDraft,
} from "../../src/components/editorial/mentions";

const GRACE = { id: "u-grace", name: "Grace Hopper", avatarUrl: null };
const ODD = { id: "u-odd", name: "J. (Jo) Smith", avatarUrl: null };
const ANN = { id: "u-ann", name: "Ann", avatarUrl: null };
const ANN_TOO = { id: "u-ann-2", name: "Ann", avatarUrl: null };

/** Types `insert` with the caret at `at`, as the textarea would report it. */
function type(draft: MentionDraft, at: number, insert: string): MentionDraft {
	const text = draft.text.slice(0, at) + insert + draft.text.slice(at);
	return updateDraftText(draft, text, at + insert.length);
}

function backspace(draft: MentionDraft, at: number): MentionDraft {
	return updateDraftText(draft, draft.text.slice(0, at - 1) + draft.text.slice(at), at - 1);
}

describe("mention drafts", () => {
	it("shows tokens as names and puts them back on save", () => {
		const body = `<@${GRACE.id}> can you check this? cc <@${ODD.id}>`;

		const draft = bodyToDraft(body, [GRACE, ODD], "Unknown user");

		expect(draft.text).toBe("@Grace Hopper can you check this? cc @J. (Jo) Smith");
		expect(draftToBody(draft)).toBe(body);
	});

	it("names a user it doesn't know and keeps their token", () => {
		const draft = bodyToDraft("Ask <@u-gone>", [], "Unknown user");

		expect(draft.text).toBe("Ask @Unknown user");
		expect(draftToBody(draft)).toBe("Ask <@u-gone>");
	});

	it("keeps two people with the same name apart", () => {
		const body = `<@${ANN.id}> and <@${ANN_TOO.id}>`;

		const draft = bodyToDraft(body, [ANN, ANN_TOO], "Unknown user");

		expect(draft.text).toBe("@Ann and @Ann");
		expect(draftToBody(draft)).toBe(body);
	});

	it("leaves a typed @name alone", () => {
		const draft = bodyToDraft(`<@${ANN.id}> said`, [ANN], "Unknown user");

		expect(draftToBody(type(draft, draft.text.length, " @Ann"))).toBe(`<@${ANN.id}> said @Ann`);
	});

	it("moves mentions with the text before them", () => {
		const draft = bodyToDraft(`ask <@${ANN.id}>`, [ANN], "Unknown user");

		expect(draftToBody(type(draft, 0, "Please "))).toBe(`Please ask <@${ANN.id}>`);
		expect(draftToBody(backspace(draft, 1))).toBe(`sk <@${ANN.id}>`);
	});

	it("drops a mention whose name is changed", () => {
		const draft = bodyToDraft(`<@${ANN.id}>`, [ANN], "Unknown user");

		expect(draftToBody(type(draft, 3, "n"))).toBe("@Annn");
		expect(draftToBody(backspace(draft, 4))).toBe("@An");
	});

	it("keeps a mention when punctuation is typed straight after it", () => {
		const draft = bodyToDraft(`<@${ANN.id}>`, [ANN], "Unknown user");

		expect(draftToBody(type(draft, 4, ","))).toBe(`<@${ANN.id}>,`);
	});
});
