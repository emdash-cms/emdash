import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { createUpgradePlan, withTargetMigrations } from "../src/plan.js";
import type { ProjectState } from "../src/project.js";

function jsonResponse(value: unknown): Response {
	return new Response(JSON.stringify(value), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}

describe("upgrade plan", () => {
	it("resolves a tag for each direct package and derives the GitHub release work", async () => {
		const packageJson = {
			packageManager: "pnpm@11",
			scripts: { deploy: "wrangler deploy" },
			dependencies: { emdash: "^1.0.0", "@emdash-cms/cloudflare": "~1.0.0" },
		};
		const project: ProjectState = {
			root: "/site",
			installRoot: "/site",
			packageJsonPath: "/site/package.json",
			packageJsonSource: `${JSON.stringify(packageJson)}\n`,
			packageJson,
			packageManager: "pnpm",
			dependencies: [
				{
					name: "emdash",
					section: "dependencies",
					specifier: "^1.0.0",
					installedVersion: "1.0.0",
				},
				{
					name: "@emdash-cms/cloudflare",
					section: "dependencies",
					specifier: "~1.0.0",
					installedVersion: "1.0.0",
				},
			],
			currentVersion: "1.0.0",
			migrations: ["001_initial"],
		};
		const fetcher: typeof fetch = async (input) => {
			const url = new URL(
				typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
			);
			if (url.hostname === "registry.npmjs.org") {
				const name = decodeURIComponent(url.pathname.split("/").slice(1, -1).join("/"));
				return jsonResponse({
					name,
					version: name === "emdash" ? "1.2.0" : "1.1.0",
					repository: {
						url: "git+https://github.com/emdash-cms/emdash.git",
						directory: name === "emdash" ? "packages/core" : "packages/cloudflare",
					},
				});
			}
			const version = url.pathname.includes("packages/core") ? "1.2.0" : "1.1.0";
			const changelog = `# package\n\n## ${version}\n\n### Minor Changes\n\n- Shared authored change.\n\n## 1.0.0\n\n### Major Changes\n\n- Initial.\n`;
			return new Response(changelog);
		};

		const plan = await createUpgradePlan(project, "latest", fetcher);

		expect(plan.dependencies).toMatchObject([
			{ name: "emdash", from: "^1.0.0", to: "^1.2.0", toVersion: "1.2.0" },
			{
				name: "@emdash-cms/cloudflare",
				from: "~1.0.0",
				to: "~1.1.0",
				toVersion: "1.1.0",
			},
		]);
		expect(plan.changelog).toHaveLength(1);
		expect(plan.changelog[0]?.occurrences).toHaveLength(2);
		expect(plan.migrations).toMatchObject({
			currentVersion: "1.0.0",
			targetVersion: "1.2.0",
		});
		expect(plan.commands).toMatchObject({
			build: "pnpm build",
			deploy: "pnpm deploy",
			migrationStatus: "pnpm exec emdash migrate --status",
		});
		expect(plan.guidePath).toBe(resolve("/site/.emdash/UPGRADE.md"));

		const completed = withTargetMigrations(plan, {
			...project,
			currentVersion: "1.2.0",
			migrations: ["001_initial", "002_added"],
		});
		expect(completed.migrations.added).toEqual(["002_added"]);
	});

	it("rewrites a broad specifier even when the lockfile already installed the target", async () => {
		const packageJson = { dependencies: { emdash: "^1.0.0" } };
		const project: ProjectState = {
			root: "/site",
			installRoot: "/site",
			packageJsonPath: "/site/package.json",
			packageJsonSource: `${JSON.stringify(packageJson)}\n`,
			packageJson,
			packageManager: "npm",
			dependencies: [
				{
					name: "emdash",
					section: "dependencies",
					specifier: "^1.0.0",
					installedVersion: "1.2.0",
				},
			],
			currentVersion: "1.2.0",
			migrations: [],
		};
		const fetcher: typeof fetch = async () => jsonResponse({ name: "emdash", version: "1.2.0" });

		const plan = await createUpgradePlan(project, "latest", fetcher);

		expect(plan.dependencies).toMatchObject([{ from: "^1.0.0", to: "^1.2.0" }]);
		expect(plan.changelog).toEqual([]);
	});

	it("does not offer a deploy script that rebuilds the project", async () => {
		const plans = await Promise.all(
			["astro build && wrangler deploy", "wrangler deploy"].map((deploy) => {
				const packageJson = { scripts: { deploy }, dependencies: { emdash: "^1.2.0" } };
				const project: ProjectState = {
					root: "/site",
					installRoot: "/site",
					packageJsonPath: "/site/package.json",
					packageJsonSource: `${JSON.stringify(packageJson)}\n`,
					packageJson,
					packageManager: "pnpm",
					dependencies: [
						{
							name: "emdash",
							section: "dependencies",
							specifier: "^1.2.0",
							installedVersion: "1.2.0",
						},
					],
					currentVersion: "1.2.0",
					migrations: [],
				};
				return createUpgradePlan(project, "latest", async () =>
					jsonResponse({ name: "emdash", version: "1.2.0" }),
				);
			}),
		);

		expect(plans.map((plan) => plan.commands.deploy)).toEqual([undefined, "pnpm deploy"]);
	});

	function singleDependencyProject(
		name: string,
		specifier: string,
		installedVersion: string,
		workspaceManifestSource?: string,
	): ProjectState {
		const dependencies = { emdash: "^1.2.0", [name]: specifier };
		const packageJson = { dependencies };
		return {
			root: "/site",
			installRoot: "/site",
			packageJsonPath: "/site/package.json",
			packageJsonSource: `${JSON.stringify(packageJson)}\n`,
			packageJson,
			packageManager: "pnpm",
			dependencies: [
				{ name: "emdash", section: "dependencies", specifier: "^1.2.0", installedVersion: "1.2.0" },
				{ name, section: "dependencies", specifier, installedVersion },
			],
			currentVersion: "1.2.0",
			migrations: [],
			...(workspaceManifestSource === undefined
				? {}
				: {
						workspaceManifest: {
							path: "/site/pnpm-workspace.yaml",
							source: workspaceManifestSource,
						},
					}),
		};
	}

	const releasesAt =
		(version: string): typeof fetch =>
		async (input) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			const name = decodeURIComponent(new URL(url).pathname.split("/").slice(1, -1).join("/"));
			return jsonResponse({ name, version: name === "emdash" ? "1.2.0" : version });
		};

	it("replaces a preview build URL with the release even when the versions match", async () => {
		const preview = "https://pkg.pr.new/emdash-cms/emdash/@emdash-cms/cloudflare@3285";
		const plan = await createUpgradePlan(
			singleDependencyProject("@emdash-cms/cloudflare", preview, "1.1.0"),
			"latest",
			releasesAt("1.1.0"),
		);

		expect(plan.dependencies).toMatchObject([
			{ name: "@emdash-cms/cloudflare", from: preview, to: "^1.1.0", toVersion: "1.1.0" },
		]);
	});

	it("updates a pnpm catalog entry instead of the catalog: specifier", async () => {
		const plan = await createUpgradePlan(
			singleDependencyProject(
				"@emdash-cms/cloudflare",
				"catalog:",
				"1.1.0",
				'catalog:\n  "@emdash-cms/cloudflare": ~1.0.0\n',
			),
			"latest",
			releasesAt("1.1.0"),
		);

		expect(plan.dependencies).toEqual([
			expect.objectContaining({
				name: "@emdash-cms/cloudflare",
				catalog: "default",
				from: "~1.0.0",
				to: "~1.1.0",
				toVersion: "1.1.0",
			}),
		]);
	});

	it("explains a catalog dependency without a pnpm catalog entry", async () => {
		await expect(
			createUpgradePlan(
				singleDependencyProject(
					"@emdash-cms/cloudflare",
					"catalog:preview",
					"1.0.0",
					"catalog: {}\n",
				),
				"latest",
				releasesAt("1.1.0"),
			),
		).rejects.toThrow(
			"@emdash-cms/cloudflare uses catalog:preview, but the preview catalog in /site/pnpm-workspace.yaml has no @emdash-cms/cloudflare entry.",
		);
		await expect(
			createUpgradePlan(
				singleDependencyProject("@emdash-cms/cloudflare", "catalog:", "1.0.0"),
				"latest",
				releasesAt("1.1.0"),
			),
		).rejects.toThrow(
			"@emdash-cms/cloudflare uses catalog:, but there is no pnpm-workspace.yaml at /site. upgrade-emdash updates pnpm catalogs only.",
		);
	});
});
