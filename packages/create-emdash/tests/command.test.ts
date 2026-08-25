import { describe, expect, it } from "vitest";

import { runCommand } from "../src/utils.js";

describe("runCommand", () => {
	it("resolves when the command succeeds", async () => {
		await expect(
			runCommand(process.execPath, ["-e", "process.exit(0)"], process.cwd()),
		).resolves.toBeUndefined();
	});

	it("rejects when the command exits unsuccessfully", async () => {
		await expect(
			runCommand(process.execPath, ["-e", "process.exit(23)"], process.cwd()),
		).rejects.toThrow("exited with code 23");
	});
});
