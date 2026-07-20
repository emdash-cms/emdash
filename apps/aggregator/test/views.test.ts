/**
 * View mapper unit tests.
 *
 * `capLabels` is exercised through `releaseView` (its only caller shape):
 * the lexicon caps a view's `labels` at `LABELS_MAX_LENGTH`, and the trim
 * must be enforcement-preserving — a plain slice in hydration order can drop
 * the only hard block, and a client evaluating the truncated view would then
 * treat the release as installable.
 */

import { describe, expect, it } from "vitest";

import { LABELS_MAX_LENGTH, type LabelView } from "../src/routes/xrpc/label-enforcement.js";
import { type ReleaseRow, releaseView } from "../src/routes/xrpc/views.js";

const NOW = "2026-05-10T12:00:00.000Z";

function makeReleaseRow(): ReleaseRow {
	return {
		did: "did:plc:abc",
		package: "demo",
		version: "1.0.0",
		rkey: "demo:1.0.0",
		artifacts: JSON.stringify({ package: { url: "https://x.test/d.tgz", checksum: "bsha256" } }),
		requires: null,
		suggests: null,
		emdash_extension: JSON.stringify({ declaredAccess: {} }),
		repo_url: null,
		signature_metadata: JSON.stringify({ cid: "bafrel" }),
		verified_at: NOW,
		indexed_at: NOW,
	};
}

function label(val: string, index: number): LabelView {
	return { src: "did:web:labeler.example", uri: `at://did:plc:abc/x/${index}`, val, cts: NOW };
}

describe("releaseView label cap (enforcement-preserving)", () => {
	it("returns labels unchanged when at or under the cap", () => {
		const labels = [label("low-quality", 0), label("malware", 1), label("suspicious-code", 2)];
		const view = releaseView(makeReleaseRow(), labels);
		expect(view.labels).toEqual(labels);
	});

	it("keeps the sole hard block even when it sorts last in hydration order", () => {
		const labels: LabelView[] = [];
		for (let i = 0; i < LABELS_MAX_LENGTH; i++) labels.push(label("low-quality", i));
		labels.push(label("malware", LABELS_MAX_LENGTH));
		expect(labels).toHaveLength(LABELS_MAX_LENGTH + 1);

		const view = releaseView(makeReleaseRow(), labels);
		expect(view.labels).toHaveLength(LABELS_MAX_LENGTH);
		expect(view.labels?.some((l) => l.val === "malware")).toBe(true);
	});

	it("keeps an assessment-state label above informational labels when over the cap", () => {
		const labels: LabelView[] = [];
		for (let i = 0; i < LABELS_MAX_LENGTH; i++) labels.push(label("low-quality", i));
		labels.push(label("assessment-pending", LABELS_MAX_LENGTH));

		const view = releaseView(makeReleaseRow(), labels);
		expect(view.labels).toHaveLength(LABELS_MAX_LENGTH);
		expect(view.labels?.some((l) => l.val === "assessment-pending")).toBe(true);
	});
});
