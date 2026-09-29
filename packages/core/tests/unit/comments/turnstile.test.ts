import { Buffer } from "node:buffer";
import { fileURLToPath } from "node:url";

import { build } from "vite";
import { afterEach, describe, expect, it } from "vitest";

const KEYS = ["EMDASH_TURNSTILE_SECRET_KEY", "TURNSTILE_SECRET_KEY"] as const;

async function bundledGetTurnstileSecretKey(): Promise<() => string> {
	const output = await build({
		logLevel: "silent",
		build: {
			write: false,
			ssr: fileURLToPath(new URL("../../../src/comments/turnstile.ts", import.meta.url)),
		},
	});
	if ("on" in output) throw new Error("Expected a completed Vite build");
	const builds = Array.isArray(output) ? output : [output];
	const chunk = builds.flatMap((result) => result.output).find((item) => item.type === "chunk");
	if (!chunk || chunk.type !== "chunk") throw new Error("Turnstile bundle is missing");
	const bundled: unknown = await import(
		`data:text/javascript;base64,${Buffer.from(chunk.code).toString("base64")}`
	);
	const fn =
		bundled && typeof bundled === "object" && Reflect.get(bundled, "getTurnstileSecretKey");
	if (typeof fn !== "function") throw new Error("Bundle did not export getTurnstileSecretKey");
	return fn as () => string;
}

describe("getTurnstileSecretKey in a production bundle", () => {
	const previous = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));

	afterEach(() => {
		for (const key of KEYS) {
			if (previous[key] === undefined) delete process.env[key];
			else process.env[key] = previous[key];
		}
	});

	it("reads a secret set only at runtime", async () => {
		for (const key of KEYS) delete process.env[key];
		const getTurnstileSecretKey = await bundledGetTurnstileSecretKey();

		process.env.EMDASH_TURNSTILE_SECRET_KEY = "runtime-secret";
		expect(getTurnstileSecretKey()).toBe("runtime-secret");

		delete process.env.EMDASH_TURNSTILE_SECRET_KEY;
		process.env.TURNSTILE_SECRET_KEY = "fallback-secret";
		expect(getTurnstileSecretKey()).toBe("fallback-secret");

		delete process.env.TURNSTILE_SECRET_KEY;
		expect(getTurnstileSecretKey()).toBe("");
	});
});
