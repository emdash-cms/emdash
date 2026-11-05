/** The integration fixture built with co-editing on, and its servers in each Node.js mode. */

import { execFile, spawn } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync } from "node:fs";
import { createServer } from "node:net";
import { join, resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { ensureBuilt } from "../integration/server.js";
import { consumerEnvironment } from "../utils/consumer-environment.js";
import { get } from "./helpers.js";

const execAsync = promisify(execFile);
const INTEGRATION_DIR = resolvePath(import.meta.dirname, "../integration");
const FIXTURE_DIR = join(INTEGRATION_DIR, "fixture");
const SERVERS_BASE = join(INTEGRATION_DIR, ".servers");
const DONOR_NODE_MODULES = resolvePath(
	import.meta.dirname,
	"../../../../demos/simple/node_modules",
);
const CLI_BIN = resolvePath(import.meta.dirname, "../../dist/cli/index.mjs");
const FONT_PROVIDER = pathToFileURL(join(INTEGRATION_DIR, "smoke/smoke-font-provider.mjs")).href;
const MIDDLEWARE_SERVER = resolvePath(import.meta.dirname, "middleware-server.mjs");

/**
 * Copies the fixture into the repository, as `createTestServer` does, prepares its database and
 * builds it with co-editing on.
 */
export async function buildFixture(env: Record<string, string> = {}): Promise<string> {
	await ensureBuilt();
	mkdirSync(SERVERS_BASE, { recursive: true });
	const dir = mkdtempSync(join(SERVERS_BASE, "hosts-"));
	cpSync(FIXTURE_DIR, dir, {
		recursive: true,
		filter: (source) => !source.split(/[\\/]/).includes("node_modules"),
	});
	symlinkSync(DONOR_NODE_MODULES, join(dir, "node_modules"));
	const database = join(dir, "site.db");
	await execAsync(process.execPath, [CLI_BIN, "init", "--database", database, "--cwd", dir]);
	await execAsync(join(dir, "node_modules/.bin/astro"), ["build"], {
		cwd: dir,
		timeout: 180_000,
		env: consumerEnvironment({
			CI: "true",
			NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${FONT_PROVIDER}`]
				.filter(Boolean)
				.join(" "),
			EMDASH_TEST_CO_EDITING: "1",
			EMDASH_TEST_DB: `file:${database}`,
			EMDASH_TEST_UPLOADS: join(dir, "uploads"),
			EMDASH_TEST_VITE_CACHE: join(dir, ".vite-cache"),
			...env,
		}),
	});
	return dir;
}

export async function freePort(): Promise<number> {
	const server = createServer();
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	await new Promise((resolve) => server.close(resolve));
	if (typeof address !== "object" || !address) throw new Error("No port");
	return address.port;
}

/** A self-signed certificate for `127.0.0.1`, or null where `openssl` isn't installed. */
export async function certificate(dir: string): Promise<{ key: string; cert: string } | null> {
	const key = join(dir, "key.pem");
	const cert = join(dir, "cert.pem");
	try {
		await execAsync("openssl", [
			"req",
			"-x509",
			"-newkey",
			"rsa:2048",
			"-nodes",
			"-days",
			"1",
			"-subj",
			"/CN=localhost",
			"-addext",
			"subjectAltName=IP:127.0.0.1",
			"-keyout",
			key,
			"-out",
			cert,
		]);
	} catch {
		return null;
	}
	return { key, cert };
}

export interface RunningServer {
	origin: string;
	/** The certificate to trust, over HTTPS. */
	ca?: string;
	output(): string;
	stop(): Promise<void>;
}

export type ServerMode = "standalone" | "preview" | "middleware";

/** Starts a built fixture's server and waits until it answers a request outside EmDash. */
export async function startServer(
	dir: string,
	mode: ServerMode,
	options: { tls?: { key: string; cert: string } } = {},
): Promise<RunningServer> {
	const port = await freePort();
	const origin = `${options.tls ? "https" : "http"}://127.0.0.1:${port}`;
	const entry = join(dir, "dist/server/entry.mjs");
	const command: Record<ServerMode, [string, string[]]> = {
		standalone: [process.execPath, [entry]],
		preview: [
			join(dir, "node_modules/.bin/astro"),
			["preview", "--host", "127.0.0.1", "--port", `${port}`],
		],
		middleware: [process.execPath, [MIDDLEWARE_SERVER, pathToFileURL(entry).href]],
	};
	const [file, args] = command[mode];
	const child = spawn(file, args, {
		cwd: dir,
		stdio: ["ignore", "pipe", "pipe"],
		env: consumerEnvironment({
			HOST: "127.0.0.1",
			PORT: `${port}`,
			...(options.tls
				? { SERVER_KEY_PATH: options.tls.key, SERVER_CERT_PATH: options.tls.cert }
				: {}),
		}),
	});
	let output = "";
	child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
	child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
	const exited = new Promise<void>((resolve) => child.on("close", () => resolve()));
	const server: RunningServer = {
		origin,
		ca: options.tls ? readFileSync(options.tls.cert, "utf8") : undefined,
		output: () => output,
		async stop() {
			child.kill("SIGTERM");
			await exited;
		},
	};
	const deadline = Date.now() + 60_000;
	for (;;) {
		try {
			await get(`${origin}/favicon.ico`, server.ca);
			return server;
		} catch (error) {
			if (Date.now() > deadline || child.exitCode !== null || child.signalCode !== null) {
				await server.stop();
				throw new Error(`The ${mode} server didn't start:\n${output}`, { cause: error });
			}
			await new Promise((resolve) => setTimeout(resolve, 250));
		}
	}
}
