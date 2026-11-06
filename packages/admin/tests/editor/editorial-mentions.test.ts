import { describe, expect, it } from "vitest";

import { bodyToDraft, draftToBody } from "../../src/components/editorial/mentions";

const GRACE = { id: "u-grace", name: "Grace Hopper", avatarUrl: null };
const GRACIE = { id: "u-gracie", name: "Grace", avatarUrl: null };
const ODD = { id: "u-odd", name: "J. (Jo) Smith", avatarUrl: null };

describe("mention drafts", () => {
	it("shows tokens as names and puts them back on save", () => {
		const body = `<@${GRACE.id}> can you check this? cc <@${ODD.id}>`;

		const draft = bodyToDraft(body, [GRACE, ODD]);

		expect(draft.text).toBe("@Grace Hopper can you check this? cc @J. (Jo) Smith");
		expect(draftToBody(draft)).toBe(body);
	});

	it("keeps the token for a user it can't name", () => {
		const draft = bodyToDraft("Ask <@u-gone>", []);

		expect(draft.text).toBe("Ask <@u-gone>");
		expect(draftToBody(draft)).toBe("Ask <@u-gone>");
	});

	it("matches the longest name first, and only whole names", () => {
		const draft = {
			text: "@Grace Hopper and @Grace agree, but @Graceful doesn't",
			mentions: [GRACIE, GRACE],
		};

		expect(draftToBody(draft)).toBe(
			`<@${GRACE.id}> and <@${GRACIE.id}> agree, but @Graceful doesn't`,
		);
	});

	it("leaves a typed @name alone when nobody was picked", () => {
		expect(draftToBody({ text: "@Grace Hopper?", mentions: [] })).toBe("@Grace Hopper?");
	});
});
