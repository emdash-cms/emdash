import { describe, expect, it } from "vitest";

import {
	applyDependencyChanges,
	applyDependencyEdits,
	emdashCommand,
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
