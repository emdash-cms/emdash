import { readFile, readdir, stat } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";

const DEFAULT_ENDPOINT = "http://127.0.0.1:8790/moderate-image";
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MIME_TYPES = new Map([
	[".gif", "image/gif"],
	[".jpg", "image/jpeg"],
	[".jpeg", "image/jpeg"],
	[".png", "image/png"],
	[".webp", "image/webp"],
]);

const inputs = process.argv.slice(2).filter((value) => value !== "--");
if (inputs.length === 0) {
	console.error("Usage: pnpm --dir apps/labeler eval:image:local -- <image-or-directory> [...]");
	console.error("Start the local proxy first with: pnpm --dir apps/labeler eval:image:server");
	process.exitCode = 1;
} else {
	const endpoint = process.env.LOCAL_IMAGE_EVAL_URL || DEFAULT_ENDPOINT;
	const files = [...new Set((await Promise.all(inputs.map(collectImageFiles))).flat())].toSorted(
		(left, right) => left.localeCompare(right),
	);
	if (files.length === 0) {
		console.error("No supported GIF, JPEG, PNG, or WebP images were found.");
		process.exitCode = 1;
	} else {
		console.error(`Sending ${files.length} image(s) to Cloudflare Workers AI via ${endpoint}`);
		for (const path of files) await evaluateImage(path, endpoint);
	}
}

async function collectImageFiles(input) {
	const path = resolve(input);
	const info = await stat(path);
	if (info.isFile()) return MIME_TYPES.has(extname(path).toLowerCase()) ? [path] : [];
	if (!info.isDirectory()) return [];
	const entries = await readdir(path, { withFileTypes: true });
	const nested = await Promise.all(
		entries
			.filter((entry) => !entry.isSymbolicLink())
			.map((entry) => collectImageFiles(resolve(path, entry.name))),
	);
	return nested.flat();
}

async function evaluateImage(path, endpoint) {
	const mimeType = MIME_TYPES.get(extname(path).toLowerCase());
	if (!mimeType) return;
	const info = await stat(path);
	if (info.size > MAX_IMAGE_BYTES) {
		console.log(JSON.stringify({ path, error: "image exceeds the 8 MiB limit" }));
		process.exitCode = 1;
		return;
	}
	const bytes = await readFile(path);
	let response;
	try {
		response = await fetch(endpoint, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				fileName: basename(path),
				mimeType,
				base64: bytes.toString("base64"),
			}),
		});
	} catch (error) {
		console.log(
			JSON.stringify({
				path,
				error: `local evaluation proxy is unavailable: ${error instanceof Error ? error.message : String(error)}`,
			}),
		);
		process.exitCode = 1;
		return;
	}
	let result;
	try {
		result = await response.json();
	} catch {
		result = { error: `local evaluation proxy returned HTTP ${response.status}` };
	}
	console.log(JSON.stringify({ path, ...result }));
	if (!response.ok) process.exitCode = 1;
}
