import { describe, expect, it } from "vitest";

import { PluginRouteError } from "emdash";

import type { RecommendationsInput } from "../schemas.js";
import { recommendationsHandler } from "./recommendations.js";

function ctx(
	method: string,
	input: RecommendationsInput = {},
): Parameters<typeof recommendationsHandler>[0] {
	return {
		request: new Request("https://example.test/api", { method }),
		input,
	} as never;
}

describe("recommendationsHandler", () => {
	it("returns stub payload on POST", async () => {
		const out = await recommendationsHandler(ctx("POST", { limit: 5 }));
		expect(out).toEqual({
			ok: true,
			strategy: "stub",
			productIds: [],
			integrationNote: expect.stringContaining("Stub route"),
		});
	});

	it("rejects non-POST", async () => {
		await expect(recommendationsHandler(ctx("GET"))).rejects.toThrow(PluginRouteError);
	});
});
