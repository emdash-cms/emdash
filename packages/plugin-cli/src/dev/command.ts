/**
 * `emdash-plugin dev`
 *
 * Watch mode wrapper around `buildPlugin`. Rebuilds the plugin
 * whenever `src/**`, `emdash-plugin.jsonc`, or `package.json` change.
 *
 * Behaviour:
 *
 *   - Logs a divider + timestamp + result per rebuild. Doesn't clear
 *     the screen — authors keep a scrollback of what happened.
 *   - On error, prints the BuildError's structured code + message.
 *     Does *not* wipe `dist/` — the last successful build stays on
 *     disk so a downstream site importing the plugin keeps working
 *     until the next successful rebuild.
 *   - Debounces rapid bursts (editors saving multiple files) at
 *     150ms so a single edit doesn't trigger several rebuilds.
 *   - SIGINT (Ctrl-C) closes the watcher cleanly and exits 0.
 *
 * Distinct from `build` only in that it loops + watches. The build
 * pipeline itself is identical.
 */

import { defineCommand } from "citty";
import consola from "consola";
import pc from "picocolors";

import { BuildError, buildPlugin, type BuildLogger } from "../build/api.js";

const DEBOUNCE_MS = 150;
const WATCH_GLOBS = ["src/**", "emdash-plugin.jsonc", "package.json"];

export const devCommand = defineCommand({
	meta: {
		name: "dev",
		description: "Watch a sandboxed plugin's sources and rebuild on change",
	},
	args: {
		dir: {
			type: "string",
			description: "Plugin directory (default: current directory)",
			default: process.cwd(),
		},
		outDir: {
			type: "string",
			alias: "o",
			description: "Output directory (default: ./dist)",
			default: "dist",
		},
	},
	async run({ args }) {
		const { default: chokidar } = await import("chokidar");

		const logger: BuildLogger = {
			start: (m) => consola.start(m),
			info: (m) => consola.info(m),
			success: (m) => consola.success(m),
			warn: (m) => consola.warn(m),
		};

		const buildOnce = async (label: string): Promise<void> => {
			const stamp = new Date().toLocaleTimeString();
			console.log();
			console.log(pc.dim(`── ${label} at ${stamp} ─────────────────────`));
			try {
				await buildPlugin({
					dir: args.dir,
					outDir: args.outDir,
					logger,
				});
			} catch (error) {
				if (error instanceof BuildError) {
					consola.error(`${pc.bold(error.code)}: ${error.message}`);
				} else {
					consola.error(error instanceof Error ? error.message : String(error));
				}
				consola.info(pc.dim("Last successful build (if any) is still in dist/. Waiting for changes..."));
			}
		};

		// Initial build before starting the watcher. If it fails the watcher
		// still starts so the author can fix the error and re-trigger.
		await buildOnce("initial build");

		const watcher = chokidar.watch(WATCH_GLOBS, {
			cwd: args.dir,
			ignoreInitial: true,
			// Don't watch our own output — it'd loop.
			ignored: ["dist/**", "**/node_modules/**"],
		});

		let timer: NodeJS.Timeout | undefined;
		let pendingTrigger: string | undefined;

		const scheduleRebuild = (path: string) => {
			pendingTrigger = path;
			if (timer) clearTimeout(timer);
			timer = setTimeout(() => {
				const trigger = pendingTrigger ?? "change";
				pendingTrigger = undefined;
				timer = undefined;
				void buildOnce(`rebuild (${trigger})`);
			}, DEBOUNCE_MS);
		};

		watcher.on("add", scheduleRebuild);
		watcher.on("change", scheduleRebuild);
		watcher.on("unlink", scheduleRebuild);
		watcher.on("error", (error) => {
			consola.error(`Watcher error: ${error instanceof Error ? error.message : String(error)}`);
		});

		consola.info(`Watching ${pc.cyan(args.dir)} for changes (Ctrl-C to stop)`);

		// SIGINT clean-up. Returns a promise that resolves when the user
		// interrupts so we keep the watcher alive until then.
		await new Promise<void>((resolve) => {
			const shutdown = () => {
				consola.info("Stopping watcher...");
				if (timer) clearTimeout(timer);
				void watcher.close().then(() => resolve());
			};
			process.once("SIGINT", shutdown);
			process.once("SIGTERM", shutdown);
		});
	},
});
