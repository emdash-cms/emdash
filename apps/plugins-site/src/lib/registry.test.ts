import { describe, expect, it } from "vitest";

import {
	isLiveEntryNotFoundError,
	permissionCopy,
	pluginPath,
	publisherHandle,
	publisherPath,
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
