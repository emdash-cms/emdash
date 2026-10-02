import { describe, expect, it } from "vitest";

import { renderUpgradeGuide } from "../src/guide.js";
import type { UpgradePlan } from "../src/types.js";

describe("agent upgrade work order", () => {
	it("includes complete release guidance and the migration deployment boundary", () => {
		const plan: UpgradePlan = {
			projectRoot: "/site",
			packageManager: "pnpm",
			tag: "latest",
			dependencies: [
				{
					name: "emdash",
					section: "dependencies",
					from: "^1.0.1",
					to: "^1.1.0",
					fromVersion: "1.0.1",
					toVersion: "1.1.0",
				},
			],
			changelog: [
				{
					body: "Replace the removed option.\n\nKeep the deployment setting in the runtime environment.",
					occurrences: [
						{
							packageName: "emdash",
							version: "1.1.0",
							category: "minor",
							source: "[#12](https://github.com/emdash-cms/emdash/pull/12)",
						},
					],
				},
			],
			migrations: {
				currentVersion: "1.0.1",
				current: ["001_initial"],
				targetVersion: "1.1.0",
				target: ["001_initial", "002_added"],
				added: ["002_added"],
			},
			guidePath: "/site/.emdash/UPGRADE.md",
			commands: {
				install: "pnpm install",
				build: "pnpm build",
				deploy: "pnpm deploy",
				migrationStatus: "pnpm exec emdash migrate --status",
				migrationApply: "pnpm exec emdash migrate",
				migrationCheck: "pnpm exec emdash migrate --check",
				syncSkills: "npx --yes skills add emdash-cms/skills -y",
			},
		};

		const guide = renderUpgradeGuide(plan);
		expect(guide).toContain("Replace the removed option.");
		expect(guide).toContain("Keep the deployment setting");
		expect(guide).toContain("emdash@1.1.0");
		expect(guide).toContain("`002_added`");
		expect(guide).toContain("restorable database backup");
		expect(guide).toContain("pnpm build\npnpm exec emdash migrate --status");
		expect(guide).toContain("pnpm exec emdash migrate\n```");
		expect(guide).toContain("pnpm deploy");
		expect(guide).toContain("pnpm exec emdash migrate --check");
		expect(guide).toContain("upgrading-emdash");
	});
});
