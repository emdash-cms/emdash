import { createMemoryStateBackend } from "@cloudflare/shell";
import { describe, expect, it } from "vitest";

import {
	COMPILED_RELEASE_ACTION_NOTICE,
	GENERATED_WORKER_TYPES_NOTICE,
	omitReviewArtifacts,
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

describe("omitReviewArtifacts", () => {
	it("replaces the compiled release Action without touching similar paths", async () => {
		const compiledPath = "/repo/apps/release-action/dist/index.js";
		const workerTypesPath = "/repo/infra/example/worker-configuration.d.ts";
		const similarFiles = {
			"/repo/apps/release-action/dist/index.js.map": "source map contents\n",
			"/repo/apps/release-action/dist/index.jsx": "JSX contents\n",
			"/repo/apps/release-action/dist/nested/index.js": "nested bundle contents\n",
			"/repo/apps/release-action-copy/dist/index.js": "other Action contents\n",
		};
		const backend = createMemoryStateBackend({
			files: {
				[compiledPath]: "compiled bundle contents\n",
				[workerTypesPath]: "generated Worker types\n",
				...similarFiles,
			},
		});

		await omitReviewArtifacts(backend, "/repo");

		expect(await backend.readFile(compiledPath)).toBe(COMPILED_RELEASE_ACTION_NOTICE);
		expect(await backend.readFile(workerTypesPath)).toBe(GENERATED_WORKER_TYPES_NOTICE);
		for (const [path, content] of Object.entries(similarFiles)) {
			expect(await backend.readFile(path)).toBe(content);
		}
	});

	it("does not create an absent compiled artifact", async () => {
		const backend = createMemoryStateBackend({ files: {} });
		const compiledPath = "/repo/apps/release-action/dist/index.js";

		await omitReviewArtifacts(backend, "/repo");

		expect(await backend.exists(compiledPath)).toBe(false);
	});
});
