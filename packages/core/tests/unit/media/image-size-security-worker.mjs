import { parentPort, workerData } from "node:worker_threads";

/* oxlint-disable unicorn/require-post-message-target-origin -- MessagePort has no target origin */

if (!parentPort) throw new Error("Image parser worker requires a parent port");

try {
	const { imageSize } = await import(workerData.moduleUrl);
	const result = imageSize(Uint8Array.from(workerData.bytes));
	parentPort.postMessage({
		ok: true,
		value: { width: result.width, height: result.height, type: result.type },
	});
} catch (error) {
	parentPort.postMessage({
		ok: false,
		error: error instanceof Error ? error.message : String(error),
	});
}
