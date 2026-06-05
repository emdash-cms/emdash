/**
 * Playwright global teardown.
 *
 * Kills the dev server, removes the temp data directory,
 * and cleans up the node_modules symlink if we created it.
 */

import { existsSync, readFileSync, readdirSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SERVER_INFO_PATH = join(tmpdir(), "emdash-pw-server.json");
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const FIXTURE_DIR = resolve(ROOT, "e2e/fixture");

export default async function globalTeardown(): Promise<void> {
	if (!existsSync(SERVER_INFO_PATH)) return;

	try {
		const info = JSON.parse(readFileSync(SERVER_INFO_PATH, "utf-8"));

		// Kill the server process
		try {
			process.kill(info.pid, "SIGTERM");
			await new Promise((r) => setTimeout(r, 1000));
			try {
				process.kill(info.pid, 0); // Check if alive
				process.kill(info.pid, "SIGKILL");
			} catch {
				// Already dead
			}
		} catch {
			// Process may already be dead
		}

		// Remove temp data directory (database + media files)
		if (info.tempDataDir && existsSync(info.tempDataDir)) {
			rmSync(info.tempDataDir, { recursive: true, force: true });
		}

		// Clean up artifacts from whichever fixture was run (Node or Cloudflare).
		const fixtureDir = typeof info.workDir === "string" ? info.workDir : FIXTURE_DIR;

		// Build artifacts and miniflare (D1/R2) state.
		for (const dir of [".astro", ".wrangler"]) {
			const path = join(fixtureDir, dir);
			if (existsSync(path)) rmSync(path, { recursive: true, force: true });
		}

		// Clean up generated .emdash subdirs (uploads, etc.) but preserve seed.json
		const emdashDir = join(fixtureDir, ".emdash");
		if (existsSync(emdashDir)) {
			for (const entry of readdirSync(emdashDir)) {
				if (entry === "seed.json") continue;
				const entryPath = join(emdashDir, entry);
				rmSync(entryPath, { recursive: true, force: true });
			}
		}
	} finally {
		unlinkSync(SERVER_INFO_PATH);
	}

	console.log("[pw] Server stopped and temp directory cleaned up.");
}
