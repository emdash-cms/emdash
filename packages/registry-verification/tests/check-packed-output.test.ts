import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { platform } from "node:process";
import { fileURLToPath } from "node:url";

import { expect, it } from "vitest";

it("fails closed when the active package manager entrypoint is unavailable", () => {
	const environment = { ...process.env };
	delete environment.npm_execpath;

	const result = spawnSync(
		process.execPath,
		[fileURLToPath(new URL("../scripts/check-packed-output.mjs", import.meta.url))],
		{ encoding: "utf8", env: environment },
	);

	expect(result.status).not.toBe(0);
	expect(result.stderr).toContain("npm_execpath is unavailable");
});

it.skipIf(platform === "win32")(
	"runs a non-JavaScript package manager entrypoint directly instead of through Node",
	() => {
		const tempDirectory = mkdtempSync(join(tmpdir(), "registry-verification-fake-pnpm-"));
		const fakePnpm = join(tempDirectory, "fake-pnpm");
		try {
			writeFileSync(
				fakePnpm,
				'#!/bin/sh\n# { this is not JavaScript }\necho "executed directly" >&2\nexit 42\n',
			);
			chmodSync(fakePnpm, 0o755);

			const environment = { ...process.env, npm_execpath: fakePnpm };

			const result = spawnSync(
				process.execPath,
				[fileURLToPath(new URL("../scripts/check-packed-output.mjs", import.meta.url))],
				{ encoding: "utf8", env: environment },
			);

			expect(result.status).not.toBe(0);
			expect(result.stderr).not.toContain("SyntaxError");
			expect(result.stderr).toContain("executed directly");
		} finally {
			rmSync(tempDirectory, { recursive: true, force: true });
		}
	},
);
