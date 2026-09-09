import { fileURLToPath } from "node:url";

import { build } from "tsdown";

export async function buildBodyModePlugin(): Promise<string> {
	const bundles = await build({
		config: false,
		entry: [fileURLToPath(new URL("../fixtures/plugins/body-modes.ts", import.meta.url))],
		platform: "neutral",
		format: "esm",
		noExternal: [/.*/],
		write: false,
		dts: false,
		clean: false,
		tsconfig: false,
	});
	try {
		const chunk = bundles[0]?.chunks.find((output) => output.type === "chunk" && output.isEntry);
		if (!chunk || chunk.type !== "chunk") throw new Error("Missing bundled body-mode plugin");
		return chunk.code;
	} finally {
		await Promise.all(bundles.map((bundle) => bundle[Symbol.asyncDispose]()));
	}
}
