#!/usr/bin/env node
/**
 * Local CPU benchmark for the Cloudflare runtime perf fixture.
 *
 * The existing query-count harness prepares a production D1 build and verifies
 * the full-stream query counts. This script then runs that build in local
 * workerd with query logging disabled, captures V8 CPU profiles through the
 * inspector protocol, and reports sampled active CPU per completed response.
 *
 * Each route gets a fresh workerd process. Warm-up requests initialize the
 * route and isolate; measured requests use unique query parameters to bypass
 * the response cache and consume the complete streamed body before profiling
 * stops.
 *
 * Usage:
 *   pnpm render-cpu
 *   pnpm render-cpu -- --skip-prepare
 *   pnpm render-cpu -- --route post --requests 25 --batches 3
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { cpus, platform, release } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const fixtureDir = resolve(repoRoot, "fixtures/perf-site");
const querySnapshotPath = resolve(__dirname, "query-counts.snapshot.d1.json");
const deployManifestPath = resolve(fixtureDir, ".wrangler/deploy/config.json");
const buildMarkerPath = resolve(fixtureDir, "dist/.perf-target");

const HOST = "127.0.0.1";
const PORT = 14321;
const INSPECTOR_PORT = 14322;
const BASE = `http://${HOST}:${PORT}`;

const ROUTES = [
	{ id: "home", path: "/", type: "collection" },
	{ id: "posts", path: "/posts", type: "collection" },
	{
		id: "post",
		path: "/posts/building-for-the-long-term",
		type: "entry-portable-text",
	},
	{ id: "page", path: "/pages/about", type: "entry-portable-text" },
	{ id: "category", path: "/category/development", type: "taxonomy" },
	{ id: "tag", path: "/tag/webdev", type: "taxonomy" },
	{ id: "rss", path: "/rss.xml", type: "feed" },
	{ id: "search", path: "/search?q=static", type: "search" },
	{ id: "contributors", path: "/contributors", type: "joined-list" },
	{ id: "contributors-naive", path: "/contributors-naive", type: "n-plus-one-list" },
];

function parsePositiveInteger(value, flag) {
	const parsed = Number.parseInt(value, 10);
	if (!Number.isSafeInteger(parsed) || parsed <= 0) {
		throw new Error(`${flag} must be a positive integer`);
	}
	return parsed;
}

function parseArgs(argv) {
	const options = {
		batches: 5,
		requests: 50,
		warmups: 5,
		skipPrepare: false,
		routeIds: /** @type {string[]} */ ([]),
		output: undefined,
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--") continue;
		else if (arg === "--skip-prepare") options.skipPrepare = true;
		else if (arg === "--batches") options.batches = parsePositiveInteger(argv[++i], arg);
		else if (arg === "--requests") options.requests = parsePositiveInteger(argv[++i], arg);
		else if (arg === "--warmups") options.warmups = parsePositiveInteger(argv[++i], arg);
		else if (arg === "--route") options.routeIds.push(argv[++i]);
		else if (arg === "--output") options.output = resolve(argv[++i]);
		else throw new Error(`Unknown argument: ${arg}`);
	}

	const knownIds = new Set(ROUTES.map((route) => route.id));
	for (const id of options.routeIds) {
		if (!knownIds.has(id)) {
			throw new Error(`Unknown route ${id}. Expected one of: ${[...knownIds].join(", ")}`);
		}
	}
	return options;
}

function runQueryCountPreparation() {
	process.stdout.write("Preparing D1 state and verifying query-count snapshots...\n");
	const result = spawnSync("node", [resolve(__dirname, "query-counts.mjs"), "--target", "d1"], {
		cwd: repoRoot,
		stdio: "inherit",
		env: { ...process.env, WRANGLER_LOG_PATH: "/tmp/emdash-query-counts-wrangler.log" },
	});
	if (result.status !== 0) throw new Error("D1 query-count preparation failed");
}

function assertPreparedBuild() {
	if (!existsSync(deployManifestPath) || !existsSync(buildMarkerPath)) {
		throw new Error("No prepared D1 build. Run without --skip-prepare first.");
	}
	if (readFileSync(buildMarkerPath, "utf8").trim() !== "d1") {
		throw new Error("The existing perf fixture build is not the D1 target.");
	}
}

function generatedConfigPath() {
	const manifest = JSON.parse(readFileSync(deployManifestPath, "utf8"));
	if (typeof manifest.configPath !== "string") {
		throw new Error(`No configPath in ${deployManifestPath}`);
	}
	const path = resolve(dirname(deployManifestPath), manifest.configPath);
	if (!existsSync(path)) throw new Error(`Generated Wrangler config does not exist: ${path}`);
	return path;
}

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

function startServer() {
	const child = spawn(
		"pnpm",
		[
			"exec",
			"wrangler",
			"dev",
			"--config",
			generatedConfigPath(),
			"--local",
			"--ip",
			HOST,
			"--port",
			String(PORT),
			"--inspector-ip",
			HOST,
			"--inspector-port",
			String(INSPECTOR_PORT),
			"--persist-to",
			resolve(fixtureDir, ".wrangler/state"),
			"--var",
			"EMDASH_QUERY_LOG:0",
			"--show-interactive-dev-session",
			"false",
			"--log-level",
			"error",
		],
		{
			cwd: fixtureDir,
			env: {
				...process.env,
				WRANGLER_LOG_PATH: "/tmp/emdash-render-cpu-wrangler.log",
			},
			stdio: ["ignore", "pipe", "pipe"],
		},
	);

	let output = "";
	for (const stream of [child.stdout, child.stderr]) {
		stream.on("data", (chunk) => {
			output += chunk.toString();
			if (output.length > 20_000) output = output.slice(-20_000);
		});
	}
	const exited = new Promise((resolveExit) => child.once("exit", resolveExit));
	child.once("error", (error) => {
		output += `\n${error.stack ?? error.message}`;
	});

	async function stop() {
		child.kill("SIGTERM");
		await Promise.race([
			exited,
			new Promise((resolveWait) => setTimeout(resolveWait, 5_000)).then(() =>
				child.kill("SIGKILL"),
			),
		]);
		await new Promise((resolveWait) => setTimeout(resolveWait, 250));
	}

	return {
		ready: Promise.race([
			Promise.all([waitForPort(HOST, PORT), waitForPort(HOST, INSPECTOR_PORT)]),
			exited.then((code) => {
				throw new Error(`Wrangler exited before becoming ready (${code})\n${output}`);
			}),
		]),
		stop,
		getOutput: () => output,
	};
}

async function inspectorWebSocketUrl(timeoutMs = 30_000) {
	const deadline = Date.now() + timeoutMs;
	let lastError;
	while (Date.now() <= deadline) {
		try {
			const response = await fetch(`http://${HOST}:${INSPECTOR_PORT}/json/list`);
			if (response.ok) {
				const targets = await response.json();
				const target = targets.find((item) => typeof item.webSocketDebuggerUrl === "string");
				if (target) return target.webSocketDebuggerUrl;
			}
		} catch (error) {
			lastError = error;
		}
		await new Promise((resolveWait) => setTimeout(resolveWait, 100));
	}
	throw new Error(`Inspector target did not become ready: ${lastError?.message ?? "no target"}`);
}

class InspectorClient {
	constructor(socket) {
		this.socket = socket;
		this.nextId = 1;
		this.pending = new Map();
		socket.addEventListener("message", (event) => {
			const message = JSON.parse(event.data);
			if (typeof message.id !== "number") return;
			const pending = this.pending.get(message.id);
			if (!pending) return;
			this.pending.delete(message.id);
			if (message.error) pending.reject(new Error(message.error.message));
			else pending.resolve(message.result);
		});
	}

	static async connect(url) {
		const socket = new WebSocket(url, { headers: { Origin: "http://localhost" } });
		await new Promise((resolveOpen, rejectOpen) => {
			socket.addEventListener("open", resolveOpen, { once: true });
			socket.addEventListener(
				"error",
				() => rejectOpen(new Error("Inspector WebSocket failed to connect")),
				{ once: true },
			);
		});
		return new InspectorClient(socket);
	}

	call(method, params = {}) {
		const id = this.nextId++;
		return new Promise((resolveCall, rejectCall) => {
			this.pending.set(id, { resolve: resolveCall, reject: rejectCall });
			this.socket.send(JSON.stringify({ id, method, params }));
		});
	}

	close() {
		this.socket.close();
	}
}

function summarizeProfile(profile) {
	const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
	const samples = profile.samples ?? [];
	const timeDeltas = profile.timeDeltas ?? [];
	let sampledUs = 0;
	let idleUs = 0;
	let garbageCollectionUs = 0;
	for (const [index, timeDelta] of timeDeltas.entries()) {
		sampledUs += timeDelta;
		const functionName = nodes.get(samples[index] ?? 0)?.callFrame.functionName;
		if (functionName === "(idle)") idleUs += timeDelta;
		else if (functionName === "(garbage collector)") garbageCollectionUs += timeDelta;
	}
	return {
		profileWindowMs: (profile.endTime - profile.startTime) / 1_000,
		sampledMs: sampledUs / 1_000,
		activeMs: (sampledUs - idleUs) / 1_000,
		idleMs: idleUs / 1_000,
		garbageCollectionMs: garbageCollectionUs / 1_000,
		samples: samples.length,
	};
}

function benchmarkUrl(path, nonce) {
	const url = new URL(path, BASE);
	url.searchParams.set("__emdash_cpu", nonce);
	return url;
}

async function hit(path, nonce) {
	const response = await fetch(benchmarkUrl(path, nonce), {
		headers: {
			accept: path === "/rss.xml" ? "application/rss+xml" : "text/html",
		},
		redirect: "manual",
	});
	const body = await response.arrayBuffer();
	if (!response.ok) {
		throw new Error(
			`${path} returned ${response.status}: ${new TextDecoder().decode(body).slice(0, 200)}`,
		);
	}
	return body.byteLength;
}

function median(values) {
	const sorted = values.toSorted((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function medianAbsoluteDeviation(values) {
	const center = median(values);
	return median(values.map((value) => Math.abs(value - center)));
}

function queryCountFor(route, snapshot) {
	const pathname = new URL(route.path, BASE).pathname;
	return snapshot[`GET ${pathname} (warm)`];
}

function regression(results) {
	const points = results.filter((result) => Number.isFinite(result.queryCount));
	if (points.length < 2) return null;
	const meanX = points.reduce((sum, point) => sum + point.queryCount, 0) / points.length;
	const meanY = points.reduce((sum, point) => sum + point.cpuPerResponseMs, 0) / points.length;
	let numerator = 0;
	let denominatorX = 0;
	let denominatorY = 0;
	for (const point of points) {
		const dx = point.queryCount - meanX;
		const dy = point.cpuPerResponseMs - meanY;
		numerator += dx * dy;
		denominatorX += dx * dx;
		denominatorY += dy * dy;
	}
	const slope = denominatorX === 0 ? 0 : numerator / denominatorX;
	const correlation =
		denominatorX === 0 || denominatorY === 0
			? 0
			: numerator / Math.sqrt(denominatorX * denominatorY);
	return {
		correlation,
		rSquared: correlation * correlation,
		slopeMsPerQuery: slope,
		interceptMs: meanY - slope * meanX,
	};
}

async function benchmarkRoute(route, options, outputDir, querySnapshot) {
	process.stdout.write(`\n${route.id} (${route.type}, ${route.path})\n`);
	const server = startServer();
	try {
		await server.ready;
		for (let i = 0; i < options.warmups; i++) {
			await hit(route.path, `warmup-${i}`);
		}

		const inspector = await InspectorClient.connect(await inspectorWebSocketUrl());
		try {
			await inspector.call("Profiler.enable");
			const batches = [];
			for (let batch = 0; batch < options.batches; batch++) {
				await inspector.call("Profiler.start");
				const wallStart = performance.now();
				let responseBytes = 0;
				for (let request = 0; request < options.requests; request++) {
					responseBytes += await hit(route.path, `${batch}-${request}`);
				}
				const wallMs = performance.now() - wallStart;
				const { profile } = await inspector.call("Profiler.stop");
				const profilePath = resolve(outputDir, `${route.id}-batch-${batch + 1}.cpuprofile`);
				writeFileSync(profilePath, JSON.stringify(profile));
				const summary = summarizeProfile(profile);
				const result = {
					batch: batch + 1,
					requests: options.requests,
					responseBytes,
					wallMs,
					cpuPerResponseMs: summary.activeMs / options.requests,
					gcPerResponseMs: summary.garbageCollectionMs / options.requests,
					...summary,
					profilePath,
				};
				batches.push(result);
				process.stdout.write(
					`  batch ${batch + 1}: ${result.cpuPerResponseMs.toFixed(3)}ms CPU/response (${summary.activeMs.toFixed(1)}ms active, ${summary.idleMs.toFixed(1)}ms idle)\n`,
				);
			}

			const cpuValues = batches.map((batch) => batch.cpuPerResponseMs);
			const gcValues = batches.map((batch) => batch.gcPerResponseMs);
			return {
				id: route.id,
				path: route.path,
				type: route.type,
				queryCount: queryCountFor(route, querySnapshot),
				cpuPerResponseMs: median(cpuValues),
				cpuMadMs: medianAbsoluteDeviation(cpuValues),
				gcPerResponseMs: median(gcValues),
				batches,
			};
		} finally {
			inspector.close();
		}
	} catch (error) {
		throw new Error(`${route.id} benchmark failed: ${error.message}\n${server.getOutput()}`, {
			cause: error,
		});
	} finally {
		await server.stop();
	}
}

function printSummary(results, fit) {
	process.stdout.write("\nRoute CPU baseline (median):\n");
	process.stdout.write("  route                queries   CPU/response   MAD       GC/response\n");
	for (const result of results) {
		process.stdout.write(
			`  ${result.id.padEnd(20)} ${String(result.queryCount ?? "?").padStart(7)}   ${result.cpuPerResponseMs.toFixed(3).padStart(9)}ms   ${result.cpuMadMs.toFixed(3).padStart(6)}ms   ${result.gcPerResponseMs.toFixed(3).padStart(9)}ms\n`,
		);
	}
	if (fit) {
		process.stdout.write(
			`\nAcross page types: r=${fit.correlation.toFixed(3)}, R²=${fit.rSquared.toFixed(3)}, slope=${fit.slopeMsPerQuery.toFixed(3)}ms CPU/query.\n`,
		);
		process.stdout.write("Treat this as descriptive: page complexity is a confounder.\n");
	}
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	const startedAt = new Date();
	if (!options.skipPrepare) runQueryCountPreparation();
	assertPreparedBuild();

	const querySnapshot = JSON.parse(readFileSync(querySnapshotPath, "utf8"));
	const selectedRoutes =
		options.routeIds.length === 0
			? ROUTES
			: ROUTES.filter((route) => options.routeIds.includes(route.id));
	const shortSha = spawnSync("git", ["rev-parse", "--short", "HEAD"], {
		cwd: repoRoot,
		encoding: "utf8",
	}).stdout.trim();
	const runStamp = startedAt.toISOString().replaceAll(/[-:.]/g, "");
	const outputDir =
		options.output ??
		resolve("/tmp", `emdash-render-cpu-${shortSha || "working-tree"}-${runStamp}`);
	mkdirSync(outputDir, { recursive: true });

	const results = [];
	for (const route of selectedRoutes) {
		results.push(await benchmarkRoute(route, options, outputDir, querySnapshot));
	}
	const fit = regression(results);
	const summary = {
		generatedAt: startedAt.toISOString(),
		gitSha: shortSha,
		workingTreeDirty:
			spawnSync("git", ["status", "--porcelain"], { cwd: repoRoot, encoding: "utf8" }).stdout.trim()
				.length > 0,
		runtime: {
			node: process.version,
			platform: platform(),
			osRelease: release(),
			arch: process.arch,
			cpu: cpus()[0]?.model,
		},
		options: {
			batches: options.batches,
			requests: options.requests,
			warmups: options.warmups,
		},
		regression: fit,
		results,
	};
	const summaryPath = resolve(outputDir, "summary.json");
	writeFileSync(summaryPath, JSON.stringify(summary, null, "\t") + "\n");
	printSummary(results, fit);
	process.stdout.write(`Profiles and summary: ${outputDir}\n`);
}

main().catch((error) => {
	process.stderr.write(`${error.stack ?? error.message ?? error}\n`);
	process.exit(1);
});
