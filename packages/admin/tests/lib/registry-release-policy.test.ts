import { describe, expect, it } from "vitest";

import {
	releasePassesPolicy,
	type RegistryPackageView,
	type RegistryReleaseView,
} from "../../src/lib/api/registry.js";

const NOW = Date.parse("2026-09-12T12:00:00.000Z");
const policy = { minimumReleaseAgeSeconds: 48 * 60 * 60 };

function release(indexedAt: string): RegistryReleaseView {
	return { indexedAt } as RegistryReleaseView;
}

function pkg(history: Partial<RegistryPackageView> = {}): RegistryPackageView {
	return {
		did: "did:plc:publisher",
		slug: "gallery",
		...history,
	} as RegistryPackageView;
}

describe("registry minimum release age", () => {
	it("exempts a proven first release", () => {
		expect(
			releasePassesPolicy(
				release("2026-09-12T11:59:59.000Z"),
				pkg({ historicalReleaseCount: 1, releaseHistoryComplete: true }),
				policy,
				NOW,
			),
		).toBe(true);
	});

	it.each([
		["missing evidence", {}],
		["incomplete history", { historicalReleaseCount: 1, releaseHistoryComplete: false }],
		["an established package", { historicalReleaseCount: 2, releaseHistoryComplete: true }],
	])("holds back a new release with %s", (_name, history) => {
		expect(
			releasePassesPolicy(release("2026-09-12T11:59:59.000Z"), pkg(history), policy, NOW),
		).toBe(false);
	});

	it("accepts an established release at the exact age threshold", () => {
		expect(
			releasePassesPolicy(
				release("2026-09-10T12:00:00.000Z"),
				pkg({ historicalReleaseCount: 2, releaseHistoryComplete: true }),
				policy,
				NOW,
			),
		).toBe(true);
	});

	it("preserves explicit publisher exemptions", () => {
		expect(
			releasePassesPolicy(
				release("2026-09-12T11:59:59.000Z"),
				pkg(),
				{
					...policy,
					minimumReleaseAgeExclude: ["did:plc:publisher"],
				},
				NOW,
			),
		).toBe(true);
	});
});
