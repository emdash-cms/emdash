import { defineCommand, renderUsage } from "citty";
import { describe, expect, it } from "vitest";

import { pdsConformanceCommand, scopeDenialExpectation } from "../src/commands/pds-conformance.js";

describe("internal conformance command", () => {
	it("remains executable without appearing in root help", async () => {
		const root = defineCommand({
			meta: { name: "emdash-plugin" },
			subCommands: {
				visible: defineCommand({ meta: { name: "visible", description: "Visible command" } }),
				"pds-conformance": pdsConformanceCommand,
			},
		});
		const usage = await renderUsage(root);

		expect(usage).toContain("visible");
		expect(usage).not.toContain("pds-conformance");
	});

	it.each([
		["bluesky", { status: 403, error: "ScopeMissingError" }],
		["cirrus", { status: 403, error: "InsufficientScope" }],
	])("uses the recorded %s scope-denial semantics", (provider, expected) => {
		expect(scopeDenialExpectation(provider)).toEqual(expected);
	});

	it("rejects providers without recorded scope-denial semantics", () => {
		expect(() => scopeDenialExpectation("unknown")).toThrow("bluesky or cirrus");
	});
});
