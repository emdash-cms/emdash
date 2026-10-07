import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	isDesignPullRequest,
	isProposalPath,
	parseProposal,
	statusTransition,
} from "./proposal-discussions.mjs";

const REPO = "emdash-cms/emdash";

function proposal({ status, discussion = "null", discussions }) {
	const links = discussions
		? `discussions:\n${discussions.map((url) => `  - ${url}`).join("\n")}`
		: `discussion: ${discussion}`;
	return `---\ntitle: Example\ntype: feature-plan\nstatus: ${status}\n${links}\ncreated: 2026-10-06\n---\n\n# Example\n\nSee https://github.com/${REPO}/discussions/999 for background.\n`;
}

describe("parseProposal", () => {
	it("reads the status and a single discussion link", () => {
		const parsed = parseProposal(
			proposal({ status: "accepted", discussion: `https://github.com/${REPO}/discussions/12` }),
			REPO,
		);

		assert.deepEqual(parsed, { status: "accepted", discussions: [12] });
	});

	it("reads a list of discussion links", () => {
		const parsed = parseProposal(
			proposal({
				status: "implemented",
				discussions: [
					`https://github.com/${REPO}/discussions/12`,
					`https://github.com/${REPO}/discussions/34`,
				],
			}),
			REPO,
		);

		assert.deepEqual(parsed.discussions, [12, 34]);
	});

	it("ignores discussion links outside the front matter and in other repositories", () => {
		const parsed = parseProposal(
			proposal({
				status: "implemented",
				discussions: ["https://github.com/someone/else/discussions/5"],
			}),
			REPO,
		);

		assert.deepEqual(parsed.discussions, []);
	});

	it("returns null for a file without front matter", () => {
		assert.equal(parseProposal("# Not a proposal\n", REPO), null);
	});
});

describe("isProposalPath", () => {
	it("accepts proposal documents and rejects the index and templates", () => {
		assert.equal(isProposalPath("proposals/content-locking.md"), true);
		assert.equal(isProposalPath("proposals/README.md"), false);
		assert.equal(isProposalPath("proposals/rfc-template.md"), false);
		assert.equal(isProposalPath("proposals/nested/thing.md"), false);
		assert.equal(isProposalPath("rfcs/0001-plugin-registry.md"), false);
	});
});

describe("isDesignPullRequest", () => {
	it("recognises the design template marker or a design: title", () => {
		assert.equal(isDesignPullRequest({ title: "design: content locking", body: "" }), true);
		assert.equal(isDesignPullRequest({ title: "Locking", body: "<!-- design-pr -->\n" }), true);
		assert.equal(isDesignPullRequest({ title: "feat: content locking", body: null }), false);
	});
});

describe("statusTransition", () => {
	const url = `https://github.com/${REPO}/discussions/12`;

	it("reports acceptance without closing the Discussion", () => {
		const before = proposal({ status: "proposed", discussion: url });
		const after = proposal({ status: "accepted", discussion: url });

		assert.deepEqual(statusTransition(before, after, REPO), {
			status: "accepted",
			discussions: [12],
			close: false,
		});
	});

	it("reports acceptance for a proposal added as accepted", () => {
		const after = proposal({ status: "accepted", discussion: url });

		assert.deepEqual(statusTransition(null, after, REPO), {
			status: "accepted",
			discussions: [12],
			close: false,
		});
	});

	it("reports implementation and closes the Discussion", () => {
		const before = proposal({ status: "accepted", discussion: url });
		const after = proposal({ status: "implemented", discussion: url });

		assert.deepEqual(statusTransition(before, after, REPO), {
			status: "implemented",
			discussions: [12],
			close: true,
		});
	});

	it("does nothing when the status is unchanged", () => {
		const before = proposal({ status: "accepted", discussion: url });
		const after = proposal({ status: "accepted", discussion: url }).replace(
			"# Example",
			"# Edited",
		);

		assert.equal(statusTransition(before, after, REPO), null);
	});

	it("does nothing when an implemented proposal is edited again", () => {
		const before = proposal({ status: "implemented", discussion: url });
		const after = proposal({ status: "implemented", discussion: url }).replace(
			"# Example",
			"# Edited",
		);

		assert.equal(statusTransition(before, after, REPO), null);
	});

	it("does nothing for a proposed status or a deleted proposal", () => {
		assert.equal(
			statusTransition(null, proposal({ status: "proposed", discussion: url }), REPO),
			null,
		);
		assert.equal(
			statusTransition(proposal({ status: "accepted", discussion: url }), null, REPO),
			null,
		);
	});
});
