import { execFileSync, spawnSync } from "node:child_process";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const CLI_BIN = resolve(import.meta.dirname, "../../../dist/cli/index.mjs");
const CLI_ENV = { ...process.env, NODE_ENV: "production", TEST: "", NO_COLOR: "1" };

describe("CLI help", () => {
	it("does not offer a dev-server wrapper", () => {
		const output = execFileSync("node", [CLI_BIN, "--help"], {
			encoding: "utf8",
			env: CLI_ENV,
		});

		expect(output).toMatch(/^\s+types\s+Generate TypeScript types/m);
		expect(output).not.toMatch(/^\s+dev\s+/m);
	});

	it("does not offer the removed marketplace plugin commands", () => {
		const output = execFileSync("node", [CLI_BIN, "--help"], {
			encoding: "utf8",
			env: CLI_ENV,
		});

		expect(output).not.toMatch(/^\s+plugin\s+/m);
	});

	it.each([["dev"], ["auth", "secret"]])(
		"fails scripts that call the removed `%s` command",
		(...args) => {
			const result = spawnSync("node", [CLI_BIN, ...args], { encoding: "utf8", env: CLI_ENV });

			expect(result.status).toBe(1);
			expect(`${result.stdout}${result.stderr}`).toContain(`Unknown command ${args[0]}`);
		},
	);
});
