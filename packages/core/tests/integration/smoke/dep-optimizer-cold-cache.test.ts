import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { ensureBuilt } from "../server.js";

// A Cloudflare-adapter site that is proven to boot in CI (it is part of the
// site-matrix smoke suite). We reuse it rather than an isolated site because
// the only CF sites NOT in the matrix are unusable here: demos/cloudflare
// needs Cloudflare Access secrets, and demos/preview uses a Durable-Object
// preview DB that dev-bypass cannot migrate. fileParallelism:false in
// vitest.smoke.config.ts guarantees this never boots concurrently with the
// matrix, so sharing the site (and its node_modules/.vite) is safe.
const WORKSPACE_ROOT = resolve(import.meta.dirname, "../../../../..");
const SITE_DIR = resolve(WORKSPACE_ROOT, "templates/starter-cloudflare");
const PORT = 4620; // unused by the matrix (4603, 4612-4618)
const BASE_URL = `http://localhost:${PORT}`;

// Deterministic signal of a missing force-include: on a cold cache, any SSR
// dep not in optimizeDeps.include is discovered at request time and triggers
// a post-startup re-optimize. (The downstream deps_ssr "file does not exist"
// crash is a race between overlapping re-optimizes and is NOT reliable to
// assert on -- a single missing dep usually only re-optimizes, not crashes.)
const REOPTIMIZE_RE = /new dependencies optimized|optimized dependencies changed|re-optimizing/i;
// Completeness: if the race does manifest, catch it too. These two phrases are
// genuine Vite dev-server log lines emitted only on a real deps_ssr cascade --
// not transient cold-start traces that fetchWithRetry recovers from -- so this
// stays a deterministic signal and not a CI flake source. (The primary guard is
// REOPTIMIZE_RE above; a real cascade always emits re-optimize lines too.)
const CRASH_RE = /does not exist at|An error happened during full reload/i;

async function waitForServer(url: string, timeoutMs: number): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		try {
			const res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(3000) });
			if (res.status > 0) return;
		} catch {
			// not ready yet
		}
		await new Promise((r) => setTimeout(r, 500));
	}
	throw new Error(`Server at ${url} did not start within ${timeoutMs}ms`);
}

async function fetchWithRetry(url: string, retries = 8, delayMs = 1500): Promise<void> {
	// Mid-cascade requests can 500; retry so a transient 5xx doesn't mask the
	// log-based assertion. We don't care about the body, only that we drove the
	// route so its imports are reached.
	for (let attempt = 0; attempt <= retries; attempt++) {
		try {
			const res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(15_000) });
			if (res.status < 500) return;
		} catch {
			// retry
		}
		if (attempt < retries) await new Promise((r) => setTimeout(r, delayMs));
	}
}

/**
 * Resolve once server output stops growing for `quietMs`, capped at `capMs`.
 * Defaults are generous so a slow CI runner that pauses mid-re-optimize-burst
 * doesn't settle early and produce a false green.
 */
async function waitForOutputToSettle(
	getOutput: () => string,
	quietMs = 3000,
	capMs = 15_000,
): Promise<void> {
	const start = Date.now();
	let last = getOutput().length;
	let lastChange = Date.now();
	while (Date.now() - start < capMs) {
		await new Promise((r) => setTimeout(r, 500));
		const now = getOutput().length;
		if (now !== last) {
			last = now;
			lastChange = Date.now();
		} else if (Date.now() - lastChange >= quietMs) {
			return;
		}
	}
}

describe.sequential("cold-cache SSR dep optimizer (cloudflare)", () => {
	it(
		"force-includes all runtime-reached SSR deps (zero post-startup re-optimizations)",
		{ timeout: 240_000 },
		async () => {
			// ensureBuilt() skips the build if the CLI binary already exists, so it
			// does NOT rebuild after a source edit. The dev server loads emdash's
			// compiled dist (the integration vite config comes from dist, not src),
			// so after editing vite-config.ts locally run `pnpm build` before this
			// test or it will measure the stale build. CI always builds first, so
			// it's correct there.
			await ensureBuilt();

			// Cold cache: wipe Vite's dep cache and any stale DB so the optimizer
			// runs from scratch. This is what reproduces the bug -- a warm .vite
			// hides it.
			rmSync(join(SITE_DIR, "node_modules", ".vite"), { recursive: true, force: true });
			for (const f of ["data.db", "data.db-wal", "data.db-shm"]) {
				rmSync(join(SITE_DIR, f), { force: true });
			}

			const server = spawn("pnpm", ["exec", "astro", "dev", "--port", String(PORT)], {
				cwd: SITE_DIR,
				env: { ...process.env, CI: "true" },
				stdio: "pipe",
			});

			let output = "";
			server.stdout?.on("data", (d: Buffer) => (output += d.toString()));
			server.stderr?.on("data", (d: Buffer) => (output += d.toString()));

			try {
				await waitForServer(`${BASE_URL}/_emdash/admin/`, 180_000);

				// Drive the routes that reach the runtime-only deps:
				// - dev-bypass: middleware chain, auth, request-context, D1 entrypoint
				// - frontend: emdash/ui, emdash/runtime, portabletext render path
				// - admin: admin shell SSR (lingui, kumo)
				// NOTE: R2 / media (emdash/media/local-runtime,
				// @emdash-cms/cloudflare/storage/r2) need an actual media op to be
				// exercised and are not covered here; this guard covers the
				// dev-bypass + frontend + admin import graph.
				await fetchWithRetry(`${BASE_URL}/_emdash/api/setup/dev-bypass?redirect=/`);
				await fetchWithRetry(`${BASE_URL}/`);
				await fetchWithRetry(`${BASE_URL}/_emdash/admin/`);

				// Let any async re-optimize logs land before asserting.
				await waitForOutputToSettle(() => output);

				const reoptimizes = output.split("\n").filter((l) => REOPTIMIZE_RE.test(l));
				const crashes = output.split("\n").filter((l) => CRASH_RE.test(l));

				expect(
					reoptimizes,
					`Vite re-optimized SSR deps after startup -- a dep reached at request time ` +
						`is missing from the cloudflare branch of ssr.optimizeDeps.include in ` +
						`packages/core/src/astro/integration/vite-config.ts. Offending log lines:\n` +
						reoptimizes.join("\n"),
				).toEqual([]);
				expect(crashes, `deps_ssr cascade crash detected:\n${crashes.join("\n")}`).toEqual([]);
			} catch (error) {
				throw new Error(
					`cold-cache dep-optimizer guard failed: ${error instanceof Error ? error.message : String(error)}\n\n` +
						output.slice(-3000),
					{ cause: error },
				);
			} finally {
				server.kill("SIGTERM");
				await new Promise((r) => setTimeout(r, 1200));
				if (!server.killed) server.kill("SIGKILL");
				await new Promise((r) => setTimeout(r, 500));
			}
		},
	);
});
