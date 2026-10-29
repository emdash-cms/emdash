import { describe, expect, it } from "vitest";

import { allowSearch, SEARCH_WINDOW_MS, SEARCHES_PER_WINDOW } from "../src/throttle.js";

function searches(ip: string | null, count: number, now: number) {
	return Array.from({ length: count }, () => allowSearch(ip, now));
}

describe("allowSearch", () => {
	it("refuses a client over the limit until its window ends, without affecting others", () => {
		const now = 1_000_000;

		expect(searches("192.0.2.1", SEARCHES_PER_WINDOW, now).every(Boolean)).toBe(true);
		expect(allowSearch("192.0.2.1", now + 1)).toBe(false);
		expect(allowSearch("192.0.2.2", now + 1)).toBe(true);
		expect(allowSearch("192.0.2.1", now + SEARCH_WINDOW_MS)).toBe(true);
	});

	it("allows searches from an unknown address", () => {
		expect(searches(null, SEARCHES_PER_WINDOW + 1, 2_000_000).every(Boolean)).toBe(true);
	});
});
