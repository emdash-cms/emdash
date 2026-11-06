import { readFileSync } from "node:fs";
import path from "node:path";

import type { AstroIntegration } from "astro";
import { describe, expect, it, vi } from "vitest";

import { x402 } from "./index.js";

type SetupHook = NonNullable<AstroIntegration["hooks"]["astro:config:setup"]>;

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
	exports: Record<string, { default: string }>;
};

describe("x402 integration", () => {
	it("registers its middleware by file URL, not by package name", async () => {
		const addMiddleware = vi.fn();
		const setup = x402({
			payTo: "0x0000000000000000000000000000000000000000",
			network: "eip155:84532",
		}).hooks["astro:config:setup"] as SetupHook;
		await setup({ addMiddleware, updateConfig: vi.fn() } as unknown as Parameters<SetupHook>[0]);

		// Astro resolves a bare specifier from the site's root, which fails when the
		// site gets this package through another integration under pnpm.
		const { entrypoint, order } = addMiddleware.mock.calls[0]![0];
		expect(order).toBe("pre");
		expect(entrypoint).toBeInstanceOf(URL);
		expect(entrypoint.protocol).toBe("file:");

		// The URL is relative to the published integration module, so the published
		// middleware must sit next to it under the name the URL uses.
		const index = pkg.exports["."]!.default;
		const middleware = pkg.exports["./middleware"]!.default;
		expect(path.posix.dirname(middleware)).toBe(path.posix.dirname(index));
		expect(entrypoint.pathname.endsWith(`/${path.posix.basename(middleware)}`)).toBe(true);
	});
});
