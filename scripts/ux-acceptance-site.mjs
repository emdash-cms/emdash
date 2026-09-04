#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	realpathSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const RUNS_DIR = join(ROOT, "acceptance", "runs");
const CURRENT_RUN_PATH = join(RUNS_DIR, "current");
const PROFILE_NAME_PATTERN = /^[a-z][a-z0-9-]*$/;
const RUN_ID_PATTERN = /^\d{8}T\d{6}-[a-f0-9]{6}$/;
const ADMIN_DIST_MARKERS = [
	join(ROOT, "packages", "admin", "dist", "index.js"),
	join(ROOT, "packages", "admin", "dist", "locales", "index.js"),
	join(ROOT, "packages", "admin", "dist", "styles.css"),
];

const TARGETS = {
	node: {
		fixtureDir: join(ROOT, "e2e", "fixture"),
		buildFilter: "emdash-e2e-fixture...",
		buildMarkers: [
			join(ROOT, "packages", "core", "dist", "cli", "index.mjs"),
			...ADMIN_DIST_MARKERS,
		],
		startupTimeoutMs: 60_000,
		usesTempDatabase: true,
	},
	cloudflare: {
		fixtureDir: join(ROOT, "e2e", "fixture-cloudflare"),
		buildFilter: "emdash-e2e-fixture-cloudflare...",
		buildMarkers: [
			join(ROOT, "packages", "core", "dist", "cli", "index.mjs"),
			join(ROOT, "packages", "cloudflare", "dist", "index.mjs"),
			...ADMIN_DIST_MARKERS,
		],
		startupTimeoutMs: 120_000,
		usesTempDatabase: false,
	},
};

function usage() {
	process.stdout.write(`Usage:
  pnpm ux:site:start -- --target <node|cloudflare> --profile <name>
  pnpm ux:site:status
  pnpm ux:site:stop [-- <run-id>]

Defaults: --target node --profile editorial-small
`);
}

function parseStartOptions(args) {
	const options = { target: "node", profile: "editorial-small" };

	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg === "--target" || arg === "--profile") {
			const value = args[index + 1];
			if (!value) throw new Error(`${arg} requires a value`);
			options[arg.slice(2)] = value;
			index++;
			continue;
		}
		throw new Error(`Unknown option: ${arg}`);
	}

	return options;
}

function runPath(runId) {
	if (!RUN_ID_PATTERN.test(runId)) throw new Error(`Invalid run id: ${runId}`);
	return join(RUNS_DIR, runId, "run.json");
}

function readRun(runId) {
	const path = runPath(runId);
	if (!existsSync(path)) throw new Error(`Acceptance run not found: ${runId}`);
	return JSON.parse(readFileSync(path, "utf8"));
}

function writeRun(run) {
	writeFileSync(runPath(run.id), `${JSON.stringify(run, null, 2)}\n`);
}

function currentRunId() {
	if (!existsSync(CURRENT_RUN_PATH)) return undefined;
	const runId = readFileSync(CURRENT_RUN_PATH, "utf8").trim();
	return runId || undefined;
}

function processIsAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		if (error && typeof error === "object" && error.code === "EPERM") return true;
		return false;
	}
}

function processCommand(pid) {
	try {
		return execFileSync("ps", ["-p", String(pid), "-o", "command="], {
			encoding: "utf8",
		}).trim();
	} catch {
		return "";
	}
}

function assertExpectedProcess(run) {
	const command = processCommand(run.pid);
	if (!command.includes("astro") || !command.includes(String(run.port))) {
		throw new Error(
			`Refusing to stop PID ${run.pid}: it is not the recorded Astro process for port ${run.port}`,
		);
	}
}

function astroBinary(fixtureDir) {
	return join(fixtureDir, "node_modules", ".bin", "astro");
}

function readAstroLock(fixtureDir) {
	const path = join(fixtureDir, ".astro", "dev.json");
	if (!existsSync(path)) return undefined;
	try {
		const lock = JSON.parse(readFileSync(path, "utf8"));
		if (
			typeof lock.pid !== "number" ||
			typeof lock.port !== "number" ||
			typeof lock.url !== "string"
		) {
			return undefined;
		}
		return lock;
	} catch {
		return undefined;
	}
}

function assertNoExistingAstroServer(fixtureDir) {
	const lock = readAstroLock(fixtureDir);
	if (lock && processIsAlive(lock.pid)) {
		throw new Error(
			`Astro is already running for ${fixtureDir} at ${lock.url} (PID ${lock.pid}). Stop it before starting an acceptance site.`,
		);
	}
}

function terminateRunProcess(run) {
	if (!processIsAlive(run.pid)) return;
	const lock = readAstroLock(run.fixtureDir);
	if (!lock || lock.pid !== run.pid || lock.port !== run.port) {
		throw new Error(`Refusing to stop PID ${run.pid}: Astro's lock does not match this run`);
	}
	assertExpectedProcess(run);
	execFileSync(astroBinary(run.fixtureDir), ["dev", "stop"], {
		cwd: run.fixtureDir,
		stdio: "pipe",
		timeout: 10_000,
	});
	if (processIsAlive(run.pid)) throw new Error(`Astro did not stop PID ${run.pid}`);
}

function cleanFixtureState(fixtureDir) {
	for (const name of [".astro", ".wrangler"]) {
		rmSync(join(fixtureDir, name), { recursive: true, force: true });
	}

	const emdashDir = join(fixtureDir, ".emdash");
	if (!existsSync(emdashDir)) return;
	for (const entry of readdirSync(emdashDir)) {
		if (entry === "seed.json") continue;
		rmSync(join(emdashDir, entry), { recursive: true, force: true });
	}
}

function cleanTempDirectory(path) {
	if (!path || !existsSync(path)) return;
	const resolvedPath = realpathSync(path);
	const expectedPrefix = join(realpathSync(tmpdir()), "emdash-ux-site-");
	if (!resolvedPath.startsWith(expectedPrefix)) {
		throw new Error(`Refusing to remove unexpected temporary path: ${path}`);
	}
	rmSync(resolvedPath, { recursive: true, force: true });
}

function removeCurrentPointer(runId) {
	if (currentRunId() === runId) unlinkSync(CURRENT_RUN_PATH);
}

function archiveServerLog(run) {
	const nativeLogPath = join(run.fixtureDir, ".astro", "dev.log");
	if (!existsSync(nativeLogPath)) return;
	const archivedLogPath = join(RUNS_DIR, run.id, "server.log");
	copyFileSync(nativeLogPath, archivedLogPath);
	run.logPath = archivedLogPath;
}

function stopRun(run, status = "stopped") {
	terminateRunProcess(run);
	archiveServerLog(run);
	cleanTempDirectory(run.tempDataDir);
	cleanFixtureState(run.fixtureDir);
	run.status = status;
	run.stoppedAt = new Date().toISOString();
	writeRun(run);
	removeCurrentPointer(run.id);
}

function loadProfile(name) {
	if (!PROFILE_NAME_PATTERN.test(name)) throw new Error(`Invalid profile name: ${name}`);
	const path = join(ROOT, "acceptance", "sites", `${name}.json`);
	if (!existsSync(path)) throw new Error(`Unknown site profile: ${name}`);
	const profile = JSON.parse(readFileSync(path, "utf8"));

	if (!profile.description || !["none", "dev-bypass"].includes(profile.setup)) {
		throw new Error(`Invalid site profile: ${name}`);
	}
	if (
		typeof profile.startPath !== "string" ||
		!profile.startPath.startsWith("/") ||
		profile.startPath.startsWith("//")
	) {
		throw new Error(`Invalid startPath in site profile: ${name}`);
	}

	return profile;
}

function ensureBuilt(target) {
	if (target.buildMarkers.every((path) => existsSync(path))) return;
	process.stdout.write(`Building ${target.buildFilter} dependency closure...\n`);
	execFileSync("pnpm", ["run", "--filter", target.buildFilter, "build"], {
		cwd: ROOT,
		stdio: "inherit",
		timeout: 180_000,
	});
}

function availablePort() {
	return new Promise((resolvePort, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (!address || typeof address === "string") {
				server.close();
				reject(new Error("Could not allocate a local port"));
				return;
			}
			server.close((error) => {
				if (error) reject(error);
				else resolvePort(address.port);
			});
		});
	});
}

async function waitForOk(url, pid, timeoutMs, headers) {
	const startedAt = Date.now();
	let lastStatus = 0;
	let lastBody = "";

	while (Date.now() - startedAt < timeoutMs) {
		if (!processIsAlive(pid)) throw new Error("Astro exited before the site became ready");
		try {
			const response = await fetch(url, {
				headers,
				signal: AbortSignal.timeout(5000),
			});
			if (response.ok) return response;
			lastStatus = response.status;
			lastBody = await response.text().catch(() => "");
		} catch {}
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
	}

	throw new Error(
		`${url} did not become ready within ${timeoutMs}ms (last ${lastStatus}): ${lastBody.slice(0, 200)}`,
	);
}

function newRunId() {
	const timestamp = new Date().toISOString().replaceAll(/[-:]/g, "").slice(0, 15);
	return `${timestamp}-${randomBytes(3).toString("hex")}`;
}

function gitRevision() {
	return execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
}

async function startSite(args) {
	mkdirSync(RUNS_DIR, { recursive: true });
	const existingRunId = currentRunId();
	if (existingRunId) {
		const existingRun = readRun(existingRunId);
		if (processIsAlive(existingRun.pid)) {
			throw new Error(
				`Acceptance run ${existingRun.id} is still active. Stop it before starting another site.`,
			);
		}
		existingRun.status = "stale";
		existingRun.stoppedAt = new Date().toISOString();
		writeRun(existingRun);
		removeCurrentPointer(existingRun.id);
	}

	const options = parseStartOptions(args);
	const target = TARGETS[options.target];
	if (!target) throw new Error(`Unknown target: ${options.target}`);
	const profile = loadProfile(options.profile);

	ensureBuilt(target);
	assertNoExistingAstroServer(target.fixtureDir);
	cleanFixtureState(target.fixtureDir);

	const runId = newRunId();
	const runDir = join(RUNS_DIR, runId);
	mkdirSync(runDir, { recursive: true });
	const tempDataDir = target.usesTempDatabase
		? mkdtempSync(join(tmpdir(), "emdash-ux-site-"))
		: undefined;
	const port = await availablePort();
	const baseUrl = `http://127.0.0.1:${port}`;
	const environment = {
		...process.env,
		...(tempDataDir ? { EMDASH_TEST_DB: `file:${join(tempDataDir, "test.db")}` } : {}),
		WRANGLER_LOG_PATH: join(runDir, "wrangler.log"),
	};
	const startOutput = execFileSync(
		astroBinary(target.fixtureDir),
		["dev", "--background", "--host", "127.0.0.1", "--port", String(port)],
		{
			cwd: target.fixtureDir,
			encoding: "utf8",
			env: environment,
			timeout: target.startupTimeoutMs,
		},
	);
	writeFileSync(join(runDir, "launcher.log"), startOutput);
	const astroLock = readAstroLock(target.fixtureDir);
	if (!astroLock || astroLock.port !== port || !processIsAlive(astroLock.pid)) {
		cleanTempDirectory(tempDataDir);
		throw new Error("Astro background mode did not create the expected live server lock");
	}

	const run = {
		id: runId,
		status: "starting",
		startedAt: new Date().toISOString(),
		gitRevision: gitRevision(),
		target: options.target,
		profile: options.profile,
		profileDescription: profile.description,
		pid: astroLock.pid,
		port,
		baseUrl,
		fixtureDir: target.fixtureDir,
		tempDataDir,
		logPath: join(target.fixtureDir, ".astro", "dev.log"),
	};
	writeRun(run);
	writeFileSync(CURRENT_RUN_PATH, `${runId}\n`);

	try {
		await waitForOk(`${baseUrl}/_emdash/api/setup/status`, run.pid, target.startupTimeoutMs);

		if (profile.setup === "dev-bypass") {
			const setupUrl = new URL("/_emdash/api/setup/dev-bypass", baseUrl);
			setupUrl.searchParams.set("token", "1");
			if (!profile.includeContent) setupUrl.searchParams.set("content", "0");
			const setupResponse = await fetch(setupUrl, {
				signal: AbortSignal.timeout(target.startupTimeoutMs),
			});
			if (!setupResponse.ok) {
				throw new Error(
					`Dev bypass failed (${setupResponse.status}): ${(await setupResponse.text()).slice(0, 300)}`,
				);
			}
			const setupResult = await setupResponse.json();
			run.token = setupResult.data?.token;
			if (!run.token) throw new Error("Dev bypass did not return an API token");

			const headers = { Authorization: `Bearer ${run.token}` };
			for (const path of [
				"/_emdash/api/schema/collections?includeFields=true",
				"/_emdash/api/media",
			]) {
				await waitForOk(`${baseUrl}${path}`, run.pid, 60_000, headers);
			}

			const authUrl = new URL("/_emdash/api/auth/dev-bypass", baseUrl);
			authUrl.searchParams.set("redirect", profile.startPath);
			run.startUrl = authUrl.toString();
		} else {
			run.startUrl = new URL(profile.startPath, baseUrl).toString();
		}

		run.status = "ready";
		run.readyAt = new Date().toISOString();
		writeRun(run);
	} catch (error) {
		run.error = error instanceof Error ? error.message : String(error);
		stopRun(run, "failed");
		throw error;
	}

	process.stdout.write(`Acceptance site ready.

Run:       ${run.id}
Target:    ${run.target}
Profile:   ${run.profile}
Start URL: ${run.startUrl}
Run data:  ${runPath(run.id)}
Server log:${run.logPath}

Stop it with:
  pnpm ux:site:stop -- ${run.id}
`);
}

async function stopSite(args) {
	const requestedRunId = args[0];
	if (args.length > 1) throw new Error("Stop accepts at most one run id");
	const activeRunId = currentRunId();
	if (!activeRunId) throw new Error("No active acceptance run was found");
	if (requestedRunId && requestedRunId !== activeRunId) {
		throw new Error(
			`Run ${requestedRunId} is not active. The active acceptance run is ${activeRunId}.`,
		);
	}
	const run = readRun(activeRunId);
	stopRun(run);
	process.stdout.write(
		`Stopped acceptance run ${run.id}. Artifacts remain in ${join(RUNS_DIR, run.id)}\n`,
	);
}

function siteStatus() {
	const runId = currentRunId();
	if (!runId) {
		process.stdout.write("No acceptance site is active.\n");
		return;
	}
	const run = readRun(runId);
	const alive = processIsAlive(run.pid);
	const astroLock = readAstroLock(run.fixtureDir);
	const { token: _token, ...status } = run;
	process.stdout.write(`${JSON.stringify({ ...status, alive, astroLock }, null, 2)}\n`);
}

async function main() {
	const [command = "help", ...args] = process.argv.slice(2).filter((arg) => arg !== "--");
	if (command === "start" && args.some((arg) => ["--help", "-h"].includes(arg))) usage();
	else if (command === "start") await startSite(args);
	else if (command === "stop") await stopSite(args);
	else if (command === "status") siteStatus();
	else if (command === "help" || command === "--help" || command === "-h") usage();
	else throw new Error(`Unknown command: ${command}`);
}

main().catch((error) => {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
});
