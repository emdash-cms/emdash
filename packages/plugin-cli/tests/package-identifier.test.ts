import { describe, expect, it } from "vitest";

import {
	formatPackageIdentifier,
	formatPackageReleaseIdentifier,
	formatPublisherIdentifier,
	pluginPageUrl,
} from "../src/package-identifier.js";

describe("registry package identifiers", () => {
	it("formats a publisher handle and package slug", () => {
		expect(formatPackageIdentifier("plugins.emdashcms.com", "audit-log")).toBe(
			"@plugins.emdashcms.com/audit-log",
		);
	});

	it("does not add an at sign to DIDs or duplicate an existing one", () => {
		expect(formatPublisherIdentifier("did:plc:publisher")).toBe("did:plc:publisher");
		expect(formatPublisherIdentifier("@plugins.emdashcms.com")).toBe("@plugins.emdashcms.com");
	});

	it("appends a release version to the complete package identifier", () => {
		expect(formatPackageReleaseIdentifier("plugins.emdashcms.com", "audit-log", "0.2.2")).toBe(
			"@plugins.emdashcms.com/audit-log@0.2.2",
		);
	});

	it("builds the canonical public plugin page URL", () => {
		expect(pluginPageUrl("plugins.emdashcms.com", "audit-log")).toBe(
			"https://plugins.emdashcms.com/plugins/@plugins.emdashcms.com/audit-log",
		);
	});
});
