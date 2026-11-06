import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	const spinner = { start: vi.fn(), stop: vi.fn() };
	return {
		downloadTemplate: vi.fn(),
		runCommand: vi.fn(),
		prompts: {
			intro: vi.fn(),
			spinner: vi.fn(() => spinner),
			log: {
				info: vi.fn(),
				success: vi.fn(),
				warn: vi.fn(),
				error: vi.fn(),
			},
			note: vi.fn(),
			outro: vi.fn(),
		},
	};
});

vi.mock("giget", () => ({ downloadTemplate: mocks.downloadTemplate }));
vi.mock("@clack/prompts", () => mocks.prompts);
vi.mock("../src/utils.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/utils.js")>();
	return { ...actual, runCommand: mocks.runCommand };
});

describe("create-emdash install failure", () => {
	let tempDir: string;
	const originalArgv = process.argv;
	const originalCwd = process.cwd();
	const originalExitCode = process.exitCode;

	beforeEach(() => {
		tempDir = realpathSync(mkdtempSync(join(tmpdir(), "create-emdash-install-failure-")));
		process.chdir(tempDir);
		process.argv = [
			process.execPath,
			"create-emdash",
			"failed-install",
			"--template",
			"cloudflare:blog",
			"--pm",
			"npm",
			"--install",
			"--yes",
		];
		process.exitCode = undefined;
		mocks.downloadTemplate.mockImplementation(async (_source, options: { dir: string }) => {
			mkdirSync(options.dir, { recursive: true });
			writeFileSync(
				join(options.dir, "package.json"),
				JSON.stringify({ name: "template", packageManager: "pnpm@11.0.0" }),
			);
		});
		mocks.runCommand.mockRejectedValue(new Error("npm install exited with code 1"));
		vi.spyOn(console, "clear").mockImplementation(() => {});
	});

	afterEach(() => {
		process.argv = originalArgv;
		process.exitCode = originalExitCode;
		process.chdir(originalCwd);
		rmSync(tempDir, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	it("keeps the project, reports the retry command, and exits unsuccessfully", async () => {
		await import("../src/index.js");
		await vi.waitFor(() => expect(process.exitCode).toBe(1));

		const projectDir = join(tempDir, "failed-install");
		expect(mocks.runCommand).toHaveBeenCalledWith("npm", ["install"], projectDir);
		expect(mocks.prompts.log.error).toHaveBeenCalledWith("npm install exited with code 1");
		expect(mocks.prompts.note).toHaveBeenCalledWith(
			"cd failed-install && npm install",
			"Dependency installation failed",
		);
		expect(mocks.prompts.outro).toHaveBeenCalledWith(
			"Project files were created, but dependencies were not installed",
		);
		expect(mocks.prompts.outro).not.toHaveBeenCalledWith(expect.stringContaining("Done!"));
		expect(JSON.parse(readFileSync(join(projectDir, "package.json"), "utf8"))).toEqual({
			name: "failed-install",
		});
	});
});
