import { describe, expect, it } from "vitest";

import { writeOperationsMetric } from "../src/observability/metrics.js";

describe("release-service operations metrics", () => {
	it("writes a bounded privacy-safe Analytics Engine point", () => {
		const points: AnalyticsEngineDataPoint[] = [];
		const dataset = {
			writeDataPoint(point?: AnalyticsEngineDataPoint) {
				if (point) points.push(point);
			},
		} satisfies AnalyticsEngineDataset;

		writeOperationsMetric(
			{
				event: "intent_rate_limited",
				ownerHash: "A".repeat(43),
				outcome: "denied",
				scope: "workload",
				requestId: "request-1",
				value: 1,
				timestamp: 1_800_000_000_000,
			},
			dataset,
		);

		expect(points).toEqual([
			{
				indexes: ["A".repeat(43)],
				blobs: ["intent_rate_limited", "denied", "workload", "request-1"],
				doubles: [1, 1_800_000_000_000],
			},
		]);
		expect(JSON.stringify(points)).not.toContain("did:");
	});

	it("rejects unbounded or identifying dimensions", () => {
		const dataset = { writeDataPoint() {} } satisfies AnalyticsEngineDataset;
		expect(() =>
			writeOperationsMetric(
				{ event: "access_denied", ownerHash: "did:plc:publisher", value: 1 },
				dataset,
			),
		).toThrow("Invalid operations metric");
	});
});
