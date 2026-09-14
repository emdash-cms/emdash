import { describe, expect, it } from "vitest";

import { rebundleSafeRequire } from "../tsdown.config.js";

const INPUT = "var __require = /* @__PURE__ */ createRequire(import.meta.url);";

function evaluateRequireBase(
	rendered: string,
	createRequire: (base: string) => string,
	importMetaUrl: string,
): string {
	const expression = rendered
		.replace("var __require = /* @__PURE__ */ ", "")
		.replace(/;$/, "")
		.replaceAll("import.meta.url", "importMetaUrl");
	return new Function("createRequire", "importMetaUrl", `return ${expression}`)(
		createRequire,
		importMetaUrl,
	) as string;
}

describe("rebundleSafeRequire", () => {
	it("uses the module's own URL when Node accepts it", () => {
		const rendered = rebundleSafeRequire.renderChunk(INPUT);
		const windowsUrl =
			"file:///D:/site/node_modules/@emdash-cms/registry-verification/dist/index.js";
		const base = evaluateRequireBase(
			rendered,
			(candidate) => {
				if (!/^file:\/\/\/[A-Za-z]:\//.test(candidate))
					throw new TypeError("Received protocol 'file:' without a drive");
				return candidate;
			},
			windowsUrl,
		);
		expect(base).toBe(windowsUrl);
	});

	it("falls back to the fixed base when the rebundled URL is not a file", () => {
		const rendered = rebundleSafeRequire.renderChunk(INPUT);
		const base = evaluateRequireBase(
			rendered,
			(candidate) => {
				if (candidate === "virtual:bundle") throw new TypeError("not a file URL");
				return candidate;
			},
			"virtual:bundle",
		);
		expect(base).toBe("file:///emdash-registry-verification.js");
	});

	it("leaves code without the shim untouched", () => {
		expect(rebundleSafeRequire.renderChunk("export const x = 1;")).toBe("export const x = 1;");
	});
});
