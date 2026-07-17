/**
 * Release resolution: mapping an assessment to an `AcquisitionTarget` over the
 * aggregator reads. A fake `ReleaseReader` returns canned views — no binding,
 * no network. Drift detection is not asserted here (the target only carries the
 * pinned coordinates; `acquireArtifact` raises the finding), but the pinned
 * fields must be threaded so that check can fire.
 */

import type { AggregatorDefs, AggregatorListReleases } from "@emdash-cms/registry-lexicons";
import { describe, expect, it } from "vitest";

import { StageTransientError } from "../src/assessment-orchestrator.js";
import type { Assessment } from "../src/assessment-store.js";
import {
	createReleaseResolver,
	MAX_RELEASE_DESCRIPTION_CHARS,
	type ReleaseReader,
} from "../src/release-resolution.js";

const PUBLISHER_DID = "did:plc:publisher000000000000000000";
const RELEASE_URI = `at://${PUBLISHER_DID}/com.emdashcms.experimental.package.release/test-plugin:1.0.0`;
const PROFILE_URI = `at://${PUBLISHER_DID}/com.emdashcms.experimental.package.profile/test-plugin`;

function assessment(overrides: Partial<Assessment> = {}): Assessment {
	return {
		id: "asmt_0000000000000000000000000000",
		runKey: "run_0000000000000000000000000000",
		uri: RELEASE_URI,
		cid: "bafyPinnedCid",
		artifactId: null,
		artifactChecksum: null,
		state: "running",
		trigger: "initial",
		triggerId: "trg",
		policyVersion: "1",
		modelId: null,
		promptHash: null,
		publicSummary: null,
		coverageJson: "{}",
		supersedesAssessmentId: null,
		startedAt: null,
		completedAt: null,
		createdAt: "2026-07-17T00:00:00.000Z",
		...overrides,
	};
}

function releaseView(overrides: {
	cid: string;
	url?: string;
	checksum?: string;
	artifactId?: string;
	pkg?: string;
	version?: string;
}): AggregatorDefs.ReleaseView {
	const artifact: Record<string, unknown> = {
		url: overrides.url ?? "https://cdn.example.test/plugin.tgz",
		checksum: overrides.checksum ?? "bDeclaredChecksum",
	};
	if (overrides.artifactId !== undefined) artifact["id"] = overrides.artifactId;
	return {
		cid: overrides.cid,
		did: PUBLISHER_DID,
		indexedAt: "2026-07-17T00:00:00.000Z",
		package: overrides.pkg ?? "test-plugin",
		version: overrides.version ?? "1.0.0",
		uri: RELEASE_URI,
		release: {
			$type: "com.emdashcms.experimental.package.release",
			package: overrides.pkg ?? "test-plugin",
			version: overrides.version ?? "1.0.0",
			artifacts: { package: artifact },
		},
	} as AggregatorDefs.ReleaseView;
}

function packageView(description?: string): AggregatorDefs.PackageView {
	return {
		cid: "bafyProfileCid",
		did: PUBLISHER_DID,
		indexedAt: "2026-07-17T00:00:00.000Z",
		slug: "test-plugin",
		uri: PROFILE_URI,
		profile: {
			$type: "com.emdashcms.experimental.package.profile",
			...(description !== undefined ? { description } : {}),
		},
	} as AggregatorDefs.PackageView;
}

function reader(overrides: Partial<ReleaseReader> = {}): ReleaseReader {
	return {
		getLatestRelease: overrides.getLatestRelease ?? (async () => null),
		listReleases: overrides.listReleases ?? (async () => ({ releases: [] })),
		getPackage: overrides.getPackage ?? (async () => null),
	};
}

describe("createReleaseResolver", () => {
	it("uses the latest release when its CID matches the pinned CID", async () => {
		const resolve = createReleaseResolver(
			reader({
				getLatestRelease: async () =>
					releaseView({
						cid: "bafyPinnedCid",
						url: "https://cdn.example.test/pkg.tgz",
						artifactId: "pkg-1",
					}),
			}),
		);

		const targetResult = await resolve(
			assessment({ artifactChecksum: "bDeclaredChecksum", artifactId: "pkg-1" }),
		);

		expect(targetResult).toMatchObject({
			url: "https://cdn.example.test/pkg.tgz",
			checksum: "bDeclaredChecksum",
			slug: "test-plugin",
			version: "1.0.0",
			artifactId: "pkg-1",
			pinnedChecksum: "bDeclaredChecksum",
			pinnedArtifactId: "pkg-1",
		});
	});

	it("scans listReleases for the pinned CID when the latest release differs", async () => {
		let listCalls = 0;
		const resolve = createReleaseResolver(
			reader({
				getLatestRelease: async () => releaseView({ cid: "bafyNewerCid" }),
				listReleases: async (): Promise<AggregatorListReleases.$output> => {
					listCalls += 1;
					return {
						releases: [releaseView({ cid: "bafyNewerCid" }), releaseView({ cid: "bafyPinnedCid" })],
					};
				},
			}),
		);

		const targetResult = await resolve(assessment());

		expect(listCalls).toBe(1);
		expect(targetResult.checksum).toBe("bDeclaredChecksum");
	});

	it("throws a transient error when the pinned CID is not indexed (aggregator lag)", async () => {
		const resolve = createReleaseResolver(reader({ getLatestRelease: async () => null }));
		await expect(resolve(assessment())).rejects.toBeInstanceOf(StageTransientError);
	});

	it("throws a transient error when the listReleases scan exhausts without the pinned CID", async () => {
		const resolve = createReleaseResolver(
			reader({
				getLatestRelease: async () => releaseView({ cid: "bafyNewerCid" }),
				listReleases: async () => ({ releases: [releaseView({ cid: "bafyOtherCid" })] }),
			}),
		);
		await expect(resolve(assessment())).rejects.toBeInstanceOf(StageTransientError);
	});

	it("threads the package-profile description into the target", async () => {
		const resolve = createReleaseResolver(
			reader({
				getLatestRelease: async () => releaseView({ cid: "bafyPinnedCid" }),
				getPackage: async () => packageView("A friendly plugin that does one thing well."),
			}),
		);

		const targetResult = await resolve(assessment());

		expect(targetResult.description).toBe("A friendly plugin that does one thing well.");
	});

	it("truncates an over-cap publisher description to the ingestion cap", async () => {
		const resolve = createReleaseResolver(
			reader({
				getLatestRelease: async () => releaseView({ cid: "bafyPinnedCid" }),
				getPackage: async () => packageView("x".repeat(MAX_RELEASE_DESCRIPTION_CHARS * 4)),
			}),
		);

		const targetResult = await resolve(assessment());

		expect(targetResult.description).toHaveLength(MAX_RELEASE_DESCRIPTION_CHARS);
		expect(targetResult.description?.endsWith("…")).toBe(true);
	});

	it("leaves the description absent when the profile fetch fails, still resolving the artifact", async () => {
		const resolve = createReleaseResolver(
			reader({
				getLatestRelease: async () => releaseView({ cid: "bafyPinnedCid" }),
				getPackage: async () => {
					throw new Error("aggregator profile read failed");
				},
			}),
		);

		const targetResult = await resolve(assessment());

		expect(targetResult.description).toBeUndefined();
		expect(targetResult.url).toBe("https://cdn.example.test/plugin.tgz");
	});

	it("throws a transient error when the release view has no package artifact", async () => {
		const resolve = createReleaseResolver(
			reader({
				getLatestRelease: async () =>
					({
						cid: "bafyPinnedCid",
						did: PUBLISHER_DID,
						indexedAt: "2026-07-17T00:00:00.000Z",
						package: "test-plugin",
						version: "1.0.0",
						uri: RELEASE_URI,
						release: { $type: "com.emdashcms.experimental.package.release", artifacts: {} },
					}) as AggregatorDefs.ReleaseView,
			}),
		);
		await expect(resolve(assessment())).rejects.toBeInstanceOf(StageTransientError);
	});

	it("throws a transient error when the release record key has no package slug", async () => {
		const resolve = createReleaseResolver(
			reader({ getLatestRelease: async () => releaseView({ cid: "bafyPinnedCid" }) }),
		);
		const badUri = `at://${PUBLISHER_DID}/com.emdashcms.experimental.package.release/no-separator`;
		await expect(resolve(assessment({ uri: badUri }))).rejects.toBeInstanceOf(StageTransientError);
	});
});
