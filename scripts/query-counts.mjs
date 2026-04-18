#!/usr/bin/env node
/**
 * Query-count harness for the runtime perf fixture.
 *
 * Builds fixtures/perf-site with `astro build`, then serves it via the
 * production adapter entry (node or wrangler, never `astro dev`) so the
 * measured code paths match what real visitors hit. For each fixture
 * route we record cold and warm phase queries — the Kysely log hook
 * emits `[emdash-query-log]`-prefixed NDJSON on stdout, which the harness
 * captures.
 *
 * Two targets, two server strategies:
 *   --target sqlite   Node adapter standalone entry. One long-lived
 *                     process. First request warms the runtime (migrations
 *                     + auto-seed on first boot). Cold/warm is per-route
 *                     first-vs-second hit.
 *
 *   --target d1       Cloudflare adapter via `astro preview` (wrangler dev
 *                     against the built worker). Because real D1 visitors
 *                     often land on a fresh isolate, we measure that:
 *                     seed once in a dedicated boot, stop; then spin a
 *                     fresh preview per route for one cold + one warm
 *                     hit, stop, next route.
 *
 * Seeding (per target):
 *   sqlite: `emdash init && emdash seed` via the CLI — writes directly to
 *           data.db, no HTTP layer involved.
 *   d1:     astro dev + POST /_emdash/api/setup/dev-bypass. The dev-bypass
 *           endpoint is dead-code-eliminated from prod builds, so it's
 *           only reachable via dev mode. Local D1 state persists in
 *           .wrangler/state across dev → preview.
 *
 * Usage:
 *   node scripts/query-counts.mjs                       # sqlite, compare
 *   node scripts/query-counts.mjs --target d1           # d1, compare
 *   node scripts/query-counts.mjs --update              # rewrite snapshot
 *   node scripts/query-counts.mjs --target d1 --update
 *   node scripts/query-counts.mjs --skip-seed           # reuse existing db
 *   node scripts/query-counts.mjs --skip-build          # reuse existing build
 *
 * --skip-seed and --skip-build compose. Passing both gives the fastest
 * local iteration loop once the fixture is set up.
 *
 * Prerequisite: `pnpm build` has run (the emdash CLI lives in dist/).
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const fixtureDir = resolve(repoRoot, "fixtures/perf-site");

const HOST = "127.0.0.1";
const PORT = 14321;
const BASE = `http://${HOST}:${PORT}`;

const ROUTES = [
	["GET", "/"],
	["GET", "/posts"],
	["GET", "/posts/building-for-the-long-term"],
	["GET", "/pages/about"],
	["GET", "/category/development"],
	["GET", "/tag/webdev"],
	["GET", "/rss.xml"],
	["GET", "/search?q=static"],
];

const TRACKED_PHASES = new Set(["cold", "warm"]);
const VALID_TARGETS = new Set(["sqlite", "d1"]);
const QUERY_LOG_PREFIX = "[emdash-query-log] ";
const ASTRO_DEV_READY_RE = /ready in \d/;

// Ready signal, per target. Each serves log output we can grep for.
const NODE_READY_RE = /Server listening on http:/i;
// astro preview via the cloudflare adapter prints "astro vX.Y.Z ready in
// Xms" followed by "Local http://..." — match either.
const WRANGLER_READY_RE = /ready in \d|Local\s+http:/i;

function parseArgs(argv) {
	const out = { target: "sqlite", update: false, skipBuild: false, skipSeed: false };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--update") out.update = true;
		else if (a === "--skip-build") out.skipBuild = true;
		else if (a === "--skip-seed") out.skipSeed = true;
		else if (a === "--target") {
			out.target = argv[++i];
		} else if (a.startsWith("--target=")) {
			out.target = a.slice("--target=".length);
		} else {
			throw new Error(`Unknown argument: ${a}`);
		}
	}
	if (!VALID_TARGETS.has(out.target)) {
		throw new Error(`--target must be one of: ${[...VALID_TARGETS].join(", ")}`);
	}
	return out;
}

const { target, update, skipBuild, skipSeed } = parseArgs(process.argv.slice(2));
const snapshotPath = resolve(__dirname, `query-counts.snapshot.${target}.json`);

function resetSqliteState() {
	for (const f of ["data.db", "data.db-wal", "data.db-shm"]) {
		rmSync(resolve(fixtureDir, f), { force: true });
	}
	rmSync(resolve(fixtureDir, "uploads"), { recursive: true, force: true });
}

function resetD1State() {
	rmSync(resolve(fixtureDir, ".wrangler"), { recursive: true, force: true });
}

const buildMarkerPath = resolve(fixtureDir, "dist/.perf-target");

function buildFixture() {
	process.stdout.write(`$ (cd ${fixtureDir}) astro build\n`);
	const r = spawnSync("pnpm", ["exec", "astro", "build"], {
		cwd: fixtureDir,
		stdio: "inherit",
		env: { ...process.env, EMDASH_FIXTURE_TARGET: target },
	});
	if (r.status !== 0) throw new Error("astro build failed");
	writeFileSync(buildMarkerPath, target + "\n");
}

function assertExistingBuildMatchesTarget() {
	if (!existsSync(buildMarkerPath)) {
		throw new Error(
			`--skip-build was passed but dist/.perf-target is missing. Run without --skip-build to produce a build for target "${target}".`,
		);
	}
	const built = readFileSync(buildMarkerPath, "utf8").trim();
	if (built !== target) {
		throw new Error(
			`--skip-build was passed but existing build is for target "${built}", not "${target}". Drop --skip-build (or rebuild) to switch targets.`,
		);
	}
}

// SQLite: seed the file DB via the emdash CLI directly — it runs
// migrations, applies the virtual-module seed, and sets
// `emdash:setup_complete`, all without going through the HTTP layer.
function seedSqliteCli() {
	for (const step of ["init", "seed"]) {
		process.stdout.write(`$ (cd ${fixtureDir}) emdash ${step}\n`);
		const r = spawnSync("pnpm", ["exec", "emdash", step], {
			cwd: fixtureDir,
			stdio: "inherit",
			env: { ...process.env, EMDASH_FIXTURE_TARGET: "sqlite" },
		});
		if (r.status !== 0) throw new Error(`emdash ${step} failed`);
	}
}

// D1: the CLI can't reach D1 over the Workers protocol, so we seed by
// running astro dev once (dev-bypass is gated on import.meta.env.DEV
// and is stripped from prod builds) and hitting the dev-bypass endpoint.
// Local D1 state persists in .wrangler/state across dev → preview.
async function seedD1ViaDevBypass(events) {
	process.stdout.write(`--- seeding via astro dev + dev-bypass ---\n`);
	const child = spawn("pnpm", ["exec", "astro", "dev", "--host", HOST, "--port", String(PORT)], {
		cwd: fixtureDir,
		env: {
			...process.env,
			EMDASH_FIXTURE_TARGET: "d1",
			EMDASH_QUERY_LOG: "1",
		},
		stdio: ["ignore", "pipe", "inherit"],
	});

	let resolveReady;
	let rejectReady;
	const ready = new Promise((res, rej) => {
		resolveReady = res;
		rejectReady = rej;
	});
	const readyTimer = setTimeout(
		() => rejectReady(new Error("astro dev did not become ready")),
		120_000,
	);
	const rl = createInterface({ input: child.stdout });
	rl.on("line", (line) => {
		const idx = line.indexOf(QUERY_LOG_PREFIX);
		if (idx !== -1) {
			const payload = line.slice(idx + QUERY_LOG_PREFIX.length);
			try {
				events.push(JSON.parse(payload));
			} catch {
				// ignore
			}
			return;
		}
		process.stdout.write(line + "\n");
		if (resolveReady && ASTRO_DEV_READY_RE.test(line)) {
			clearTimeout(readyTimer);
			resolveReady();
			resolveReady = undefined;
		}
	});
	const exited = new Promise((res) => child.once("exit", res));

	try {
		await ready;
		const r = await fetch(`${BASE}/_emdash/api/setup/dev-bypass`, {
			method: "POST",
			redirect: "manual",
		});
		if (!r.ok) {
			const body = await r.text();
			throw new Error(`dev-bypass failed: ${r.status} ${body.slice(0, 200)}`);
		}
		await r.arrayBuffer();
		process.stdout.write(`  seed via dev-bypass -> ${r.status}\n`);
	} finally {
		child.kill("SIGTERM");
		await Promise.race([
			exited,
			new Promise((r) => setTimeout(r, 5_000)).then(() => child.kill("SIGKILL")),
		]);
		await new Promise((r) => setTimeout(r, 250));
	}
}

/**
 * Spawn the prod server for the current target. Returns { ready, stop }.
 *   sqlite: node ./dist/server/entry.mjs (HOST/PORT env)
 *   d1:     astro preview (cloudflare adapter → wrangler dev)
 * No HTTP probing — probing warms workerd isolates before our first
 * tagged request. We detect readiness by matching a regex on server
 * stdout instead.
 */
function startServer({ collectedEvents }) {
	let cmd;
	let args;
	let readyRe;
	if (target === "sqlite") {
		cmd = "node";
		args = ["./dist/server/entry.mjs"];
		readyRe = NODE_READY_RE;
	} else {
		cmd = "pnpm";
		args = ["exec", "astro", "preview", "--host", HOST, "--port", String(PORT)];
		readyRe = WRANGLER_READY_RE;
	}

	const child = spawn(cmd, args, {
		cwd: fixtureDir,
		env: {
			...process.env,
			EMDASH_FIXTURE_TARGET: target,
			EMDASH_QUERY_LOG: "1",
			HOST,
			PORT: String(PORT),
		},
		stdio: ["ignore", "pipe", "inherit"],
	});

	let resolveReady;
	let rejectReady;
	const ready = new Promise((res, rej) => {
		resolveReady = res;
		rejectReady = rej;
	});
	const readyTimer = setTimeout(() => {
		rejectReady(new Error(`server did not become ready within 120s (regex ${readyRe})`));
	}, 120_000);

	const rl = createInterface({ input: child.stdout });
	rl.on("line", (line) => {
		const idx = line.indexOf(QUERY_LOG_PREFIX);
		if (idx !== -1) {
			const before = line.slice(0, idx);
			if (before.trim().length > 0) process.stdout.write(before + "\n");
			const payload = line.slice(idx + QUERY_LOG_PREFIX.length);
			try {
				collectedEvents.push(JSON.parse(payload));
			} catch {
				process.stderr.write(`bad query-log line: ${payload}\n`);
			}
			return;
		}
		process.stdout.write(line + "\n");
		if (resolveReady && readyRe.test(line)) {
			clearTimeout(readyTimer);
			resolveReady();
			resolveReady = undefined;
		}
	});

	const exited = new Promise((res) => child.once("exit", res));
	child.once("error", (err) => {
		process.stderr.write(`server spawn error: ${err.message}\n`);
	});

	async function stop() {
		child.kill("SIGTERM");
		await Promise.race([
			exited,
			new Promise((r) => setTimeout(r, 5_000)).then(() => child.kill("SIGKILL")),
		]);
		// Small pause for the OS to release the port before the next spawn.
		await new Promise((r) => setTimeout(r, 250));
	}

	return { ready, stop };
}

async function hit(method, path, phase) {
	// Tiny retry for the very first hit against a just-spawned wrangler
	// preview — "ready" fires before the HTTP listener actually accepts
	// on some runs. We're not measuring these retry attempts (they're
	// in the "default" phase), just papering over a race.
	let lastErr;
	for (let i = 0; i < 10; i++) {
		try {
			const r = await fetch(`${BASE}${path}`, {
				method,
				headers: { "x-perf-phase": phase },
				redirect: "manual",
			});
			await r.arrayBuffer();
			process.stdout.write(`  ${phase.padEnd(5)} ${method} ${path} -> ${r.status}\n`);
			return r.status;
		} catch (err) {
			lastErr = err;
			await new Promise((r) => setTimeout(r, 200));
		}
	}
	throw lastErr;
}

// An untagged hit that triggers runtime init (migrations + auto-seed on
// first boot). Events here land in "default" phase and are filtered out.
async function warmup() {
	const r = await fetch(BASE, { redirect: "manual" });
	await r.arrayBuffer();
	process.stdout.write(`  warmup GET / -> ${r.status}\n`);
}

function aggregate(events) {
	const counts = {};
	for (const e of events) {
		if (!TRACKED_PHASES.has(e.phase)) continue;
		const key = `${e.method} ${e.route} (${e.phase})`;
		counts[key] = (counts[key] ?? 0) + 1;
	}
	return Object.fromEntries(Object.entries(counts).toSorted(([a], [b]) => a.localeCompare(b)));
}

function diffSnapshot(actual) {
	if (!existsSync(snapshotPath)) {
		process.stderr.write(`No snapshot at ${snapshotPath}. Run with --update to create one.\n`);
		return 1;
	}
	const expected = JSON.parse(readFileSync(snapshotPath, "utf8"));
	const keys = [...new Set([...Object.keys(expected), ...Object.keys(actual)])].toSorted();
	const diffs = [];
	for (const k of keys) {
		if (expected[k] !== actual[k]) {
			diffs.push({ key: k, expected: expected[k], actual: actual[k] });
		}
	}
	if (diffs.length === 0) {
		process.stdout.write(`OK: query counts match ${snapshotPath}\n`);
		return 0;
	}
	process.stderr.write(`Query counts differ from ${snapshotPath}:\n`);
	for (const d of diffs) {
		const e = d.expected ?? "(missing)";
		const a = d.actual ?? "(missing)";
		process.stderr.write(`  ${d.key}: expected=${e} actual=${a}\n`);
	}
	process.stderr.write(
		`\nIf the change is intentional, run: node scripts/query-counts.mjs --target ${target} --update\n`,
	);
	return 1;
}

// SQLite: seed the file DB via CLI, build, then run one long-lived node
// entry. Warmup hit absorbs runtime init queries (filtered as "default"
// phase). Tagged cold = first visit to route (runtime warm); warm = second.
async function runSqlite(events) {
	if (!skipSeed) {
		resetSqliteState();
		seedSqliteCli();
	}
	if (skipBuild) assertExistingBuildMatchesTarget();
	else buildFixture();
	const server = startServer({ collectedEvents: events });
	try {
		await server.ready;
		await warmup();
		for (const [m, p] of ROUTES) await hit(m, p, "cold");
		for (const [m, p] of ROUTES) await hit(m, p, "warm");
	} finally {
		await server.stop();
	}
}

// D1: build the worker, seed via dev-bypass (dev mode only — stripped
// from prod builds), then for each route spin up a fresh `astro preview`
// (cloudflare adapter runs wrangler dev). The first tagged hit lands on
// a genuinely cold workerd isolate; the second hit shares that isolate.
async function runD1(events) {
	if (skipBuild) assertExistingBuildMatchesTarget();
	else buildFixture();
	if (!skipSeed) {
		resetD1State();
		// seeding uses its own event sink; we don't want to commingle
		// those with the measurement events (they're all "default" phase
		// anyway, but keeping them separate is tidier).
		await seedD1ViaDevBypass([]);
	}

	for (const [m, p] of ROUTES) {
		process.stdout.write(`--- fresh isolate for ${m} ${p} ---\n`);
		const server = startServer({ collectedEvents: events });
		try {
			await server.ready;
			await hit(m, p, "cold");
			await hit(m, p, "warm");
		} finally {
			await server.stop();
		}
	}
}

async function main() {
	const events = [];
	if (target === "sqlite") await runSqlite(events);
	else await runD1(events);

	const counts = aggregate(events);
	if (update) {
		writeFileSync(snapshotPath, JSON.stringify(counts, null, 2) + "\n");
		process.stdout.write(`Wrote ${Object.keys(counts).length} entries to ${snapshotPath}\n`);
		return 0;
	}
	return diffSnapshot(counts);
}

main()
	.then((code) => process.exit(code ?? 0))
	.catch((err) => {
		process.stderr.write(`${err.stack ?? err.message ?? err}\n`);
		process.exit(1);
	});
