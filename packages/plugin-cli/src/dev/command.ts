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
 *   - Serialises builds: if a change arrives while one is in flight,
 *     a follow-up build is queued and runs after the current one
 *     completes. This prevents a slow earlier build from overwriting
 *     dist/ with stale output after a newer build has already
 *     finished.
 *   - SIGINT (Ctrl-C) waits for any in-flight build before closing
 *     the watcher and exits 0. A second signal during shutdown
 *     forces immediate exit so an impatient Ctrl-Ctrl-C still works.
 *
 * Known limitation: the build pipeline's probe step dynamically
 * imports the freshly-built plugin module to harvest hook/route names.
 * Each probe goes to a unique temp file, and Node's ESM loader caches
 * modules by URL with no eviction. Across many rebuilds the loader's
 * cache grows monotonically (each leaked module is small — kilobytes —
 * but the count is unbounded). Restart `dev` after long sessions; a
 * future refactor will harvest the surface via AST instead of import().
 */

import { isAbsolute, relative, resolve, sep } from "node:path";

import { defineCommand } from "citty";
import consola from "consola";
import pc from "picocolors";

import { BuildError, buildPlugin, type BuildLogger } from "../build/api.js";

const DEBOUNCE_MS = 150;
/**
 * Files / globs the watcher tracks for change events. Relative to the
 * plugin directory; chokidar's `cwd` option resolves them.
 */
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
		"out-dir": {
			type: "string",
			alias: "o",
			description: "Output directory (default: ./dist)",
			default: "dist",
		},
	},
	async run({ args }) {
		const { default: chokidar } = await import("chokidar");

		// Lifted out so scheduleRebuild can short-circuit any
		// post-Ctrl-C file events while the watcher is still draining.
		let shutdownStarted = false;

		const logger: BuildLogger = {
			start: (m) => consola.start(m),
			info: (m) => consola.info(m),
			success: (m) => consola.success(m),
			warn: (m) => consola.warn(m),
		};

		// Serialisation state. `pending` holds the in-flight build's
		// promise; `queued` is a single follow-up trigger label
		// (collapsing multiple-rebuilds-during-build into one). When
		// the current build settles, the queued trigger fires.
		let pending: Promise<void> | undefined;
		let queuedTrigger: string | undefined;

		const runBuild = async (label: string): Promise<void> => {
			const stamp = new Date().toLocaleTimeString();
			console.log();
			console.log(pc.dim(`── ${label} at ${stamp} ─────────────────────`));
			try {
				await buildPlugin({
					dir: args.dir,
					outDir: args["out-dir"],
					logger,
				});
			} catch (error) {
				if (error instanceof BuildError) {
					consola.error(`${pc.bold(error.code)}: ${error.message}`);
				} else {
					consola.error(error instanceof Error ? error.message : String(error));
				}
				consola.info(
					pc.dim("Last successful build (if any) is still in dist/. Waiting for changes..."),
				);
			}
		};

		/**
		 * Schedule a build. If one's running, queue the trigger so we
		 * rebuild after it finishes; the queued trigger is collapsed
		 * (only the most recent change label survives). Otherwise
		 * starts immediately and tracks the promise in `pending` so
		 * subsequent triggers know to queue.
		 */
		const startBuild = (label: string): void => {
			if (pending) {
				queuedTrigger = label;
				return;
			}
			pending = (async () => {
				// try/finally so state always clears even if a future
				// runBuild throws past its own catch (e.g. logger
				// write error during shutdown). A stuck `pending`
				// would deadlock the watcher.
				try {
					let currentLabel = label;
					while (currentLabel) {
						await runBuild(currentLabel);
						currentLabel = queuedTrigger ?? "";
						queuedTrigger = undefined;
					}
				} finally {
					pending = undefined;
					queuedTrigger = undefined;
				}
			})();
		};

		// Initial build before starting the watcher. If it fails the
		// watcher still starts so the author can fix the error and
		// re-trigger. Run synchronously so the user sees the result
		// before we print "Watching".
		await runBuild("initial build");

		// Resolve outDir relative to the plugin dir so the ignore
		// pattern matches whatever the user passed for `--out-dir`.
		// chokidar wants forward-slash globs even on Windows, so
		// normalise the platform separator (path.sep) to "/".
		const resolvedOutDir = resolve(args.dir, args["out-dir"]);
		const cwdAbs = resolve(args.dir);
		const outDirRel = relative(cwdAbs, resolvedOutDir);
		// `outDirGlob` is the ignore pattern only when outDir is
		// strictly inside the watched dir. `relative` returns "" when
		// the two paths are equal (outDir === plugin root, which would
		// be pathological — would write plugin.mjs / manifest.json
		// next to src/ and the watcher would loop). Empty string and
		// upward / absolute paths fall through to `undefined`.
		const outDirGlob =
			outDirRel && !outDirRel.startsWith("..") && !isAbsolute(outDirRel)
				? `${outDirRel.split(sep).join("/")}/**`
				: undefined;

		const ignored = ["**/node_modules/**", ...(outDirGlob ? [outDirGlob] : [])];

		const watcher = chokidar.watch(WATCH_GLOBS, {
			cwd: args.dir,
			ignoreInitial: true,
			ignored,
		});

		let timer: NodeJS.Timeout | undefined;
		let pendingTrigger: string | undefined;

		const scheduleRebuild = (path: string) => {
			if (shutdownStarted) return;
			pendingTrigger = path;
			if (timer) clearTimeout(timer);
			timer = setTimeout(() => {
				const trigger = pendingTrigger ?? "change";
				pendingTrigger = undefined;
				timer = undefined;
				startBuild(`rebuild (${trigger})`);
			}, DEBOUNCE_MS);
		};

		watcher.on("add", scheduleRebuild);
		watcher.on("change", scheduleRebuild);
		watcher.on("unlink", scheduleRebuild);
		watcher.on("error", (error) => {
			consola.error(`Watcher error: ${error instanceof Error ? error.message : String(error)}`);
		});

		consola.info(`Watching ${pc.cyan(args.dir)} for changes (Ctrl-C to stop)`);

		// Shutdown waits for the in-flight build (if any) so the user
		// doesn't end up with a torn dist/. A second SIGINT during
		// shutdown forces immediate exit — impatience is a valid
		// signal.
		await new Promise<void>((resolveOuter) => {
			const shutdown = () => {
				if (shutdownStarted) {
					consola.warn("Second interrupt — forcing exit.");
					process.exit(130);
				}
				shutdownStarted = true;
				consola.info("Stopping watcher (waiting for in-flight build)...");
				if (timer) clearTimeout(timer);
				queuedTrigger = undefined;
				const drainAndClose = async () => {
					// Close the watcher before draining `pending` so a
					// file change arriving during the wait can't queue
					// a new build the user already cancelled.
					await watcher.close();
					if (pending) {
						try {
							await pending;
						} catch {
							/* runBuild swallows its own errors */
						}
					}
					process.off("SIGINT", shutdown);
					process.off("SIGTERM", shutdown);
					resolveOuter();
				};
				void drainAndClose();
			};
			// Use `on` (not `once`) so a second signal during shutdown
			// hits the same handler and the impatience branch fires.
			process.on("SIGINT", shutdown);
			process.on("SIGTERM", shutdown);
		});
	},
});
