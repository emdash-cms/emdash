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

	it("keeps dev invokable with a warning before database work", () => {
		const result = spawnSync(
			"node",
			[CLI_BIN, "dev", "--cwd", resolve(import.meta.dirname, "missing-site")],
			{
				encoding: "utf8",
				env: CLI_ENV,
			},
		);
		const output = `${result.stdout}${result.stderr}`;

		expect(result.error).toBeUndefined();
		expect(result.status).toBe(1);
		expect(output).toContain("DEPRECATED COMMAND");
		expect(output).toContain("pnpm dev");
		expect(output).toContain("astro dev");
		expect(output).toContain("No package.json found");
		expect(output.indexOf("DEPRECATED COMMAND")).toBeLessThan(
			output.indexOf("No package.json found"),
		);
		expect(output).not.toContain("Starting Astro dev server");
	});
});
