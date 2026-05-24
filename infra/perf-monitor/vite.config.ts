import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite";

const PROBE_REGIONS = [
	{ id: "use", region: "aws:us-east-1" },
	{ id: "euw", region: "aws:eu-west-2" },
	{ id: "ape", region: "aws:ap-northeast-1" },
	{ id: "aps", region: "aws:ap-southeast-1" },
] as const;

export default defineConfig({
	plugins: [
		cloudflare({
			configPath: "./wrangler.jsonc",
			auxiliaryWorkers: PROBE_REGIONS.map((probe) => ({
				config: (_, { entryWorkerConfig }) => ({
					name: `emdash-perf-probe-${probe.id}`,
					main: "./probe/src/index.ts",
					account_id: entryWorkerConfig.account_id,
					compatibility_date: entryWorkerConfig.compatibility_date,
					compatibility_flags: entryWorkerConfig.compatibility_flags,
					placement: {
						region: probe.region,
					},
				}),
			})),
		}),
	],
});
