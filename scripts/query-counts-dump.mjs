#!/usr/bin/env node
/**
 * Sibling of scripts/query-counts.mjs that dumps raw query events to JSON
 * files under scripts/query-dumps/{target}/{routeSlug}.{phase}.json
 *
 * Each file is an array of { sql, params, durationMs, route, method, phase }.
 * The harness assumes the fixture is already built and seeded -- we only
 * spin servers, hit routes, and partition events. For sqlite, the main
 * `query-counts.mjs --target sqlite` flow builds and seeds; for d1, run
 * `query-counts.mjs --target d1` once first (or `build-perf-d1.mjs` to
 * build only) so wrangler state and dist/ exist.
 *
 * The dump JSON itself is gitignored — it's an analysis artifact that
 * regenerates from the harness in seconds. The helper scripts in
 * `query-dumps/` (classify.mjs, cold-only.mjs, inspect-other.mjs) are
 * the things worth keeping in source.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const fixtureDir = resolve(repoRoot, "fixtures/perf-site");
const dumpsDir = resolve(__dirname, "query-dumps");

const HOST = "127.0.0.1";
const PORT = 14322;
const BASE = `http://${HOST}:${PORT}`;
const QUERY_LOG_PREFIX = "[emdash-query-log] ";

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

function parseArgs(argv) {
	const out = { target: "sqlite", routesOnly: null };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--target") out.target = argv[++i];
		else if (a.startsWith("--target=")) out.target = a.slice("--target=".length);
		else if (a === "--routes") out.routesOnly = argv[++i].split(",");
	}
	if (out.target !== "sqlite" && out.target !== "d1") {
		throw new Error(`bad --target ${out.target}`);
	}
	return out;
}

const { target, routesOnly } = parseArgs(process.argv.slice(2));

function waitForPort(host, port, timeoutMs = 120_000) {
	const deadline = Date.now() + timeoutMs;
	return new Promise((resolveReady, rejectReady) => {
		const attempt = () => {
			if (Date.now() > deadline) {
				rejectReady(new Error(`port ${host}:${port} did not open within ${timeoutMs}ms`));
				return;
			}
			const socket = createConnection({ host, port });
			socket.once("connect", () => {
				socket.destroy();
				resolveReady();
			});
			socket.once("error", () => {
				socket.destroy();
				setTimeout(attempt, 100);
			});
		};
		attempt();
	});
}

function startServer(events) {
	let cmd, args;
	if (target === "sqlite") {
		cmd = "node";
		args = ["./dist/server/entry.mjs"];
	} else {
		cmd = "pnpm";
		args = ["exec", "astro", "preview", "--host", HOST, "--port", String(PORT)];
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

	const ready = waitForPort(HOST, PORT);
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
	});

	const exited = new Promise((res) => child.once("exit", res));

	async function stop() {
		child.kill("SIGTERM");
		await Promise.race([
			exited,
			new Promise((r) => setTimeout(r, 5_000)).then(() => child.kill("SIGKILL")),
		]);
		await new Promise((r) => setTimeout(r, 250));
	}

	return { ready, stop };
}

async function hit(method, path, phase) {
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

async function warmup() {
	const r = await fetch(BASE, { redirect: "manual" });
	await r.arrayBuffer();
	process.stdout.write(`  warmup GET / -> ${r.status}\n`);
}

const ROUTE_LEADING_SLASH = /^\//;
const ROUTE_NON_ALNUM = /[^a-zA-Z0-9]+/g;

function routeSlug(path) {
	if (path === "/") return "root";
	return path.replace(ROUTE_LEADING_SLASH, "").replace(ROUTE_NON_ALNUM, "_");
}

function dumpEventsByRoute(events, dumpTarget) {
	const targetDir = resolve(dumpsDir, dumpTarget);
	if (!existsSync(targetDir)) mkdirSync(targetDir, { recursive: true });

	const groups = new Map();
	for (const e of events) {
		if (e.phase !== "cold" && e.phase !== "warm") continue;
		const key = `${routeSlug(e.route)}.${e.phase}`;
		if (!groups.has(key)) groups.set(key, []);
		groups.get(key).push(e);
	}
	for (const [key, list] of groups) {
		const file = resolve(targetDir, `${key}.json`);
		writeFileSync(file, JSON.stringify(list, null, "\t") + "\n");
		process.stdout.write(`wrote ${file} (${list.length})\n`);
	}
	const allFile = resolve(targetDir, "_all.json");
	writeFileSync(allFile, JSON.stringify(events, null, "\t") + "\n");
	process.stdout.write(`wrote ${allFile} (${events.length})\n`);
}

async function runSqlite(events) {
	const server = startServer(events);
	try {
		await server.ready;
		await warmup();
		const routes = routesOnly ? ROUTES.filter(([_, p]) => routesOnly.includes(p)) : ROUTES;
		for (const [m, p] of routes) await hit(m, p, "cold");
		for (const [m, p] of routes) await hit(m, p, "warm");
	} finally {
		await server.stop();
	}
}

async function runD1(events) {
	const routes = routesOnly ? ROUTES.filter(([_, p]) => routesOnly.includes(p)) : ROUTES;
	for (const [m, p] of routes) {
		process.stdout.write(`--- fresh isolate for ${m} ${p} ---\n`);
		const server = startServer(events);
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
	dumpEventsByRoute(events, target);
}

main()
	.then(() => process.exit(0))
	.catch((err) => {
		process.stderr.write(`${err.stack ?? err.message ?? err}\n`);
		process.exit(1);
	});
