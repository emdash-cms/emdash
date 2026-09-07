import { createRequire } from "node:module";
import { dirname, resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";

import { describe, expect, it } from "vitest";

const PARSER_TIMEOUT_MS = 2_000;
const require = createRequire(import.meta.url);
const imageSizeModuleUrl = pathToFileURL(
	resolvePath(dirname(require.resolve("image-size")), "index.mjs"),
).href;

const HEIF_ZERO_LENGTH_ISPE = new Uint8Array([
	0x00, 0x00, 0x00, 0x10, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66, 0x00, 0x00, 0x00, 0x00,
	0x00, 0x00, 0x00, 0x24, 0x6d, 0x65, 0x74, 0x61, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x08,
	0x69, 0x70, 0x72, 0x70, 0x00, 0x00, 0x00, 0x14, 0x69, 0x70, 0x63, 0x6f, 0x00, 0x00, 0x00, 0x00,
	0x69, 0x73, 0x70, 0x65, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
	0x00, 0x00, 0x00, 0x00,
]);

const ICNS_ZERO_LENGTH_ENTRY = new Uint8Array([
	0x69, 0x63, 0x6e, 0x73, 0x00, 0x00, 0x00, 0x10, 0x69, 0x73, 0x33, 0x32, 0x00, 0x00, 0x00, 0x00,
]);

const JXL_ZERO_LENGTH_JXLP = new Uint8Array([
	0x00, 0x00, 0x00, 0x0c, 0x4a, 0x58, 0x4c, 0x20, 0x0d, 0x0a, 0x87, 0x0a, 0x00, 0x00, 0x00, 0x14,
	0x66, 0x74, 0x79, 0x70, 0x6a, 0x78, 0x6c, 0x20, 0x00, 0x00, 0x00, 0x00, 0x6a, 0x78, 0x6c, 0x20,
	0x00, 0x00, 0x00, 0x00, 0x6a, 0x78, 0x6c, 0x70,
]);

interface ParserResult {
	width?: number;
	height?: number;
	type?: string;
}

type WorkerMessage = { ok: true; value: ParserResult } | { ok: false; error: string };

function parseWithTimeout(bytes: Uint8Array): Promise<ParserResult> {
	return new Promise((resolve, reject) => {
		const worker = new Worker(new URL("./image-size-security-worker.mjs", import.meta.url), {
			workerData: {
				moduleUrl: imageSizeModuleUrl,
				bytes,
			},
		});
		let settled = false;
		const timer = setTimeout(() => {
			settled = true;
			void worker.terminate();
			reject(new Error(`image-size did not settle within ${PARSER_TIMEOUT_MS}ms`));
		}, PARSER_TIMEOUT_MS);

		worker.once("message", (message: WorkerMessage) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			void worker.terminate();
			if (message.ok) {
				resolve(message.value);
			} else {
				reject(new Error(message.error));
			}
		});
		worker.once("error", (error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			void worker.terminate();
			reject(error);
		});
		worker.once("exit", (code) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			reject(new Error(`image-size worker exited before replying with code ${code}`));
		});
	});
}

describe("image-size malformed box handling", () => {
	it("settles for the published HEIF zero-length box", async () => {
		await expect(parseWithTimeout(HEIF_ZERO_LENGTH_ISPE)).resolves.toEqual({
			width: 0,
			height: 0,
			type: "avif",
		});
	});

	it("settles for the published ICNS zero-length entry", async () => {
		await expect(parseWithTimeout(ICNS_ZERO_LENGTH_ENTRY)).resolves.toEqual({
			width: 16,
			height: 16,
			type: "icns",
		});
	});

	it("settles for a JXL zero-length partial stream box", async () => {
		await expect(parseWithTimeout(JXL_ZERO_LENGTH_JXLP)).rejects.toThrow("Reached end of input");
	});
});
