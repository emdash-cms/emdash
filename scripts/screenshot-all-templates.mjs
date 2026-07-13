#!/usr/bin/env node

/**
 * Screenshot all templates by starting each dev server, capturing screenshots, and stopping.
 *
 * Usage:
 *   node scripts/screenshot-all-templates.mjs [template...]
 *   node scripts/screenshot-all-templates.mjs           # all templates
 *   node scripts/screenshot-all-templates.mjs blog      # just blog
 *   node scripts/screenshot-all-templates.mjs blog marketing  # blog and marketing
 */

import { spawn, execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

const TEMPLATES = {
	blog: { dir: "templates/blog", port: 4321 },
	marketing: { dir: "templates/marketing", port: 4322 },
	portfolio: { dir: "templates/portfolio", port: 4323 },
	"service-business": { dir: "templates/service-business", port: 4324 },
};

function loadConfig() {
	const configPath = join(ROOT, "templates", "screenshots.json");
	return JSON.parse(readFileSync(configPath, "utf-8"));
}

/** Check if server is responding via HTTP */
async function isServerReady(port) {
	try {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 2000);
		const response = await fetch(`http://localhost:${port}/`, {
			signal: controller.signal,
		});
		clearTimeout(timeout);
		return response.ok || response.status === 404; // 404 is fine, server is up
	} catch {
		return false;
	}
}

/** Wait for server to respond, with timeout */
async function waitForServer(port, timeoutMs = 60000) {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (await isServerReady(port)) {
			return true;
		}
		await new Promise((r) => setTimeout(r, 500));
	}
	return false;
}

/** Check if port has processes (via lsof) */
function hasProcessOnPort(port) {
	try {
		const result = execSync(`lsof -ti tcp:${port} 2>/dev/null || true`, { encoding: "utf-8" });
		return result.trim().length > 0;
	} catch {
		return false;
	}
}

/** Wait for port to be free */
async function waitForPortFree(port, timeoutMs = 10000) {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (!hasProcessOnPort(port)) {
			return true;
		}
		await new Promise((r) => setTimeout(r, 200));
	}
	return false;
}

/** Kill all processes listening on a port (macOS/Linux) */
function killProcessesOnPort(port) {
	try {
		// Get PIDs listening on this port
		const result = execSync(`lsof -ti tcp:${port} 2>/dev/null || true`, { encoding: "utf-8" });
		const pids = result
			.trim()
			.split("\n")
			.filter((p) => p);

		for (const pid of pids) {
			try {
				process.kill(Number(pid), "SIGTERM");
			} catch {
				// Process may already be dead
			}
		}

		// If still running after 2s, force kill
		if (pids.length > 0) {
			setTimeout(() => {
				for (const pid of pids) {
					try {
						process.kill(Number(pid), "SIGKILL");
					} catch {
						// Process may already be dead
					}
				}
			}, 2000);
		}
	} catch {
		// lsof may not be available or no processes found
	}
}

function startDevServer(templateDir, port) {
	return new Promise((resolve, reject) => {
		// Run astro dev directly in the template directory
		const proc = spawn("pnpm", ["exec", "astro", "dev", "--port", String(port)], {
			cwd: join(ROOT, templateDir),
			stdio: ["ignore", "pipe", "pipe"],
			detached: false,
		});

		let output = "";

		const onData = (data) => {
			output += data.toString();
			process.stdout.write(data); // Show output for debugging
		};

		proc.stdout.on("data", onData);
		proc.stderr.on("data", onData);

		proc.on("error", (err) => {
			reject(err);
		});

		proc.on("exit", (code) => {
			// If process exits before we resolve, that's an error
			reject(new Error(`Dev server exited with code ${code}`));
		});

		// Wait for server to respond via HTTP
		waitForServer(port, 60000)
			.then((ready) => {
				if (ready) {
					// Remove exit handler since we're resolving successfully
					proc.removeAllListeners("exit");
					// Re-add a silent exit handler
					proc.on("exit", () => {});
					resolve({ proc, port });
				} else {
					proc.kill();
					reject(new Error(`Timeout waiting for server on port ${port}`));
				}
				return undefined;
			})
			.catch(reject);
	});
}

function runScreenshots(template, url) {
	return new Promise((resolve, reject) => {
		const proc = spawn("node", [join(ROOT, "scripts", "screenshot-templates.mjs"), template, url], {
			cwd: ROOT,
			stdio: "inherit",
		});

		proc.on("error", reject);
		proc.on("exit", (code) => {
			if (code === 0) {
				resolve();
			} else {
				reject(new Error(`Screenshot script exited with code ${code}`));
			}
		});
	});
}

async function stopDevServer({ proc, port }) {
	// Kill the process tree
	try {
		proc.kill("SIGTERM");
	} catch {
		// May already be dead
	}

	// Also kill anything on the port (catches child processes)
	killProcessesOnPort(port);

	// Wait for port to actually be free
	const closed = await waitForPortFree(port, 10000);
	if (!closed) {
		console.warn(`Warning: Port ${port} still in use after stopping server`);
		// Force kill anything still on the port
		killProcessesOnPort(port);
		await waitForPortFree(port, 5000);
	}
}

/** Run bootstrap (reset db and seed) for a template */
async function bootstrapTemplate(templateDir) {
	return new Promise((resolve, reject) => {
		console.log(`Bootstrapping ${templateDir}...`);
		const proc = spawn("pnpm", ["bootstrap"], {
			cwd: join(ROOT, templateDir),
			stdio: "inherit",
		});

		proc.on("error", reject);
		proc.on("exit", (code) => {
			if (code === 0) {
				resolve();
			} else {
				reject(new Error(`Bootstrap exited with code ${code}`));
			}
		});
	});
}

async function processTemplate(template) {
	const config = TEMPLATES[template];
	if (!config) {
		console.error(`Unknown template: ${template}`);
		console.error(`Available: ${Object.keys(TEMPLATES).join(", ")}`);
		return false;
	}

	const screenshotsConfig = loadConfig();
	if (!screenshotsConfig[template]) {
		console.error(`No screenshot config for template: ${template}`);
		return false;
	}

	// Make sure port is free before starting
	if (hasProcessOnPort(config.port)) {
		console.log(`Port ${config.port} is in use, killing existing processes...`);
		killProcessesOnPort(config.port);
		await waitForPortFree(config.port, 5000);
	}

	console.log(`\n${"=".repeat(60)}`);
	console.log(`${template} (${config.dir})`);
	console.log("=".repeat(60));

	let server;
	try {
		// Bootstrap first to ensure database has seed content
		await bootstrapTemplate(config.dir);

		console.log(`Starting dev server...`);
		server = await startDevServer(config.dir, config.port);
		console.log(`Dev server ready at http://localhost:${config.port}\n`);

		await runScreenshots(template, `http://localhost:${config.port}`);
		return true;
	} catch (err) {
		console.error(`Failed to process ${template}:`, err.message);
		return false;
	} finally {
		if (server) {
			console.log(`Stopping ${template} dev server...`);
			await stopDevServer(server);
			// Extra pause to ensure cleanup
			await new Promise((r) => setTimeout(r, 1000));
		}
	}
}

async function run() {
	const args = process.argv.slice(2);
	const templates = args.length > 0 ? args : Object.keys(TEMPLATES);

	// Validate all templates first
	for (const template of templates) {
		if (!TEMPLATES[template]) {
			console.error(`Unknown template: ${template}`);
			console.error(`Available: ${Object.keys(TEMPLATES).join(", ")}`);
			process.exit(1);
		}
	}

	console.log(`\nScreenshotting templates: ${templates.join(", ")}`);

	const results = { success: [], failed: [] };

	for (const template of templates) {
		const success = await processTemplate(template);
		if (success) {
			results.success.push(template);
		} else {
			results.failed.push(template);
		}
	}

	console.log(`\n${"=".repeat(60)}`);
	console.log("Summary");
	console.log("=".repeat(60));

	if (results.success.length > 0) {
		console.log(`Succeeded: ${results.success.join(", ")}`);
	}
	if (results.failed.length > 0) {
		console.log(`Failed: ${results.failed.join(", ")}`);
		process.exit(1);
	}
}

run().catch((err) => {
	console.error(err);
	process.exit(1);
});
