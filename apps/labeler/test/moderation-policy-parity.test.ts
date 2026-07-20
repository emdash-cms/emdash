import {
	AUTOMATED_BLOCKS,
	PACKAGE_SCOPE_BLOCK_VALUES,
	RELEASE_BLOCK_VALUES,
	WARNINGS,
} from "@emdash-cms/registry-moderation";
import { describe, expect, it } from "vitest";

import { MODERATION_POLICY } from "../src/policy.js";

/**
 * Dual-source parity: label classification lives on BOTH sides of the
 * labeler/registry boundary -- the labeler issues labels per this policy
 * fixture's `category`/`officialEffect`, and `@emdash-cms/registry-moderation`
 * enforces them via its own hardcoded sets. A value the labeler can issue as a
 * block but the package omits from `AUTOMATED_BLOCKS` is issued yet never
 * enforced -- a policy-blocked release stays installable (the miss that let
 * hateful-imagery/explicit-imagery/graphic-violence through, after the earlier
 * block/warn reclassification miss). These assertions fail the moment the two
 * sources drift so a third miss can't merge.
 */
describe("moderation policy <-> registry-moderation classification parity", () => {
	function sorted(values: Iterable<string>): string[] {
		return [...values].toSorted();
	}

	const fixtureAutomatedBlocks = sorted(
		MODERATION_POLICY.labels
			.filter((label) => label.category === "automated-block")
			.map((label) => label.value),
	);
	const fixtureWarnEffect = sorted(
		MODERATION_POLICY.labels
			.filter((label) => label.officialEffect === "warn")
			.map((label) => label.value),
	);

	it("enforces exactly the fixture's automated-block category as AUTOMATED_BLOCKS", () => {
		expect(sorted(AUTOMATED_BLOCKS)).toEqual(fixtureAutomatedBlocks);
	});

	it("routes every automated-block value into the release hard-block set", () => {
		for (const value of fixtureAutomatedBlocks) {
			expect(RELEASE_BLOCK_VALUES).toContain(value);
		}
	});

	// Automated blocks are not the only enforced blocks: the manual-system
	// labels `security-yanked` and `publisher-compromised` also carry
	// `officialEffect: "block"` but are enforced only via the hardcoded
	// RELEASE_BLOCK_VALUES / PACKAGE_SCOPE_BLOCK_VALUES, which the assertions
	// above never touch. Guard the whole block vocabulary so a future
	// `officialEffect: "block"` fixture label can't be issued yet silently
	// left unenforced.
	it("enforces every fixture block-effect label at release or package/publisher scope", () => {
		const enforcedBlocks = new Set([...RELEASE_BLOCK_VALUES, ...PACKAGE_SCOPE_BLOCK_VALUES]);
		const fixtureBlockEffect = MODERATION_POLICY.labels
			.filter((label) => label.officialEffect === "block")
			.map((label) => label.value);
		for (const value of fixtureBlockEffect) {
			expect(enforcedBlocks.has(value)).toBe(true);
		}
	});

	// The fixture's warn-effect set, not its `warning` *category*: the package's
	// WARNINGS deliberately includes `package-disputed` (a `manual-system` label
	// whose officialEffect is `warn`), so category-equality would never hold --
	// the officialEffect correspondence is the invariant.
	it("classifies exactly the fixture's warn-effect labels as WARNINGS", () => {
		expect(sorted(WARNINGS)).toEqual(fixtureWarnEffect);
	});

	it("never classifies a value as both a block and a warning", () => {
		for (const value of AUTOMATED_BLOCKS) {
			expect(WARNINGS.has(value)).toBe(false);
		}
	});
});
