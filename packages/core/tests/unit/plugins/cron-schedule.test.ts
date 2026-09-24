import { afterEach, describe, expect, it, vi } from "vitest";

import { isOneShot, nextCronTime } from "../../../src/plugins/cron.js";

describe("cron schedule classification", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("classifies an ISO timestamp as a one-shot even when the cron parser accepts it", () => {
		expect(isOneShot("2030-01-02T03:04:05.000Z")).toBe(true);
		expect(isOneShot("2030-01-02T03:04:05")).toBe(true);
	});

	it("does not misclassify a cron range as a date", () => {
		expect(isOneShot("1-5 * * * *")).toBe(false);
	});

	it("calculates recurring schedules from the supplied clock", () => {
		expect(nextCronTime("@daily", new Date("2030-01-02T03:04:05.000Z"))).toBe(
			"2030-01-03T00:00:00.000Z",
		);
	});

	it("resolves recurring schedules in UTC even when the host TZ is not UTC", () => {
		vi.stubEnv("TZ", "America/New_York");
		expect(nextCronTime("@daily", new Date("2030-01-02T03:04:05.000Z"))).toBe(
			"2030-01-03T00:00:00.000Z",
		);
		expect(nextCronTime("0 9 * * *", new Date("2030-01-02T03:04:05.000Z"))).toBe(
			"2030-01-02T09:00:00.000Z",
		);
	});
});
