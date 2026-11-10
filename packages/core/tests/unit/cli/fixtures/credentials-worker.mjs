import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

const [source, operation, baseUrl, credentialJson, releaseFile, pauseReads, startFile] =
	process.argv.slice(2);
process.send?.("starting");

const originalReadFileSync = fs.readFileSync;
let paused = false;

fs.readFileSync = function patchedReadFileSync(path, ...args) {
	const value = originalReadFileSync.call(this, path, ...args);
	if (pauseReads === "true" && !paused && String(path).endsWith("auth.json")) {
		paused = true;
		process.send?.("read");
		waitForMarker(releaseFile, "release");
	}
	return value;
};
syncBuiltinESMExports();

const deadline = Date.now() + 5_000;
const waitForMarker = (path, name) => {
	while (!fs.existsSync(path)) {
		if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${name}: ${path}`);
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
	}
};

const credentials = await import(source);
if (startFile) waitForMarker(startFile, "start");
if (operation === "save") {
	credentials.saveCredentials(baseUrl, JSON.parse(credentialJson));
} else {
	credentials.removeCredentials(baseUrl);
}
process.send?.("done");
