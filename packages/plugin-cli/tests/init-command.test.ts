import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
	detectPackageManager,
	missingRequiredInitFields,
	runInit,
	resolveSlugAndDir,
} from "../src/commands/init.js";

describe("init command planning", () => {
	it("keeps an argument-free interactive scaffold in the current directory", () => {
		expect(resolveSlugAndDir({}, "/tmp/current-plugin")).toEqual({
			slug: "current-plugin",
			targetDir: "/tmp/current-plugin",
		});
	});

	it("creates a named plugin below the current directory", () => {
		expect(resolveSlugAndDir({ name: "gallery" }, "/tmp/plugins")).toEqual({
			slug: "gallery",
			targetDir: "/tmp/plugins/gallery",
		});
	});

	it("detects the package manager that launched the scaffolder", () => {
		expect(detectPackageManager(undefined, "npm/11.6.2 node/v24.0.0")).toEqual({
			name: "npm",
			version: "11.6.2",
		});
		expect(detectPackageManager(undefined, "pnpm/11.9.0 npm/? node/v24.0.0")).toEqual({
			name: "pnpm",
			version: "11.9.0",
		});
	});

	it("requires ownership metadata in non-interactive mode", () => {
		expect(
			missingRequiredInitFields({
				publisher: undefined,
				author: undefined,
				security: undefined,
			}),
		).toEqual(["--publisher", "--author-name", "--security-email or --security-url"]);
	});

	it("does not write an incomplete non-interactive scaffold", async () => {
		const root = await mkdtemp(join(tmpdir(), "emdash-init-command-"));
		const target = join(root, "incomplete");
		try {
			await expect(
				runInit({
					name: "incomplete",
					dir: target,
					yes: true,
					"package-manager": "npm",
				}),
			).rejects.toMatchObject({
				name: "InputError",
				message: expect.stringContaining("--publisher"),
			});
			await expect(stat(target)).rejects.toMatchObject({ code: "ENOENT" });
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
