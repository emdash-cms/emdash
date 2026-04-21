import { describe, it, expect } from "vitest";

import { calculateReadingTime } from "../../src/components/PortableTextEditor";

describe("Editor Metrics", () => {
	describe("calculateReadingTime", () => {
		it("returns 0 minutes for empty document", () => {
			expect(calculateReadingTime(0)).toBe(0);
		});

		it("returns 1 minute for less than 200 words", () => {
			expect(calculateReadingTime(1)).toBe(1);
			expect(calculateReadingTime(100)).toBe(1);
			expect(calculateReadingTime(199)).toBe(1);
		});

		it("returns 1 minute for exactly 200 words", () => {
			expect(calculateReadingTime(200)).toBe(1);
		});

		it("returns 2 minutes for 201-400 words", () => {
			expect(calculateReadingTime(201)).toBe(2);
			expect(calculateReadingTime(300)).toBe(2);
			expect(calculateReadingTime(400)).toBe(2);
		});

		it("returns correct reading time for larger documents", () => {
			expect(calculateReadingTime(1000)).toBe(5);
			expect(calculateReadingTime(1001)).toBe(6);
			expect(calculateReadingTime(2000)).toBe(10);
		});

		it("always rounds up (ceil)", () => {
			// 201 / 200 = 1.005, ceil = 2
			expect(calculateReadingTime(201)).toBe(2);
			// 401 / 200 = 2.005, ceil = 3
			expect(calculateReadingTime(401)).toBe(3);
		});
	});
});
