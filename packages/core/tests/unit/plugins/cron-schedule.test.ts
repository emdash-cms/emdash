import { describe, expect, it } from "vitest";

import { isOneShot } from "../../../src/plugins/cron.js";

describe("cron schedule classification", () => {
	it("classifies an ISO timestamp as a one-shot even when the cron parser accepts it", () => {
		expect(isOneShot("2030-01-02T03:04:05.000Z")).toBe(true);
	});

	it("does not misclassify a cron range as a date", () => {
		expect(isOneShot("1-5 * * * *")).toBe(false);
	});
});
