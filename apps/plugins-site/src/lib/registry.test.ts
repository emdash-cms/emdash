import { CURRENT_PLUGIN_CAPABILITIES } from "@emdash-cms/plugin-types";
import { registryLoader } from "@emdash-cms/registry-loader";
import { describe, expect, it } from "vitest";

import {
	isLiveEntryNotFoundError,
	isNewPlugin,
	isOfficialPublisher,
	isRegistryRequestRejected,
	permissionCopy,
	permissionCountLabel,
	pluginPath,
	publisherHandle,
	publisherPath,
	relativeUpdated,
	renderRegistryMarkdown,
	requestedPermissions,
	safeExternalUrl,
} from "./registry.js";

describe("registry presentation boundaries", () => {
	it("allows HTTPS URLs without credentials", () => {
		expect(safeExternalUrl("https://example.com/plugin")).toBe("https://example.com/plugin");
		expect(safeExternalUrl("http://example.com/plugin")).toBeUndefined();
		expect(safeExternalUrl("https://user:secret@example.com/plugin")).toBeUndefined();
	});

	it("uses the official publisher handle when the aggregator omits it", () => {
		expect(
			publisherHandle({
				did: "did:plc:xyraubanwc5fwemkduw3upi6",
				handle: undefined,
			}),
		).toBe("plugins.emdashcms.com");
	});

	it("builds public URLs from a publisher handle instead of its DID", () => {
		const plugin = {
			did: "did:plc:publisher",
			handle: "plugins.example.com",
			slug: "contact-form",
		} as const;

		expect(publisherPath(plugin)).toBe("/plugins/@plugins.example.com");
		expect(pluginPath(plugin)).toBe("/plugins/@plugins.example.com/contact-form");
	});

	it("sanitizes publisher-authored Markdown", () => {
		const html = renderRegistryMarkdown(
			"[Safe](https://example.com) [Relative](/admin) [Script](javascript:alert(1)) <script>alert(1)</script>",
		);

		expect(html).toContain('href="https://example.com/"');
		expect(html).toContain('rel="noreferrer noopener"');
		expect(html).not.toContain('href="/admin"');
		expect(html).not.toContain("javascript:");
		expect(html).not.toContain("<script");
	});

	it("tells a rejected registry request apart from an unreachable registry", async () => {
		const answering = (status: number) =>
			registryLoader({
				fetch: async () => Response.json({ error: "Example", message: "Example" }, { status }),
			});
		const entryError = async (loader: ReturnType<typeof registryLoader>) => {
			const result = await loader.loadEntry({
				collection: "plugins",
				filter: { publisher: "@example.com", slug: "search-ping" },
			});
			return result && "error" in result ? result.error : undefined;
		};
		// Longer than the lexicon allows, so the client refuses to send it at all.
		const overLongQuery = await answering(502).loadCollection({
			collection: "plugins",
			filter: { q: "a".repeat(257) },
		});
		const offline = registryLoader({
			fetch: async () => {
				throw new TypeError("fetch failed");
			},
		});

		expect(isRegistryRequestRejected(await entryError(answering(400)))).toBe(true);
		expect("error" in overLongQuery && isRegistryRequestRejected(overLongQuery.error)).toBe(true);
		expect(isRegistryRequestRejected(await entryError(answering(502)))).toBe(false);
		expect(isRegistryRequestRejected(await entryError(offline))).toBe(false);
	});

	it("nests publisher headings under the section heading from their shallowest level", () => {
		expect(renderRegistryMarkdown("# One\n\n## Two\n\n### Three")).toBe(
			"<h3>One</h3>\n<h4>Two</h4>\n<h4>Three</h4>\n",
		);
		expect(renderRegistryMarkdown("### Install\n\n#### Requirements")).toBe(
			"<h3>Install</h3>\n<h4>Requirements</h4>\n",
		);
		expect(renderRegistryMarkdown("<!-- <h1>Old title</h1> -->\n\n### Install")).toContain(
			"<h3>Install</h3>",
		);
		expect(renderRegistryMarkdown("<h2/>Usage")).toContain("<h3>Usage");
	});

	it("extracts requested permissions from the validated release extension", () => {
		const summary = requestedPermissions({
			latestRelease: {
				release: {
					extensions: {
						"com.emdashcms.experimental.package.releaseExtension": {
							$type: "com.emdashcms.experimental.package.releaseExtension",
							declaredAccess: {
								content: { read: {} },
								network: { request: { allowedHosts: ["api.example.com"] } },
							},
						},
					},
				},
			},
		} as never);

		expect(summary).toEqual({
			declared: true,
			capabilities: ["content:read", "network:request"],
			allowedHosts: ["api.example.com"],
		});
	});

	it("presents unrestricted network access once and makes its scope explicit", () => {
		const summary = requestedPermissions({
			latestRelease: {
				release: {
					extensions: {
						"com.emdashcms.experimental.package.releaseExtension": {
							$type: "com.emdashcms.experimental.package.releaseExtension",
							declaredAccess: { network: { request: {} } },
						},
					},
				},
			},
		} as never);

		expect(summary.capabilities).toEqual(["network:request:unrestricted"]);
		expect(permissionCopy(summary.capabilities[0]!).label).toBe(
			"Make unrestricted network requests",
		);
	});

	it("describes every current capability in plain language", () => {
		const unlabelled = CURRENT_PLUGIN_CAPABILITIES.filter(
			(capability) => permissionCopy(capability).label === capability,
		);

		expect(unlabelled).toEqual([]);
	});

	it("distinguishes a missing declaration from an empty one", () => {
		expect(requestedPermissions({} as never)).toEqual({
			declared: false,
			capabilities: [],
			allowedHosts: [],
		});
	});

	it("recognizes missing live entries without masking upstream failures", () => {
		const notFound = new Error("missing");
		notFound.name = "LiveEntryNotFoundError";

		expect(isLiveEntryNotFoundError(notFound)).toBe(true);
		expect(isLiveEntryNotFoundError(new Error("upstream unavailable"))).toBe(false);
	});
});

describe("plugin card signals", () => {
	it("calls a plugin new only when a complete history proves one recent release", () => {
		const now = new Date("2026-10-15T12:00:00Z");
		const indexedAt = "2026-10-10T12:00:00Z";
		const firstRelease = { historicalReleaseCount: 1, releaseHistoryComplete: true, indexedAt };

		expect(isNewPlugin(firstRelease, now)).toBe(true);
		expect(isNewPlugin({ ...firstRelease, releaseHistoryComplete: false }, now)).toBe(false);
		expect(isNewPlugin({ historicalReleaseCount: 1, indexedAt }, now)).toBe(false);
		expect(isNewPlugin({ ...firstRelease, historicalReleaseCount: 2 }, now)).toBe(false);
		expect(isNewPlugin({ ...firstRelease, indexedAt: "2026-09-01T12:00:00Z" }, now)).toBe(false);
	});

	it("marks the official publisher by DID, not by a handle another account could report", () => {
		expect(isOfficialPublisher({ did: "did:plc:xyraubanwc5fwemkduw3upi6" })).toBe(true);
		expect(isOfficialPublisher({ did: "did:plc:someone-else" })).toBe(false);
		const spoofed = { did: "did:plc:someone-else", handle: "plugins.emdashcms.com" } as const;
		expect(isOfficialPublisher(spoofed)).toBe(false);
	});

	it("counts permissions in words", () => {
		expect(permissionCountLabel(0)).toBe("No permissions");
		expect(permissionCountLabel(1)).toBe("1 permission");
		expect(permissionCountLabel(4)).toBe("4 permissions");
	});

	it("shows recent updates relative to now and older ones as a date", () => {
		const now = new Date("2026-10-15T12:00:00Z");
		expect(relativeUpdated("2026-10-15T11:59:50Z", now)).toBe("1 min. ago");
		expect(relativeUpdated("2026-10-15T07:00:00Z", now)).toBe("5 hr. ago");
		expect(relativeUpdated("2026-10-14T08:00:00Z", now)).toBe("yesterday");
		expect(relativeUpdated("2026-10-10T12:00:00Z", now)).toBe("5 days ago");
		expect(relativeUpdated("2026-10-01T12:00:00Z", now)).toBe("Oct 1");
		expect(relativeUpdated("2025-12-24T12:00:00Z", now)).toBe("Dec 24, 2025");
		expect(relativeUpdated("2026-11-01T12:00:00Z", now)).toBe("Nov 1");
		expect(relativeUpdated("not a date", now)).toBeUndefined();
	});
});
