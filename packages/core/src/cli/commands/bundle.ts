/**
 * emdash plugin bundle
 *
 * Produces a publishable plugin tarball from a plugin source directory.
 *
 * Steps:
 * 1. Resolve plugin entrypoint (finds definePlugin() export)
 * 2. Bundle backend code with tsdown → backend.js (single ES module, tree-shaken)
 * 3. Bundle admin code if present → admin.js
 * 4. Extract manifest from definePlugin() → manifest.json
 * 5. Collect assets (README.md, icon.png, screenshots/)
 * 6. Validate bundle (manifest schema, size limits, no Node.js builtins)
 * 7. Create tarball ({id}-{version}.tar.gz)
 */

import { createHash } from "node:crypto";
import { readFile, stat, mkdir, writeFile, rm, copyFile, symlink, readdir } from "node:fs/promises";
import { resolve, join, extname, basename } from "node:path";

import { defineCommand } from "citty";
import consola from "consola";

import type { ResolvedPlugin } from "../../plugins/types.js";
import {
	fileExists,
	readImageDimensions,
	extractManifest,
	findNodeBuiltinImports,
	findBuildOutput,
	findSourceExports,
	resolveSourceEntry,
	calculateDirectorySize,
	createTarball,
	MAX_BUNDLE_SIZE,
	MAX_SCREENSHOTS,
	MAX_SCREENSHOT_WIDTH,
	MAX_SCREENSHOT_HEIGHT,
	ICON_SIZE,
} from "./bundle-utils.js";

const TS_EXT_RE = /\.tsx?$/;
const SLASH_RE = /\//g;
const LEADING_AT_RE = /^@/;
const emdash_SCOPE_RE = /^@emdash-cms\//;

export const bundleCommand = defineCommand({
	meta: {
		name: "bundle",
		description: "Bundle a plugin for marketplace distribution",
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
			description: "Output directory for the tarball (default: ./dist)",
			default: "dist",
		},
		validateOnly: {
			type: "boolean",
			description: "Run validation only, skip tarball creation",
			default: false,
		},
	},
	async run({ args }) {
		const pluginDir = resolve(args.dir);
		const outDir = resolve(pluginDir, args.outDir);
		const validateOnly = args.validateOnly;

		consola.start(validateOnly ? "Validating plugin..." : "Bundling plugin...");

		// ── Step 1: Read package.json and resolve entrypoints ──

		const pkgPath = join(pluginDir, "package.json");
		if (!(await fileExists(pkgPath))) {
			consola.error("No package.json found in", pluginDir);
			process.exit(1);
		}

		const pkg = JSON.parse(await readFile(pkgPath, "utf-8")) as {
			name?: string;
			main?: string;
			exports?: Record<string, unknown>;
		};

		// Find the sandbox entrypoint — look for ./sandbox export first, then main
		let backendEntry: string | undefined;
		let adminEntry: string | undefined;

		if (pkg.exports) {
			// Check for explicit sandbox export
			const sandboxExport = pkg.exports["./sandbox"];
			if (typeof sandboxExport === "string") {
				backendEntry = await resolveSourceEntry(pluginDir, sandboxExport);
			} else if (sandboxExport && typeof sandboxExport === "object" && "import" in sandboxExport) {
				backendEntry = await resolveSourceEntry(
					pluginDir,
					(sandboxExport as { import: string }).import,
				);
			}

			// Check for admin export
			const adminExport = pkg.exports["./admin"];
			if (typeof adminExport === "string") {
				adminEntry = await resolveSourceEntry(pluginDir, adminExport);
			} else if (adminExport && typeof adminExport === "object" && "import" in adminExport) {
				adminEntry = await resolveSourceEntry(
					pluginDir,
					(adminExport as { import: string }).import,
				);
			}
		}

		// If no sandbox export, look for src/sandbox-entry.ts
		if (!backendEntry) {
			const defaultSandbox = join(pluginDir, "src/sandbox-entry.ts");
			if (await fileExists(defaultSandbox)) {
				backendEntry = defaultSandbox;
			}
		}

		// Find the main entry for manifest extraction
		let mainEntry: string | undefined;
		if (pkg.exports?.["."] !== undefined) {
			const mainExport = pkg.exports["."];
			if (typeof mainExport === "string") {
				mainEntry = await resolveSourceEntry(pluginDir, mainExport);
			} else if (mainExport && typeof mainExport === "object" && "import" in mainExport) {
				mainEntry = await resolveSourceEntry(pluginDir, (mainExport as { import: string }).import);
			}
		}
		if (!mainEntry && pkg.main) {
			mainEntry = await resolveSourceEntry(pluginDir, pkg.main);
		}
		if (!mainEntry) {
			const defaultMain = join(pluginDir, "src/index.ts");
			if (await fileExists(defaultMain)) {
				mainEntry = defaultMain;
			}
		}

		if (!mainEntry) {
			consola.error(
				"Cannot find plugin entrypoint. Expected src/index.ts or main/exports in package.json",
			);
			process.exit(1);
		}

		consola.info(`Main entry: ${mainEntry}`);
		if (backendEntry) consola.info(`Backend entry: ${backendEntry}`);
		if (adminEntry) consola.info(`Admin entry: ${adminEntry}`);

		// ── Step 2: Extract manifest by importing the plugin ──

		consola.start("Extracting plugin manifest...");

		// Build the main entry first so we can import it
		const { build } = await import("tsdown");
		const tmpDir = join(pluginDir, ".emdash-bundle-tmp");

		try {
			await mkdir(tmpDir, { recursive: true });

			// Build main entry to extract manifest.
			// Externalize emdash and sibling packages — they'll resolve
			// via the symlinked node_modules below.
			const mainOutDir = join(tmpDir, "main");
			await build({
				config: false,
				entry: [mainEntry],
				format: "esm",
				outDir: mainOutDir,
				dts: false,
				platform: "node",
				external: ["emdash", emdash_SCOPE_RE],
			});

			// Symlink plugin's node_modules so the built module can resolve
			// external dependencies (emdash, @emdash-cms/*, etc.)
			const pluginNodeModules = join(pluginDir, "node_modules");
			const tmpNodeModules = join(mainOutDir, "node_modules");
			if (await fileExists(pluginNodeModules)) {
				await symlink(pluginNodeModules, tmpNodeModules, "junction");
			}

			// Import the built module to get the resolved plugin
			const mainBaseName = basename(mainEntry).replace(TS_EXT_RE, "");
			const mainOutputPath = await findBuildOutput(mainOutDir, mainBaseName);

			if (!mainOutputPath) {
				consola.error("Failed to build main entry — no output found in", mainOutDir);
				process.exit(1);
			}

			// Dynamic import of the built plugin
			const pluginModule = (await import(mainOutputPath)) as Record<string, unknown>;

			// Extract manifest from the imported module.
			// Supports three patterns:
			//   1. Native: createPlugin() export -> ResolvedPlugin
			//   2. Native: default export that is/returns a ResolvedPlugin (has id+version)
			//   3. Standard: descriptor factory function (returns { id, version, ... })
			let resolvedPlugin: ResolvedPlugin | undefined;

			if (typeof pluginModule.createPlugin === "function") {
				resolvedPlugin = pluginModule.createPlugin() as ResolvedPlugin;
			} else if (typeof pluginModule.default === "function") {
				resolvedPlugin = pluginModule.default() as ResolvedPlugin;
			} else if (typeof pluginModule.default === "object" && pluginModule.default !== null) {
				const defaultExport = pluginModule.default as Record<string, unknown>;
				if ("id" in defaultExport && "version" in defaultExport) {
					resolvedPlugin = defaultExport as ResolvedPlugin;
				}
			}

			// Standard format: no createPlugin, no default with id/version.
			// Look for a descriptor factory -- any named export function that
			// returns an object with { id, version }.
			if (!resolvedPlugin) {
				for (const [key, value] of Object.entries(pluginModule)) {
					if (key === "default" || typeof value !== "function") continue;
					try {
						const result = (value as () => unknown)() as Record<string, unknown> | null;
						if (result && typeof result === "object" && "id" in result && "version" in result) {
							resolvedPlugin = {
								id: result.id,
								version: result.version,
								capabilities: result.capabilities ?? [],
								allowedHosts: result.allowedHosts ?? [],
								storage: result.storage ?? {},
								hooks: {},
								routes: {},
								admin: {
									pages: result.adminPages,
									widgets: result.adminWidgets,
								},
							} as ResolvedPlugin;

							// If there's a sandbox entry, build and import it
							// to get hook/route names for the manifest.
							if (backendEntry) {
								const backendProbeDir = join(tmpDir, "backend-probe");
								const probeShimDir = join(tmpDir, "probe-shims");
								await mkdir(probeShimDir, { recursive: true });
								await writeFile(
									join(probeShimDir, "emdash.mjs"),
									"export const definePlugin = (d) => d;\n",
								);
								await build({
									config: false,
									entry: [backendEntry],
									format: "esm",
									outDir: backendProbeDir,
									dts: false,
									platform: "neutral",
									external: [],
									alias: { emdash: join(probeShimDir, "emdash.mjs") },
									treeshake: true,
								});
								const backendBaseName = basename(backendEntry).replace(TS_EXT_RE, "");
								const backendProbePath = await findBuildOutput(backendProbeDir, backendBaseName);
								if (backendProbePath) {
									const backendModule = (await import(backendProbePath)) as Record<string, unknown>;
									const standardDef = (backendModule.default ?? {}) as Record<string, unknown>;
									const hooks = standardDef.hooks as Record<string, unknown> | undefined;
									const routes = standardDef.routes as Record<string, unknown> | undefined;
									if (hooks) {
										for (const hookName of Object.keys(hooks)) {
											const hookEntry = hooks[hookName];
											const isConfig =
												typeof hookEntry === "object" &&
												hookEntry !== null &&
												"handler" in hookEntry;
											const config = isConfig ? (hookEntry as Record<string, unknown>) : {};
											(resolvedPlugin.hooks as Record<string, unknown>)[hookName] = {
												handler: isConfig
													? (hookEntry as Record<string, unknown>).handler
													: hookEntry,
												priority: (config.priority as number) ?? 100,
												timeout: (config.timeout as number) ?? 5000,
												dependencies: (config.dependencies as string[]) ?? [],
												errorPolicy: (config.errorPolicy as string) ?? "abort",
												exclusive: (config.exclusive as boolean) ?? false,
												pluginId: result.id,
											};
										}
									}
									if (routes) {
										for (const [name, route] of Object.entries(routes)) {
											const routeObj = route as Record<string, unknown>;
											(resolvedPlugin.routes as Record<string, unknown>)[name] = {
												handler: routeObj.handler,
												public: routeObj.public,
											};
										}
									}
								}
							}
							break;
						}
					} catch {
						// Not a descriptor factory, skip
					}
				}
			}

			if (!resolvedPlugin?.id || !resolvedPlugin?.version) {
				consola.error(
					"Could not extract plugin definition. Expected one of:\n" +
						"  - createPlugin() export (native format)\n" +
						"  - Descriptor factory function returning { id, version, ... } (standard format)",
				);
				process.exit(1);
			}

			const manifest = extractManifest(resolvedPlugin);

			// Validate format consistency: bundled plugins are for the marketplace
			// (sandboxed), so they must be standard format without trusted-only features.
			if (resolvedPlugin.admin?.entry) {
				consola.error(
					`Plugin declares adminEntry — React admin components require native/trusted mode. ` +
						`Use Block Kit for sandboxed admin pages, or remove adminEntry.`,
				);
				process.exit(1);
			}
			if (
				resolvedPlugin.admin?.portableTextBlocks &&
				resolvedPlugin.admin.portableTextBlocks.length > 0
			) {
				consola.error(
					`Plugin declares portableTextBlocks — these require native/trusted mode ` +
						`and cannot be bundled for the marketplace.`,
				);
				process.exit(1);
			}

			consola.success(`Plugin: ${manifest.id}@${manifest.version}`);
			consola.info(
				`  Capabilities: ${manifest.capabilities.length > 0 ? manifest.capabilities.join(", ") : "(none)"}`,
			);
			consola.info(
				`  Hooks: ${manifest.hooks.length > 0 ? manifest.hooks.map((h) => (typeof h === "string" ? h : h.name)).join(", ") : "(none)"}`,
			);
			consola.info(
				`  Routes: ${manifest.routes.length > 0 ? manifest.routes.map((r) => (typeof r === "string" ? r : r.name)).join(", ") : "(none)"}`,
			);

			// ── Step 3: Bundle backend.js ──

			const bundleDir = join(tmpDir, "bundle");
			await mkdir(bundleDir, { recursive: true });

			if (backendEntry) {
				consola.start("Bundling backend...");

				// Create a shim for emdash so the sandbox entry doesn't pull in the
				// entire core package. definePlugin is an identity function for standard
				// format, and PluginContext is a type-only import that disappears.
				const shimDir = join(tmpDir, "shims");
				await mkdir(shimDir, { recursive: true });
				await writeFile(join(shimDir, "emdash.mjs"), "export const definePlugin = (d) => d;\n");

				await build({
					config: false,
					entry: [backendEntry],
					format: "esm",
					outDir: join(tmpDir, "backend"),
					dts: false,
					platform: "neutral",
					// Bundle everything for a self-contained sandbox file,
					// but alias emdash to our shim so we don't pull in the core.
					external: [],
					alias: { emdash: join(shimDir, "emdash.mjs") },
					minify: true,
					treeshake: true,
				});

				const backendBaseName = basename(backendEntry).replace(TS_EXT_RE, "");
				const backendOutputPath = await findBuildOutput(join(tmpDir, "backend"), backendBaseName);

				if (backendOutputPath) {
					await copyFile(backendOutputPath, join(bundleDir, "backend.js"));
					consola.success("Built backend.js");
				} else {
					consola.error("Backend build produced no output");
					process.exit(1);
				}
			} else {
				consola.warn("No sandbox entry found — bundle will have no backend.js");
				consola.warn('  Add a "sandbox-entry.ts" in src/ or a "./sandbox" export in package.json');
			}

			// ── Step 4: Bundle admin.js ──

			if (adminEntry) {
				consola.start("Bundling admin...");
				await build({
					config: false,
					entry: [adminEntry],
					format: "esm",
					outDir: join(tmpDir, "admin"),
					dts: false,
					platform: "neutral",
					external: [],
					minify: true,
					treeshake: true,
				});

				const adminBaseName = basename(adminEntry).replace(TS_EXT_RE, "");
				const adminOutputPath = await findBuildOutput(join(tmpDir, "admin"), adminBaseName);

				if (adminOutputPath) {
					await copyFile(adminOutputPath, join(bundleDir, "admin.js"));
					consola.success("Built admin.js");
				}
			}

			// ── Step 5: Write manifest.json ──

			await writeFile(join(bundleDir, "manifest.json"), JSON.stringify(manifest, null, 2));

			// ── Step 6: Collect assets ──

			consola.start("Collecting assets...");

			// README.md
			const readmePath = join(pluginDir, "README.md");
			if (await fileExists(readmePath)) {
				await copyFile(readmePath, join(bundleDir, "README.md"));
				consola.success("Included README.md");
			}

			// icon.png
			const iconPath = join(pluginDir, "icon.png");
			if (await fileExists(iconPath)) {
				const iconBuf = await readFile(iconPath);
				const dims = readImageDimensions(iconBuf);
				if (!dims) {
					consola.warn("icon.png is not a valid PNG — skipping");
				} else if (dims[0] !== ICON_SIZE || dims[1] !== ICON_SIZE) {
					consola.warn(
						`icon.png is ${dims[0]}x${dims[1]}, expected ${ICON_SIZE}x${ICON_SIZE} — including anyway`,
					);
					await copyFile(iconPath, join(bundleDir, "icon.png"));
				} else {
					await copyFile(iconPath, join(bundleDir, "icon.png"));
					consola.success("Included icon.png");
				}
			}

			// screenshots/
			const screenshotsDir = join(pluginDir, "screenshots");
			if (await fileExists(screenshotsDir)) {
				const screenshotFiles = (await readdir(screenshotsDir))
					.filter((f) => {
						const ext = extname(f).toLowerCase();
						return ext === ".png" || ext === ".jpg" || ext === ".jpeg";
					})
					.toSorted()
					.slice(0, MAX_SCREENSHOTS);

				if (screenshotFiles.length > 0) {
					await mkdir(join(bundleDir, "screenshots"), { recursive: true });

					for (const file of screenshotFiles) {
						const filePath = join(screenshotsDir, file);
						const buf = await readFile(filePath);

						const dims = readImageDimensions(buf);

						if (!dims) {
							consola.warn(`screenshots/${file} — cannot read dimensions, skipping`);
							continue;
						}

						if (dims[0] > MAX_SCREENSHOT_WIDTH || dims[1] > MAX_SCREENSHOT_HEIGHT) {
							consola.warn(
								`screenshots/${file} is ${dims[0]}x${dims[1]}, max ${MAX_SCREENSHOT_WIDTH}x${MAX_SCREENSHOT_HEIGHT} — including anyway`,
							);
						}

						await copyFile(filePath, join(bundleDir, "screenshots", file));
					}

					consola.success(`Included ${screenshotFiles.length} screenshot(s)`);
				}
			}

			// ── Step 7: Validation ──

			consola.start("Validating bundle...");
			let hasErrors = false;

			// Check that package.json exports point to built files, not source.
			// Plugins published to npm with source exports will break site builds
			// because the sandbox module generator embeds the resolved file as-is.
			if (pkg.exports) {
				for (const issue of findSourceExports(pkg.exports)) {
					consola.error(
						`Export "${issue.exportPath}" points to source (${issue.resolvedPath}). ` +
							`Package exports must point to built files (e.g. dist/*.mjs). ` +
							`Add a build step and update the exports map.`,
					);
					hasErrors = true;
				}
			}

			// Check for Node.js builtins in backend.js
			const backendPath = join(bundleDir, "backend.js");
			if (await fileExists(backendPath)) {
				const backendCode = await readFile(backendPath, "utf-8");
				const builtins = findNodeBuiltinImports(backendCode);
				if (builtins.length > 0) {
					consola.error(`backend.js imports Node.js built-in modules: ${builtins.join(", ")}`);
					consola.error("Sandboxed plugins cannot use Node.js APIs");
					hasErrors = true;
				}
			}

			// Check capabilities warnings
			if (manifest.capabilities.includes("network:fetch:any")) {
				consola.warn(
					"Plugin declares unrestricted network access (network:fetch:any) — it can make requests to any host",
				);
			} else if (
				manifest.capabilities.includes("network:fetch") &&
				manifest.allowedHosts.length === 0
			) {
				consola.warn(
					"Plugin declares network:fetch capability but no allowedHosts — all fetch requests will be blocked",
				);
			}

			// Check for features that won't work in sandboxed mode
			if (
				resolvedPlugin.admin?.portableTextBlocks &&
				resolvedPlugin.admin.portableTextBlocks.length > 0
			) {
				consola.warn(
					"Plugin declares portableTextBlocks — these require trusted mode and will be ignored in sandboxed plugins",
				);
			}
			if (resolvedPlugin.admin?.entry) {
				consola.warn(
					"Plugin declares admin.entry — custom React components require trusted mode. Use Block Kit for sandboxed admin pages",
				);
			}
			// Check for page:fragments hook — trusted-only, not allowed in sandbox
			if (resolvedPlugin.hooks["page:fragments"]) {
				consola.warn(
					"Plugin declares page:fragments hook — this is trusted-only and will not work in sandboxed mode",
				);
			}

			// Check: if plugin declares admin pages or widgets, it must have an "admin" route
			const hasAdminPages = (manifest.admin?.pages?.length ?? 0) > 0;
			const hasAdminWidgets = (manifest.admin?.widgets?.length ?? 0) > 0;
			if (hasAdminPages || hasAdminWidgets) {
				const routeNames = manifest.routes.map((r: string | { name: string }) =>
					typeof r === "string" ? r : r.name,
				);
				if (!routeNames.includes("admin")) {
					consola.error(
						`Plugin declares ${hasAdminPages ? "adminPages" : ""}${hasAdminPages && hasAdminWidgets ? " and " : ""}${hasAdminWidgets ? "adminWidgets" : ""} ` +
							`but the sandbox entry has no "admin" route. ` +
							`Add an admin route handler to serve Block Kit pages.`,
					);
					hasErrors = true;
				}
			}

			// Calculate total bundle size
			const totalSize = await calculateDirectorySize(bundleDir);
			if (totalSize > MAX_BUNDLE_SIZE) {
				const sizeMB = (totalSize / 1024 / 1024).toFixed(2);
				consola.error(`Bundle size ${sizeMB}MB exceeds maximum of 5MB`);
				hasErrors = true;
			} else {
				const sizeKB = (totalSize / 1024).toFixed(1);
				consola.info(`Bundle size: ${sizeKB}KB`);
			}

			if (hasErrors) {
				consola.error("Bundle validation failed");
				process.exit(1);
			}

			consola.success("Validation passed");

			if (validateOnly) {
				return;
			}

			// ── Step 8: Create tarball ──

			await mkdir(outDir, { recursive: true });
			const tarballName = `${manifest.id.replace(SLASH_RE, "-").replace(LEADING_AT_RE, "")}-${manifest.version}.tar.gz`;
			const tarballPath = join(outDir, tarballName);

			consola.start("Creating tarball...");
			await createTarball(bundleDir, tarballPath);

			const tarballStat = await stat(tarballPath);
			const tarballSizeKB = (tarballStat.size / 1024).toFixed(1);

			// Calculate checksum
			const tarballBuf = await readFile(tarballPath);
			const checksum = createHash("sha256").update(tarballBuf).digest("hex");

			consola.success(`Created ${tarballName} (${tarballSizeKB}KB)`);
			consola.info(`  SHA-256: ${checksum}`);
			consola.info(`  Path: ${tarballPath}`);
		} finally {
			if (tmpDir.endsWith(".emdash-bundle-tmp")) {
				await rm(tmpDir, { recursive: true, force: true });
			}
		}
	},
});
