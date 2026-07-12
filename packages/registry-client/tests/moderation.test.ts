import { describe, expect, it, vi } from "vitest";

import type { ValidatedPackageView, ValidatedReleaseView } from "../src/discovery/index.js";
import {
	evaluateReleaseViews,
	resolveAcceptedPolicy,
	InvalidAcceptLabelersHeaderError,
} from "../src/index.js";

const labelerA = "did:plc:labeler-a";
const publisherDid = "did:plc:ewvi7nxzyoun6zhxrhs64oiz";
const packageUri = `at://${publisherDid}/com.emdashcms.experimental.package.profile/gallery-plugin`;
// Real, decodable DASL CIDs -- parseModerationLabel structurally validates
// each label's `cid`, unlike the rest of these fixtures' identifiers.
const packageCid = "bafyreiclpjmh2e5ug4oufdmfnz4r4a6o2lrfu5hzgopzjlb3u2v5il5z4a";
const releaseUri = `at://${publisherDid}/com.emdashcms.experimental.package.release/gallery-plugin:1.0.0`;
const releaseCid = "bafyreig5l2zfc7l5m4zq3r6v4s2wqkd3j7yq5x7x6n2j4h5r3p6s7t2w4e";
const staleReleaseCid = "bafyreigh2akiscaildc4mscz4uzpcbap5jxg26eecmrf6cmnvkzkjmoixa";

function packageView(overrides: Partial<ValidatedPackageView> = {}): ValidatedPackageView {
	return {
		uri: packageUri,
		cid: packageCid,
		did: publisherDid,
		slug: "gallery-plugin",
		indexedAt: "2026-07-10T00:00:00.000Z",
		profile: null,
		...overrides,
	};
}

function releaseView(overrides: Partial<ValidatedReleaseView> = {}): ValidatedReleaseView {
	return {
		uri: releaseUri,
		cid: releaseCid,
		did: publisherDid,
		package: "gallery-plugin",
		version: "1.0.0",
		indexedAt: "2026-07-10T00:00:00.000Z",
		release: null,
		...overrides,
	};
}

function label(overrides: Record<string, unknown>) {
	return {
		ver: 1,
		src: labelerA,
		uri: releaseUri,
		cid: releaseCid,
		cts: "2026-07-10T12:00:00.000Z",
		...overrides,
	};
}

describe("evaluateReleaseViews", () => {
	it("evaluates a clean release as blocked (no assessment pass)", () => {
		const result = evaluateReleaseViews({
			packageView: packageView(),
			releaseView: releaseView(),
			publisherDid,
			accepted: [{ did: labelerA, redact: false }],
			evaluatedAt: new Date("2026-07-10T13:00:00.000Z"),
		});
		expect(result.eligibility).toBe("blocked");
		expect(result.reasonCodes).toEqual(["missing-assessment-pass"]);
	});

	it("evaluates a release-scope pass label as eligible", () => {
		const result = evaluateReleaseViews({
			packageView: packageView(),
			releaseView: releaseView({ labels: [label({ val: "assessment-passed" })] }),
			publisherDid,
			accepted: [{ did: labelerA, redact: false }],
			evaluatedAt: new Date("2026-07-10T13:00:00.000Z"),
		});
		expect(result.eligibility).toBe("eligible");
	});

	it("cascades a package-scope takedown label from the package view", () => {
		const result = evaluateReleaseViews({
			packageView: packageView({
				labels: [
					label({ uri: packageUri, cid: undefined, val: "!takedown" }),
					label({ val: "assessment-passed" }),
				],
			}),
			releaseView: releaseView({ labels: [label({ val: "assessment-passed" })] }),
			publisherDid,
			accepted: [{ did: labelerA, redact: false }],
			evaluatedAt: new Date("2026-07-10T13:00:00.000Z"),
		});
		expect(result.eligibility).toBe("blocked");
		expect(result.blockingLabels).toContain("!takedown");
	});

	it("cascades a publisher-scope block from either view's hydrated labels", () => {
		const result = evaluateReleaseViews({
			packageView: packageView({
				labels: [label({ uri: publisherDid, cid: undefined, val: "publisher-compromised" })],
			}),
			releaseView: releaseView({ labels: [label({ val: "assessment-passed" })] }),
			publisherDid,
			accepted: [{ did: labelerA, redact: false }],
			evaluatedAt: new Date("2026-07-10T13:00:00.000Z"),
		});
		expect(result.eligibility).toBe("blocked");
		expect(result.reasonCodes).toContain("manual-block");
	});

	it("ignores a CID-bound label that no longer matches the current release CID", () => {
		const result = evaluateReleaseViews({
			packageView: packageView(),
			releaseView: releaseView({
				labels: [
					label({ val: "assessment-passed" }),
					label({ val: "malware", cid: staleReleaseCid }),
				],
			}),
			publisherDid,
			accepted: [{ did: labelerA, redact: false }],
			evaluatedAt: new Date("2026-07-10T13:00:00.000Z"),
		});
		expect(result.eligibility).toBe("eligible");
		expect(result.blockingLabels).toEqual([]);
	});

	it("skips a structurally invalid label and logs a warning instead of throwing", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const result = evaluateReleaseViews({
				packageView: packageView(),
				releaseView: releaseView({
					labels: [
						label({ val: "assessment-passed" }),
						// malformed uri: not an at:// URI or DID.
						label({ val: "malware", uri: "not a uri", cid: undefined }),
					],
				}),
				publisherDid,
				accepted: [{ did: labelerA, redact: false }],
				evaluatedAt: new Date("2026-07-10T13:00:00.000Z"),
			});
			expect(result.eligibility).toBe("eligible");
			expect(warn).toHaveBeenCalledTimes(1);
			expect(warn.mock.calls[0]?.[0]).toContain("skipping structurally invalid moderation label");
		} finally {
			warn.mockRestore();
		}
	});
});

describe("resolveAcceptedPolicy", () => {
	it("uses the response header when present and non-empty", () => {
		expect(
			resolveAcceptedPolicy({
				configuredAcceptLabelers: "did:plc:configured",
				contentLabelersHeader: "did:plc:from-header;redact",
			}),
		).toEqual([{ did: "did:plc:from-header", redact: true }]);
	});

	it("falls back to the configured value when the response header is absent", () => {
		expect(resolveAcceptedPolicy({ configuredAcceptLabelers: "did:plc:configured" })).toEqual([
			{ did: "did:plc:configured", redact: false },
		]);
	});

	it("falls back to the configured value when the response header is empty", () => {
		expect(
			resolveAcceptedPolicy({
				configuredAcceptLabelers: "did:plc:configured",
				contentLabelersHeader: "",
			}),
		).toEqual([{ did: "did:plc:configured", redact: false }]);
	});

	it("returns no client-side enforcement when neither source is set", () => {
		expect(resolveAcceptedPolicy({})).toEqual([]);
	});

	it("warns and falls through to the configured value when the response header is malformed", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const result = resolveAcceptedPolicy({
				configuredAcceptLabelers: "did:plc:configured",
				contentLabelersHeader: "not a valid header !!!",
			});
			expect(result).toEqual([{ did: "did:plc:configured", redact: false }]);
			expect(warn).toHaveBeenCalledTimes(1);
			expect(warn.mock.calls[0]?.[0]).toContain(
				"ignoring malformed atproto-content-labelers response header",
			);
		} finally {
			warn.mockRestore();
		}
	});

	it("throws when the configured value is malformed", () => {
		expect(() =>
			resolveAcceptedPolicy({ configuredAcceptLabelers: "not a valid header !!!" }),
		).toThrow(InvalidAcceptLabelersHeaderError);
	});
});
