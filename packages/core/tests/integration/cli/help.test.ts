import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const CLI_BIN = resolve(import.meta.dirname, "../../../dist/cli/index.mjs");

describe("CLI help", () => {
	it("does not offer a dev-server wrapper", () => {
		const output = execFileSync("node", [CLI_BIN, "--help"], {
			encoding: "utf8",
			env: { ...process.env, NODE_ENV: "production", TEST: "" },
		});

		expect(output).toMatch(/^\s+types\s+Generate TypeScript types/m);
		expect(output).not.toMatch(/^\s+dev\s+/m);
	});
});
