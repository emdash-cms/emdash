import { describe, expect, it } from "vitest";

import { getAdminPageTarget } from "../src/admin-routing.js";

describe("getAdminPageTarget", () => {
	it.each([
		[undefined, "status"],
		[{}, "status"],
		[{ type: "page_load" }, "status"],
		[{ type: "page_load", page: "/" }, "status"],
		[{ type: "page_load", page: "/settings" }, "status"],
		[{ type: "page_load", page: "/status" }, "status"],
		[{ type: "page_load", page: "widget:sync-status" }, "sync-widget"],
		[{ type: "page_load", page: "/unknown" }, null],
		[{ type: "block_action", page: "/status" }, null],
	])("maps %j to %s", (interaction, expected) => {
		expect(getAdminPageTarget(interaction)).toBe(expected);
	});
});
