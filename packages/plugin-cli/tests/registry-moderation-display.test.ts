/**
 * CLI moderation display: `search` marks blocked packages, `info` renders an
 * eligibility line instead of a raw label dump. Both derive the accepted
 * labeler policy from the aggregator's `atproto-content-labelers` response
 * header -- the CLI never configures `acceptLabelers` itself.
 */

import { runCommand } from "citty";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { infoCommand } from "../src/commands/info.js";
import { searchCommand } from "../src/commands/search.js";

const AGGREGATOR_URL = "https://registry.test";
const DID = "did:plc:abc123";
const SLUG = "gallery-plugin";
const LABELER = "did:plc:labeler-a";
const PACKAGE_URI = `at://${DID}/com.emdashcms.experimental.package.profile/${SLUG}`;
const PACKAGE_CID = "bafyreiclpjmh2e5ug4oufdmfnz4r4a6o2lrfu5hzgopzjlb3u2v5il5z4a";
const RELEASE_URI = `at://${DID}/com.emdashcms.experimental.package.release/${SLUG}:1.0.0`;
const RELEASE_CID = "bafyreig5l2zfc7l5m4zq3r6v4s2wqkd3j7yq5x7x6n2j4h5r3p6s7t2w4e";

function profile(overrides: Record<string, unknown> = {}) {
	return {
		$type: "com.emdashcms.experimental.package.profile",
		id: PACKAGE_URI,
		type: "emdash-plugin",
		license: "MIT",
		authors: [{ name: "Alice" }],
		security: [{ email: "security@example.com" }],
		slug: SLUG,
		lastUpdated: "2024-01-01T00:00:00.000Z",
		name: "Gallery Plugin",
		...overrides,
	};
}

function packageView(overrides: Record<string, unknown> = {}) {
	return {
		uri: PACKAGE_URI,
		cid: PACKAGE_CID,
		did: DID,
		slug: SLUG,
		indexedAt: "2026-07-01T00:00:00.000Z",
		profile: profile(),
		labels: [],
		...overrides,
	};
}

function label(overrides: Record<string, unknown> = {}) {
	return {
		ver: 1,
		src: LABELER,
		uri: RELEASE_URI,
		cid: RELEASE_CID,
		cts: "2026-07-10T12:00:00.000Z",
		...overrides,
	};
}

function releaseView(overrides: Record<string, unknown> = {}) {
	return {
		uri: RELEASE_URI,
		cid: RELEASE_CID,
		did: DID,
		package: SLUG,
		version: "1.0.0",
		indexedAt: "2026-07-01T00:00:00.000Z",
		labels: [],
		// `v.unknown()` in the envelope schema rejects `null`; an empty object
		// is the simplest value that passes envelope validation. The tests
		// here evaluate moderation from `labels`, not this field.
		release: {},
		...overrides,
	};
}

/**
 * Stubs `globalThis.fetch` to serve canned XRPC responses keyed by NSID, all
 * carrying the `atproto-content-labelers` response header the CLI relies on
 * (it never configures `acceptLabelers` itself -- see decision 3).
 */
function stubAggregator(responses: Record<string, unknown>) {
	const fetchMock = vi.fn(async (input: string | URL) => {
		const href = typeof input === "string" ? input : input.href;
		const nsid = new URL(href).pathname.replace(/^\/xrpc\//, "");
		const body = responses[nsid];
		if (body === undefined) {
			return new Response(JSON.stringify({ error: "NotFound", message: "no fixture" }), {
				status: 404,
				headers: { "content-type": "application/json" },
			});
		}
		return new Response(JSON.stringify(body), {
			status: 200,
			headers: {
				"content-type": "application/json",
				"atproto-content-labelers": LABELER,
			},
		});
	});
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
}

describe("CLI registry moderation display", () => {
	let logs: string[];

	beforeEach(() => {
		logs = [];
		vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
			logs.push(args.map(String).join(" "));
		});
		vi.spyOn(console, "error").mockImplementation(() => {});
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	describe("info", () => {
		it("renders a blocked eligibility line for an automated-block label on the latest release", async () => {
			stubAggregator({
				"com.emdashcms.experimental.aggregator.getPackage": packageView(),
				"com.emdashcms.experimental.aggregator.getLatestRelease": releaseView({
					labels: [label({ val: "malware" })],
				}),
			});

			await runCommand(infoCommand, {
				rawArgs: [DID, SLUG, "--registry-url", AGGREGATOR_URL],
			});

			const output = logs.join("\n");
			expect(output).toContain("Moderation:");
			expect(output).toContain("blocked");
			expect(output).toContain("malware");
			expect(output).toContain(LABELER);
			// No raw label dump.
			expect(output).not.toContain("Labels (");
		});

		it("renders a warnings line for a warning-only release", async () => {
			stubAggregator({
				"com.emdashcms.experimental.aggregator.getPackage": packageView(),
				"com.emdashcms.experimental.aggregator.getLatestRelease": releaseView({
					labels: [label({ val: "suspicious-code" })],
				}),
			});

			await runCommand(infoCommand, {
				rawArgs: [DID, SLUG, "--registry-url", AGGREGATOR_URL],
			});

			const output = logs.join("\n");
			expect(output).toContain("warnings:");
			expect(output).toContain("suspicious-code");
			expect(output).not.toContain("Moderation:");
		});

		it("renders nothing extra for a clean release with no labels", async () => {
			stubAggregator({
				"com.emdashcms.experimental.aggregator.getPackage": packageView(),
				"com.emdashcms.experimental.aggregator.getLatestRelease": releaseView(),
			});

			await runCommand(infoCommand, {
				rawArgs: [DID, SLUG, "--registry-url", AGGREGATOR_URL],
			});

			const output = logs.join("\n");
			expect(output).not.toContain("Moderation:");
			expect(output).not.toContain("warnings:");
		});

		it("falls back to package-only moderation when the package has no releases", async () => {
			stubAggregator({
				"com.emdashcms.experimental.aggregator.getPackage": packageView({
					labels: [label({ uri: PACKAGE_URI, cid: undefined, val: "!takedown" })],
				}),
				// getLatestRelease deliberately has no fixture -> 404 -> falls back.
			});

			await runCommand(infoCommand, {
				rawArgs: [DID, SLUG, "--registry-url", AGGREGATOR_URL],
			});

			const output = logs.join("\n");
			expect(output).toContain("Moderation:");
			expect(output).toContain("blocked");
		});
	});

	describe("search", () => {
		it("marks a blocked package inline and shows its blocking labels", async () => {
			stubAggregator({
				"com.emdashcms.experimental.aggregator.searchPackages": {
					packages: [
						packageView({
							labels: [label({ uri: PACKAGE_URI, cid: undefined, val: "!takedown" })],
						}),
					],
				},
			});

			await runCommand(searchCommand, {
				rawArgs: ["gallery", "--registry-url", AGGREGATOR_URL],
			});

			const output = logs.join("\n");
			expect(output).toContain("[blocked]");
			expect(output).toContain("blocked: !takedown");
		});

		it("does not mark a clean package", async () => {
			stubAggregator({
				"com.emdashcms.experimental.aggregator.searchPackages": {
					packages: [packageView()],
				},
			});

			await runCommand(searchCommand, {
				rawArgs: ["gallery", "--registry-url", AGGREGATOR_URL],
			});

			const output = logs.join("\n");
			expect(output).not.toContain("[blocked]");
		});
	});
});
