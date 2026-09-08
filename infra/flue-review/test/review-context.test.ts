import { createMemoryStateBackend } from "@cloudflare/shell";
import { describe, expect, it } from "vitest";

import {
	GENERATED_WORKER_TYPES_NOTICE,
	omitGeneratedWorkerTypes,
} from "../.flue/lib/review-context.js";

const generatedPaths = [
	"/repo/worker-configuration.d.ts",
	"/repo/infra/emdash-bot/worker-configuration.d.ts",
	"/repo/packages/plugins/example/generated/worker-configuration.d.ts",
];

describe("omitGeneratedWorkerTypes", () => {
	it("replaces generated Worker types at every path depth", async () => {
		const similarPath = "/repo/src/worker-configuration.d.ts.template";
		const backend = createMemoryStateBackend({
			files: Object.fromEntries([
				...generatedPaths.map((path) => [path, "declare const generatedSecret: string;\n"]),
				[similarPath, "template content\n"],
			]),
		});

		await omitGeneratedWorkerTypes(backend, "/repo");

		for (const path of generatedPaths) {
			expect(await backend.readFile(path)).toBe(GENERATED_WORKER_TYPES_NOTICE);
		}
		expect(await backend.readFile(similarPath)).toBe("template content\n");
	});
});
