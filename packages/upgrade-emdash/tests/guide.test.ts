import { describe, expect, it } from "vitest";

import { migrationBackupWarning, renderUpgradeGuide } from "../src/guide.js";
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
				syncSkills: "npx --yes skills@1.7.0 add emdash-cms/skills -y",
			},
		};

		const guide = renderUpgradeGuide(plan);
		expect(guide).toContain("Replace the removed option.");
		expect(guide).toContain("Keep the deployment setting");
		expect(guide).toContain("emdash@1.1.0");
		expect(guide).toContain("Source: [#12](https://github.com/emdash-cms/emdash/pull/12)");
		expect(guide).toContain("`002_added`");
		expect(guide).toContain("restorable database backup");
		expect(guide).toContain("https://docs.emdashcms.com/guides/backups/");
		expect(guide).toContain("pnpm build\npnpm exec emdash migrate --status");
		expect(guide).toContain("pnpm exec emdash migrate\n```");
		expect(guide).toContain("pnpm deploy");
		expect(guide).toContain("pnpm exec emdash migrate --check");
		expect(guide).toContain("upgrading-emdash");
		expect(guide).toContain("--expected-target-fingerprint");
		expect(migrationBackupWarning(plan)).toContain("Before starting or deploying");

		const withCatalog = renderUpgradeGuide({
			...plan,
			dependencies: [
				{ ...plan.dependencies[0]!, catalog: "default", from: "^1.0.1", to: "^1.1.0" },
			],
		});
		expect(withCatalog).toContain(
			"- `emdash`: `1.0.1` → `1.1.0` (`^1.0.1` → `^1.1.0` in the `default` pnpm catalog)",
		);
		expect(withCatalog).toContain("every workspace package that uses those catalog entries");

		const withoutDeployScript = renderUpgradeGuide({
			...plan,
			commands: { ...plan.commands, deploy: undefined },
		});
		expect(withoutDeployScript).toContain("without rebuilding it");
	});

	it("does not require an upgrade backup when no core migrations were added", () => {
		const plan: UpgradePlan = {
			projectRoot: "/site",
			packageManager: "pnpm",
			tag: "latest",
			dependencies: [],
			changelog: [],
			migrations: {
				currentVersion: "1.1.0",
				current: ["001_initial"],
				targetVersion: "1.1.1",
				target: ["001_initial"],
				added: [],
			},
			guidePath: "/site/.emdash/UPGRADE.md",
			commands: {
				install: "pnpm install",
				build: "pnpm build",
				deploy: "pnpm deploy",
				migrationStatus: "pnpm exec emdash migrate --status",
				migrationApply: "pnpm exec emdash migrate",
				migrationCheck: "pnpm exec emdash migrate --check",
				syncSkills: "npx --yes skills@1.7.0 add emdash-cms/skills -y",
			},
		};

		const guide = renderUpgradeGuide(plan);
		expect(guide).toContain("No core migrations were added by this upgrade.");
		expect(guide).toContain("pnpm build\npnpm exec emdash migrate --status");
		expect(guide).toContain("If the status reports pending migrations");
		expect(guide).toContain("pnpm exec emdash migrate\n```");
		expect(guide).not.toContain("Before starting or deploying the upgraded build");
		expect(migrationBackupWarning(plan)).toBeUndefined();
	});
});
