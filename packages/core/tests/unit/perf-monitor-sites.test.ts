import { expect, it } from "vitest";

import { runMeasurements } from "../../../../infra/perf-monitor/src/measure.js";
import { REGIONS } from "../../../../infra/perf-monitor/src/routes.js";
import type { Site } from "../../../../infra/perf-monitor/src/routes.js";

const sites: Site[] = [
	{ id: "managed", label: "Managed", targetUrl: "https://managed.example", workerName: "managed" },
	{
		id: "opted-in",
		label: "Opted in",
		targetUrl: "https://opted-in.example",
		workerName: "opted-in",
		deployMeasurements: true,
	},
	{
		id: "external",
		label: "External",
		targetUrl: "https://external.example",
		workerName: "external",
		deployMeasurements: false,
	},
];

it.each(["deploy", "cron", "manual"] as const)(
	"keeps independently deployed sites out of commit-attributed %s measurements only",
	async (source) => {
		const targets: string[] = [];
		const probe = {
			async fetch(_url: string, init: RequestInit) {
				if (typeof init.body !== "string") throw new Error("Expected a JSON string body");
				const payload = JSON.parse(init.body) as { targetUrl: string };
				targets.push(payload.targetUrl);
				return Response.json({
					results: [
						{
							path: "/",
							label: "Homepage",
							coldTtfbMs: 20,
							warmTtfbMs: 10,
							p95TtfbMs: 12,
							statusCode: 200,
							cfColo: null,
							cfPlacement: null,
							coldServerTimings: null,
							warmServerTimings: null,
						},
					],
				});
			},
		};
		const env = Object.fromEntries(
			REGIONS.map((region) => [`PROBE_${region.toUpperCase()}`, probe]),
		) as unknown as Parameters<typeof runMeasurements>[0];
		const results = await runMeasurements(env, {
			source,
			sites,
			...(source === "deploy" ? { sha: "baseline-sha", prNumber: 123 } : {}),
		});

		expect(targets.filter((url) => url === "https://managed.example")).toHaveLength(REGIONS.length);
		expect(targets.filter((url) => url === "https://opted-in.example")).toHaveLength(
			REGIONS.length,
		);
		expect(results.filter((row) => row.site === "opted-in")).toHaveLength(REGIONS.length);
		expect(results).toHaveLength(REGIONS.length * (source === "deploy" ? 2 : 3));
		if (source === "deploy") {
			expect(targets).not.toContain("https://external.example");
			expect(results.some((row) => row.site === "external")).toBe(false);
			expect(results.every((row) => row.sha === "baseline-sha" && row.prNumber === 123)).toBe(true);
		} else {
			expect(targets.filter((url) => url === "https://external.example")).toHaveLength(
				REGIONS.length,
			);
			expect(results.filter((row) => row.site === "external")).toHaveLength(REGIONS.length);
			expect(results.every((row) => row.sha === null && row.prNumber === null)).toBe(true);
		}
	},
);
