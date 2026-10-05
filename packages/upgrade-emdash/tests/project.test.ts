import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
	applyDependencyChanges,
	applyDependencyEdits,
	emdashCommand,
	loadProject,
	targetSpecifier,
} from "../src/project.js";
import type { DependencyChange } from "../src/types.js";

describe("project dependency updates", () => {
	it("preserves caret, tilde, and exact version styles", () => {
		expect(targetSpecifier("^1.0.1", "1.2.0")).toBe("^1.2.0");
		expect(targetSpecifier("~1.0.1", "1.2.0")).toBe("~1.2.0");
		expect(targetSpecifier("1.0.1", "1.2.0")).toBe("1.2.0");
		expect(targetSpecifier("workspace:*", "1.2.0")).toBeNull();
	});

	it("updates each package in its declared dependency section", () => {
		const packageJson = {
			dependencies: { emdash: "^1.0.1", astro: "^7.0.0" },
			devDependencies: { "@emdash-cms/plugin-cli": "~0.4.0" },
		};
		const changes: DependencyChange[] = [
			{
				name: "emdash",
				section: "dependencies",
				from: "^1.0.1",
				to: "^1.2.0",
				fromVersion: "1.0.1",
				toVersion: "1.2.0",
			},
			{
				name: "@emdash-cms/plugin-cli",
				section: "devDependencies",
				from: "~0.4.0",
				to: "~0.5.0",
				fromVersion: "0.4.0",
				toVersion: "0.5.0",
			},
		];

		expect(applyDependencyChanges(packageJson, changes)).toMatchObject({
			dependencies: { emdash: "^1.2.0", astro: "^7.0.0" },
			devDependencies: { "@emdash-cms/plugin-cli": "~0.5.0" },
		});
		expect(
			applyDependencyEdits(
				'{\n\t"dependencies": { "emdash": "^1.0.1", "astro": "^7.0.0" },\n\t"devDependencies": { "@emdash-cms/plugin-cli": "~0.4.0" }\n}\n',
				changes,
			),
		).toBe(
			'{\n\t"dependencies": { "emdash": "^1.2.0", "astro": "^7.0.0" },\n\t"devDependencies": { "@emdash-cms/plugin-cli": "~0.5.0" }\n}\n',
		);
	});

	it("uses each package manager's project-local EmDash binary", () => {
		expect(emdashCommand("pnpm", "migrate --status")).toBe("pnpm exec emdash migrate --status");
		expect(emdashCommand("npm", "migrate --status")).toBe("npm exec -- emdash migrate --status");
		expect(emdashCommand("yarn", "migrate --status")).toBe("yarn emdash migrate --status");
		expect(emdashCommand("bun", "migrate --status")).toBe("bunx emdash migrate --status");
	});
});

describe("project loading", () => {
	const directories: string[] = [];

	afterEach(async () => {
		await Promise.all(
			directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
		);
	});

	async function writeJson(path: string, value: unknown): Promise<void> {
		await mkdir(join(path, ".."), { recursive: true });
		await writeFile(path, `${JSON.stringify(value, null, "\t")}\n`);
	}

	async function project(emdashVersion: string): Promise<string> {
		const root = await mkdtemp(join(tmpdir(), "upgrade-emdash-"));
		directories.push(root);
		await writeJson(join(root, "package.json"), {
			dependencies: { emdash: `^${emdashVersion}` },
		});
		await writeJson(join(root, "node_modules/emdash/package.json"), {
			name: "emdash",
			version: emdashVersion,
			type: "module",
			exports: { ".": "./index.mjs" },
		});
		await writeFile(join(root, "node_modules/emdash/index.mjs"), "export {};\n");
		return root;
	}

	it("explains that emdash releases without a migration identity need a manual update first", async () => {
		const root = await project("0.34.0");

		await expect(loadProject(root)).rejects.toThrow(
			"upgrade-emdash requires emdash 0.35.0 or later, but this project has 0.34.0",
		);
	});
});
