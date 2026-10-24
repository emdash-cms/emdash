import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it } from "vitest";

it("loads the published config descriptors without Wrangler installed", () => {
	const dir = mkdtempSync(join(tmpdir(), "emdash-no-wrangler-"));
	const packageDir = join(dir, "node_modules/@emdash-cms/cloudflare");

	try {
		mkdirSync(packageDir, { recursive: true });
		cpSync(new URL("../package.json", import.meta.url), join(packageDir, "package.json"));
		cpSync(new URL("../dist", import.meta.url), join(packageDir, "dist"), { recursive: true });

		const output = execFileSync(
			process.execPath,
			[
				"--input-type=module",
				"--eval",
				`
					import assert from "node:assert/strict";
					import { writeFileSync } from "node:fs";
					import { createRequire } from "node:module";

					const require = createRequire(import.meta.url);
					assert.throws(() => require.resolve("wrangler"), { code: "MODULE_NOT_FOUND" });

					const { d1, r2, kvCache, sandbox } = await import("@emdash-cms/cloudflare");
					assert.equal(d1({ binding: "DB" }).entrypoint, "@emdash-cms/cloudflare/db/d1");
					assert.equal(r2({ binding: "MEDIA" }).entrypoint, "@emdash-cms/cloudflare/storage/r2");
					assert.equal(kvCache({ binding: "CACHE" }).entrypoint, "@emdash-cms/cloudflare/cache/kv");
					assert.throws(() => sandbox(), { code: "MODULE_NOT_FOUND" });

					writeFileSync("cloudflare.config.ts", "export default {};\\n");
					assert.equal(sandbox(), "@emdash-cms/cloudflare/sandbox");
					console.log("Descriptors loaded without Wrangler");
				`,
			],
			{ cwd: dir, encoding: "utf8", env: { ...process.env, NODE_PATH: "" } },
		);

		expect(output.trim()).toBe("Descriptors loaded without Wrangler");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
