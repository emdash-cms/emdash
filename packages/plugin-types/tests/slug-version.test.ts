import { describe, expect, it } from "vitest";

import {
	deriveSlugFromId,
	isPluginSlug,
	isPluginVersion,
	PLUGIN_SLUG_MAX_LENGTH,
	PLUGIN_VERSION_MAX_LENGTH,
} from "../src/index.js";

describe("deriveSlugFromId", () => {
	it("strips a leading @ and replaces / with -", () => {
		expect(deriveSlugFromId("@emdash-cms/gallery")).toBe("emdash-cms-gallery");
	});

	it("passes through a slug-shaped id unchanged", () => {
		expect(deriveSlugFromId("gallery")).toBe("gallery");
	});

	it("does not normalise case (caller must follow up with isPluginSlug)", () => {
		// `Gallery` is not a valid slug; this helper only does the mechanical
		// scoped-name translation. Callers must reject the result if it fails
		// `isPluginSlug`.
		expect(deriveSlugFromId("@Acme/Gallery")).toBe("Acme-Gallery");
	});
});

describe("isPluginSlug", () => {
	it("accepts canonical slugs", () => {
		expect(isPluginSlug("gallery")).toBe(true);
		expect(isPluginSlug("emdash-cms-gallery")).toBe(true);
		expect(isPluginSlug("a")).toBe(true);
		expect(isPluginSlug("a1_2-3")).toBe(true);
	});

	it("rejects empty strings", () => {
		expect(isPluginSlug("")).toBe(false);
	});

	it("rejects slugs that don't start with a lowercase letter", () => {
		expect(isPluginSlug("1plugin")).toBe(false);
		expect(isPluginSlug("-plugin")).toBe(false);
		expect(isPluginSlug("_plugin")).toBe(false);
		expect(isPluginSlug("Plugin")).toBe(false);
	});

	it("rejects slugs containing forbidden characters", () => {
		expect(isPluginSlug("Plugin/Foo")).toBe(false);
		expect(isPluginSlug("foo bar")).toBe(false);
		expect(isPluginSlug("foo.bar")).toBe(false);
		expect(isPluginSlug("foo:bar")).toBe(false);
		expect(isPluginSlug("foo@bar")).toBe(false);
		expect(isPluginSlug("🦀plugin")).toBe(false);
	});

	it("rejects slugs over the max length", () => {
		expect(isPluginSlug("a".repeat(PLUGIN_SLUG_MAX_LENGTH))).toBe(true);
		expect(isPluginSlug("a".repeat(PLUGIN_SLUG_MAX_LENGTH + 1))).toBe(false);
	});
});

describe("isPluginVersion", () => {
	it("accepts canonical semver versions", () => {
		expect(isPluginVersion("1.0.0")).toBe(true);
		expect(isPluginVersion("0.0.1-alpha.0")).toBe(true);
		expect(isPluginVersion("10.20.30")).toBe(true);
	});

	it("accepts canonical pre-release identifiers per semver 2.0", () => {
		expect(isPluginVersion("1.0.0-rc.1")).toBe(true);
		expect(isPluginVersion("1.0.0-alpha")).toBe(true);
		expect(isPluginVersion("1.0.0-alpha.1")).toBe(true);
		expect(isPluginVersion("1.0.0-0.3.7")).toBe(true);
		expect(isPluginVersion("1.0.0-x.7.z.92")).toBe(true);
	});

	it("rejects build-metadata suffixes (semver `+` is disallowed)", () => {
		expect(isPluginVersion("1.0.0+build")).toBe(false);
		expect(isPluginVersion("1.0.0+build.1")).toBe(false);
		expect(isPluginVersion("1.0.0-rc.0+build")).toBe(false);
	});

	it("rejects leading-zero numeric components (per semver)", () => {
		expect(isPluginVersion("01.0.0")).toBe(false);
		expect(isPluginVersion("1.02.0")).toBe(false);
		expect(isPluginVersion("1.0.03")).toBe(false);
		// Pre-release numerics also disallow leading zeros.
		expect(isPluginVersion("1.0.0-01")).toBe(false);
		expect(isPluginVersion("1.0.0-rc.01")).toBe(false);
	});

	it("rejects malformed versions the previous loose regex accepted", () => {
		expect(isPluginVersion(".1.0.0")).toBe(false);
		expect(isPluginVersion("1.0.0-")).toBe(false);
		expect(isPluginVersion("-")).toBe(false);
		expect(isPluginVersion(".")).toBe(false);
		expect(isPluginVersion("foo")).toBe(false);
		expect(isPluginVersion("1.0")).toBe(false); // missing patch
		expect(isPluginVersion("1")).toBe(false);
		// Note: `1.0.0--rc` is technically valid semver — `-rc` is an
		// alphanumeric identifier with leading hyphen — even though it looks
		// suspicious. We accept it.
		expect(isPluginVersion("1.0.0--rc")).toBe(true);
	});

	it("rejects path-traversal and shell-control characters", () => {
		expect(isPluginVersion("../etc/passwd")).toBe(false);
		expect(isPluginVersion("1.0.0; rm -rf /")).toBe(false);
		expect(isPluginVersion("1.0.0:tag")).toBe(false);
	});

	it("rejects underscore and tilde even though atproto rkeys would accept them", () => {
		expect(isPluginVersion("1_0_0")).toBe(false);
		expect(isPluginVersion("1~0~0")).toBe(false);
	});

	it("rejects empty strings", () => {
		expect(isPluginVersion("")).toBe(false);
	});

	it("rejects versions over the max length", () => {
		// Construct exactly-max-length: "1." repeated, capped to keep semver shape.
		// Use a prerelease tail to inflate length within the format.
		const shortValid = "1.0.0";
		expect(isPluginVersion(shortValid)).toBe(true);
		// Synthesize a max-length valid: "1.0.0-" + identifier of length (max-6).
		const tail = "a".repeat(PLUGIN_VERSION_MAX_LENGTH - 6);
		const exactlyMax = `1.0.0-${tail}`;
		expect(exactlyMax.length).toBe(PLUGIN_VERSION_MAX_LENGTH);
		expect(isPluginVersion(exactlyMax)).toBe(true);
		expect(isPluginVersion(`${exactlyMax}b`)).toBe(false);
	});
});
