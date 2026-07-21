import { describe, expect, it } from "vitest";

import { createRedirectBody } from "../../../src/api/schemas/redirects.js";

describe("createRedirectBody", () => {
	it("accepts a 301 redirect with a destination", () => {
		const result = createRedirectBody.safeParse({
			source: "/old",
			destination: "/new",
			type: 301,
		});
		expect(result.success).toBe(true);
	});

	it("rejects a redirect type (301) without a destination", () => {
		const result = createRedirectBody.safeParse({ source: "/old", type: 301 });
		expect(result.success).toBe(false);
	});

	it("accepts a 410 Gone rule without a destination", () => {
		const result = createRedirectBody.safeParse({ source: "/deleted", type: 410 });
		expect(result.success).toBe(true);
	});

	it("accepts a 451 rule without a destination", () => {
		const result = createRedirectBody.safeParse({ source: "/blocked", type: 451 });
		expect(result.success).toBe(true);
	});

	it("rejects an unsupported status code", () => {
		const result = createRedirectBody.safeParse({ source: "/x", destination: "/y", type: 418 });
		expect(result.success).toBe(false);
	});
});
