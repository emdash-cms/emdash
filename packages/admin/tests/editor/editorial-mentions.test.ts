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
const UNNAMED = { id: "u-unnamed", name: null, avatarUrl: null };
const LABELS = { unknown: "Unknown user", unnamed: "Unnamed user" };

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

		const draft = bodyToDraft(body, [GRACE, ODD], LABELS);

		expect(draft.text).toBe("@Grace Hopper can you check this? cc @J. (Jo) Smith");
		expect(draftToBody(draft)).toBe(body);
	});

	it("names a user it doesn't know and keeps their token", () => {
		const draft = bodyToDraft("Ask <@u-gone>", [], LABELS);

		expect(draft.text).toBe("Ask @Unknown user");
		expect(draftToBody(draft)).toBe("Ask <@u-gone>");
	});

	it("keeps two people with the same name apart", () => {
		const body = `<@${ANN.id}> and <@${ANN_TOO.id}>`;

		const draft = bodyToDraft(body, [ANN, ANN_TOO], LABELS);

		expect(draft.text).toBe("@Ann and @Ann");
		expect(draftToBody(draft)).toBe(body);
	});

	it("leaves a typed @name alone", () => {
		const draft = bodyToDraft(`<@${ANN.id}> said`, [ANN], LABELS);

		expect(draftToBody(type(draft, draft.text.length, " @Ann"))).toBe(`<@${ANN.id}> said @Ann`);
	});

	it("moves mentions with the text before them", () => {
		const draft = bodyToDraft(`ask <@${ANN.id}>`, [ANN], LABELS);

		expect(draftToBody(type(draft, 0, "Please "))).toBe(`Please ask <@${ANN.id}>`);
		expect(draftToBody(backspace(draft, 1))).toBe(`sk <@${ANN.id}>`);
	});

	it("drops a mention whose name is changed", () => {
		const draft = bodyToDraft(`<@${ANN.id}>`, [ANN], LABELS);

		expect(draftToBody(type(draft, 3, "n"))).toBe("@Annn");
		expect(draftToBody(backspace(draft, 4))).toBe("@An");
	});

	it("keeps a mention when punctuation is typed straight after it", () => {
		const draft = bodyToDraft(`<@${ANN.id}>`, [ANN], LABELS);

		expect(draftToBody(type(draft, 4, ","))).toBe(`<@${ANN.id}>,`);
	});

	it("drops a mention when a letter or digit is typed straight after it", () => {
		const draft = bodyToDraft(`<@${ANN.id}>`, [ANN], LABELS);

		expect(draftToBody(type(draft, 4, "e"))).toBe("@Anne");
		expect(draftToBody(type(draft, 4, "2"))).toBe("@Ann2");
		expect(draftToBody(type(draft, 4, "\u0301"))).toBe("@Ann\u0301");
	});

	it("drops a mention when deleting the space after it joins it to a word", () => {
		const draft = bodyToDraft(`<@${ANN.id}> xyz`, [ANN], LABELS);

		expect(draftToBody(backspace(draft, 5))).toBe("@Annxyz");
		expect(draftToBody(backspace(draft, 6))).toBe(`<@${ANN.id}> yz`);
	});

	it("names someone without a name as an unnamed user", () => {
		const draft = bodyToDraft(`ask <@${UNNAMED.id}>`, [UNNAMED], LABELS);

		expect(draft.text).toBe("ask @Unnamed user");
		expect(draftToBody(draft)).toBe(`ask <@${UNNAMED.id}>`);
	});

	it("saves a typed token as text that mentions nobody", () => {
		const draft = type({ text: "", mentions: [] }, 0, `ping <@here> and <@${ANN.id}>`);

		const body = draftToBody(draft);

		expect(body).not.toMatch(/<@[^<>\s]+>/);
		expect(body.replaceAll("\u200B", "")).toBe(`ping <@here> and <@${ANN.id}>`);
		expect(draftToBody(bodyToDraft(body, [ANN], LABELS))).toBe(body);
	});
});
