import { CAPABILITY_DESCRIPTIONS } from "@emdash-cms/plugin-types";
import { describe, expect, it } from "vitest";

import { capabilityGroup } from "./capabilities.js";

describe("capabilityGroup", () => {
	it("gives every known capability a specific group", () => {
		const ungrouped = Object.keys(CAPABILITY_DESCRIPTIONS).filter(
			(capability) => capabilityGroup(capability) === "other",
		);
		expect(ungrouped).toEqual([]);
	});

	it("groups capabilities by what they touch, not by their namespace alone", () => {
		expect(capabilityGroup("content:revisions:read")).toBe("content");
		expect(capabilityGroup("admin.editor-draft:patch")).toBe("content");
		expect(capabilityGroup("hooks.content-policy:register")).toBe("content");
		expect(capabilityGroup("hooks.email-events:register")).toBe("email");
		expect(capabilityGroup("hooks.email-transport:register")).toBe("email");
		expect(capabilityGroup("hooks.page-fragments:register")).toBe("page");
		expect(capabilityGroup("network:request:unrestricted")).toBe("network");
		expect(capabilityGroup("media:bytes:read")).toBe("media");
	});

	it("resolves legacy capability names", () => {
		expect(capabilityGroup("network:fetch")).toBe("network");
		expect(capabilityGroup("read:content")).toBe("content");
		expect(capabilityGroup("write:media")).toBe("media");
		expect(capabilityGroup("read:users")).toBe("users");
		expect(capabilityGroup("email:intercept")).toBe("email");
		expect(capabilityGroup("page:inject")).toBe("page");
	});

	it("falls back to other for strings outside the vocabulary", () => {
		expect(capabilityGroup("")).toBe("other");
		expect(capabilityGroup("telemetry:send")).toBe("other");
		expect(capabilityGroup("hooks.cron:register")).toBe("other");
		expect(capabilityGroup("constructor:read")).toBe("other");
		expect(capabilityGroup("hooks.toString:register")).toBe("other");
		expect(capabilityGroup("content")).toBe("other");
	});
});
