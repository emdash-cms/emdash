import { describe, expect, it } from "vitest";

import { PluginRouteError } from "emdash";

import { requirePost } from "./require-post.js";

describe("requirePost", () => {
	it("allows POST", () => {
		expect(() =>
			requirePost({
				request: new Request("https://x.test/a", { method: "POST" }),
			} as never),
		).not.toThrow();
	});

	it("rejects GET with 405", () => {
		expect(() =>
			requirePost({
				request: new Request("https://x.test/a", { method: "GET" }),
			} as never),
		).toThrow(PluginRouteError);

		try {
			requirePost({
				request: new Request("https://x.test/a", { method: "GET" }),
			} as never);
		} catch (e) {
			expect(e).toBeInstanceOf(PluginRouteError);
			expect((e as PluginRouteError).status).toBe(405);
		}
	});
});
