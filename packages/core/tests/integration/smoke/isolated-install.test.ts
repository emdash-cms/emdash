import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify, stripVTControlCharacters } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ensureBuilt } from "../server.js";

interface PackageManifest {
	name: string;
	dependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
	optionalDependencies?: Record<string, string>;
	packageManager?: string;
}

interface WorkspacePackage {
	dir: string;
	manifest: PackageManifest;
}

interface PlatformCase {
	id: "node" | "cloudflare";
	name: string;
	templateDir: string;
	port: number;
	localPackageRoots: string[];
}

const execAsync = promisify(execFile);
const WORKSPACE_ROOT = resolve(import.meta.dirname, "../../../../..");
const STARTUP_TIMEOUT_MS = 180_000;
const INSTALL_TIMEOUT_MS = 600_000;
const PLATFORM_CASES: PlatformCase[] = [
	{
		id: "node",
		name: "Node",
		templateDir: join(WORKSPACE_ROOT, "templates/starter"),
		port: 4623,
		localPackageRoots: ["emdash"],
	},
	{
		id: "cloudflare",
		name: "Cloudflare",
		templateDir: join(WORKSPACE_ROOT, "templates/starter-cloudflare"),
		port: 4622,
		localPackageRoots: ["emdash", "@emdash-cms/cloudflare"],
	},
];
const LOCAL_PACKAGE_ROOTS = [
	...new Set(PLATFORM_CASES.flatMap(({ localPackageRoots }) => localPackageRoots)),
];
const LATE_MANIFEST_OPTIMIZATION =
	/(?:new )?dependenc(?:y|ies) (?:found|optimized):.*astro\/app\/manifest/;
const MISSING_SSR_DEPENDENCY = /file does not exist at .*node_modules[/\\]\.vite[/\\]deps_ssr/i;
const SMOKE_FONT_PROVIDER_PATH = resolve(import.meta.dirname, "smoke-font-provider.mjs");
const SMOKE_FONT_PATH = resolve(import.meta.dirname, "fixtures/codicon.ttf");
const COPY_EXCLUDES = new Set([
	".astro",
	".wrangler",
	"dist",
	"node_modules",
	"pnpm-lock.yaml",
	"pnpm-workspace.yaml",
]);

function readManifest(path: string): PackageManifest {
	return JSON.parse(readFileSync(path, "utf8")) as PackageManifest;
}

function discoverWorkspacePackages(): Map<string, WorkspacePackage> {
	const packages = new Map<string, WorkspacePackage>();
	for (const parent of [
		join(WORKSPACE_ROOT, "packages"),
		join(WORKSPACE_ROOT, "packages/plugins"),
	]) {
		for (const entry of readdirSync(parent, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const dir = join(parent, entry.name);
			const manifestPath = join(dir, "package.json");
			if (!existsSync(manifestPath)) continue;
			const manifest = readManifest(manifestPath);
			packages.set(manifest.name, { dir, manifest });
		}
	}
	return packages;
}

function localPackageClosure(packages: Map<string, WorkspacePackage>): WorkspacePackage[] {
	const selected = new Map<string, WorkspacePackage>();
	const pending = [...LOCAL_PACKAGE_ROOTS];

	while (pending.length > 0) {
		const name = pending.pop();
		if (!name || selected.has(name)) continue;
		const workspacePackage = packages.get(name);
		if (!workspacePackage) throw new Error(`Missing workspace package ${name}`);
		selected.set(name, workspacePackage);

		for (const dependencies of [
			workspacePackage.manifest.dependencies,
			workspacePackage.manifest.optionalDependencies,
		]) {
			for (const [dependency, version] of Object.entries(dependencies ?? {})) {
				if (version.startsWith("workspace:") && packages.has(dependency)) {
					pending.push(dependency);
				}
			}
		}
	}

	return [...selected.values()];
}

function parseCatalog(): Map<string, string> {
	const catalog = new Map<string, string>();
	const workspaceConfig = readFileSync(join(WORKSPACE_ROOT, "pnpm-workspace.yaml"), "utf8");
	let inCatalog = false;
	for (const line of workspaceConfig.split(/\r?\n/)) {
		if (line === "catalog:") {
			inCatalog = true;
			continue;
		}
		if (inCatalog && /^\S/.test(line)) break;
		if (!inCatalog) continue;

		const match = line.match(/^\s{2}(?:"([^"]+)"|([^:]+)):\s+(.+)$/);
		if (!match) continue;
		const name = match[1] ?? match[2]?.trim();
		const version = match[3]?.trim().replace(/\s+#.*$/, "");
		if (name && version) catalog.set(name, version.replace(/^"|"$/g, ""));
	}
	return catalog;
}

function consumerEnvironment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
	const environment = { ...process.env, ...overrides };
	for (const key of Object.keys(environment)) {
		if (key === "VITEST" || key.startsWith("VITEST_")) delete environment[key];
	}
	return environment;
}

async function runPnpm(args: string[], cwd: string, timeout: number): Promise<string> {
	try {
		const { stdout } = await execAsync("pnpm", args, {
			cwd,
			timeout,
			maxBuffer: 10 * 1024 * 1024,
			env: consumerEnvironment({ CI: "true" }),
		});
		return stdout;
	} catch (error) {
		const stdout = error instanceof Error && "stdout" in error ? String(error.stdout) : "";
		const stderr = error instanceof Error && "stderr" in error ? String(error.stderr) : "";
		throw new Error(`pnpm ${args.join(" ")} failed:\n${stderr || stdout}`, { cause: error });
	}
}

async function packLocalPackages(
	packages: WorkspacePackage[],
	tarballDir: string,
): Promise<Map<string, string>> {
	const packed = await Promise.all(
		packages.map(async ({ dir, manifest }) => {
			const output = await runPnpm(
				["pack", "--pack-destination", tarballDir, "--json"],
				dir,
				120_000,
			);
			const { filename } = JSON.parse(output) as { filename?: unknown };
			if (typeof filename !== "string") {
				throw new Error(`pnpm pack did not return a tarball for ${manifest.name}`);
			}
			const tarballPath = isAbsolute(filename) ? filename : resolve(tarballDir, filename);
			return [manifest.name, tarballPath] as const;
		}),
	);
	return new Map(packed);
}

function resolveStandaloneDependencies(
	dependencies: Record<string, string> | undefined,
	catalog: Map<string, string>,
	tarballs: Map<string, string>,
): Record<string, string> | undefined {
	if (!dependencies) return undefined;
	return Object.fromEntries(
		Object.entries(dependencies).map(([name, version]) => {
			const tarball = tarballs.get(name);
			if (tarball) return [name, pathToFileURL(tarball).href];
			if (version === "catalog:") {
				const catalogVersion = catalog.get(name);
				if (!catalogVersion) throw new Error(`Missing catalog version for ${name}`);
				return [name, catalogVersion];
			}
			if (version.startsWith("workspace:")) {
				throw new Error(`Missing local tarball for workspace dependency ${name}`);
			}
			return [name, version];
		}),
	);
}

function prepareStandaloneTemplate(
	platform: PlatformCase,
	projectDir: string,
	tarballs: Map<string, string>,
): void {
	cpSync(platform.templateDir, projectDir, {
		recursive: true,
		filter: (source) => !COPY_EXCLUDES.has(basename(source)),
	});

	const manifestPath = join(projectDir, "package.json");
	const manifest = readManifest(manifestPath);
	const catalog = parseCatalog();
	manifest.name = "emdash-isolated-install-smoke";
	manifest.dependencies = resolveStandaloneDependencies(manifest.dependencies, catalog, tarballs);
	manifest.devDependencies = resolveStandaloneDependencies(
		manifest.devDependencies,
		catalog,
		tarballs,
	);
	manifest.packageManager = readManifest(join(WORKSPACE_ROOT, "package.json")).packageManager;
	writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

	const overrides = Array.from(
		tarballs.entries(),
		([name, tarball]) =>
			`  ${JSON.stringify(name)}: ${JSON.stringify(pathToFileURL(tarball).href)}`,
	).join("\n");
	const allowBuilds =
		platform.id === "cloudflare"
			? "  esbuild: true\n  workerd: true\n  sharp: false"
			: "  esbuild: true\n  sharp: true\n  workerd: false";
	writeFileSync(
		join(projectDir, "pnpm-workspace.yaml"),
		`minimumReleaseAge: 1440
minimumReleaseAgeExclude:
  - emdash
  - "@emdash-cms/*"
blockExoticSubdeps: true
strictDepBuilds: true
overrides:
${overrides}
allowBuilds:
${allowBuilds}
`,
	);

	const smokeSupportDir = join(projectDir, ".emdash-smoke");
	mkdirSync(join(smokeSupportDir, "fixtures"), { recursive: true });
	cpSync(SMOKE_FONT_PROVIDER_PATH, join(smokeSupportDir, "smoke-font-provider.mjs"));
	cpSync(SMOKE_FONT_PATH, join(smokeSupportDir, "fixtures/codicon.ttf"));
}

function nodeOptionsWithSmokeFontProvider(projectDir: string): string {
	const providerImport = pathToFileURL(
		join(projectDir, ".emdash-smoke/smoke-font-provider.mjs"),
	).href;
	return [process.env.NODE_OPTIONS, `--import=${providerImport}`].filter(Boolean).join(" ");
}

async function waitForReady(
	serverProcess: ReturnType<typeof spawn>,
	readOutput: () => string,
): Promise<void> {
	const deadline = Date.now() + STARTUP_TIMEOUT_MS;
	while (Date.now() < deadline) {
		if (serverProcess.exitCode !== null || serverProcess.signalCode !== null) {
			throw new Error(
				`Isolated dev server exited before responding:\n${readOutput().slice(-5000)}`,
			);
		}
		if (/\bready in \d+ ms\b/.test(readOutput())) return;
		await new Promise((resolveSleep) => setTimeout(resolveSleep, 250));
	}
	throw new Error(
		`Isolated dev server was not ready within ${STARTUP_TIMEOUT_MS}ms:\n${readOutput().slice(-5000)}`,
	);
}

async function waitForInjectedRoute(url: string, readOutput: () => string): Promise<Response> {
	const deadline = Date.now() + 15_000;
	let lastBody = "";
	while (Date.now() < deadline) {
		const response = await fetch(url, {
			redirect: "manual",
			signal: AbortSignal.timeout(15_000),
		});
		if (response.status !== 404) return response;
		lastBody = await response.text();
		await new Promise((resolveSleep) => setTimeout(resolveSleep, 250));
	}
	throw new Error(`Injected route was not ready:\n${readOutput()}\n${lastBody}`);
}

async function stopServer(serverProcess: ReturnType<typeof spawn>): Promise<void> {
	if (serverProcess.exitCode !== null || serverProcess.signalCode !== null) return;
	serverProcess.kill("SIGTERM");
	await Promise.race([
		once(serverProcess, "exit"),
		new Promise<void>((resolveTimeout) => {
			setTimeout(() => {
				if (serverProcess.exitCode === null && serverProcess.signalCode === null) {
					serverProcess.kill("SIGKILL");
				}
				resolveTimeout();
			}, 5000);
		}),
	]);
}

describe.sequential("Isolated template installs", () => {
	let temporaryDirectory: string;
	const projectDirs = new Map<PlatformCase["id"], string>();

	beforeAll(async () => {
		await ensureBuilt();
		temporaryDirectory = mkdtempSync(join(tmpdir(), "emdash-isolated-install-"));
		const tarballDir = join(temporaryDirectory, "tarballs");
		const storeDir = join(temporaryDirectory, "pnpm-store");
		mkdirSync(tarballDir);
		const tarballs = await packLocalPackages(
			localPackageClosure(discoverWorkspacePackages()),
			tarballDir,
		);
		await Promise.all(
			PLATFORM_CASES.map(async (platform) => {
				const projectDir = join(temporaryDirectory, platform.id);
				projectDirs.set(platform.id, projectDir);
				prepareStandaloneTemplate(platform, projectDir, tarballs);
				await runPnpm(
					["install", "--no-frozen-lockfile", "--reporter=append-only", "--store-dir", storeDir],
					projectDir,
					INSTALL_TIMEOUT_MS,
				);
			}),
		);
	}, INSTALL_TIMEOUT_MS + 180_000);

	afterAll(() => {
		if (temporaryDirectory) rmSync(temporaryDirectory, { recursive: true, force: true });
	});

	for (const platform of PLATFORM_CASES) {
		describe(platform.name, () => {
			it("installs packed EmDash packages outside the workspace", () => {
				const projectDir = projectDirs.get(platform.id);
				if (!projectDir) throw new Error(`Missing isolated ${platform.name} project`);
				const canonicalTemporaryDirectory = realpathSync(temporaryDirectory);
				for (const name of platform.localPackageRoots) {
					const installedPackage = realpathSync(join(projectDir, "node_modules", name));
					expect(installedPackage.startsWith(`${canonicalTemporaryDirectory}${sep}`)).toBe(true);
					expect(relative(WORKSPACE_ROOT, installedPackage).startsWith("..")).toBe(true);
				}
			});

			it(
				"cold-starts from the packed install",
				{ timeout: STARTUP_TIMEOUT_MS + 60_000 },
				async () => {
					const projectDir = projectDirs.get(platform.id);
					if (!projectDir) throw new Error(`Missing isolated ${platform.name} project`);
					const viteCache = join(projectDir, "node_modules/.vite");
					rmSync(viteCache, { recursive: true, force: true });
					const devLogPath = join(projectDir, ".astro/dev.log");
					rmSync(devLogPath, { force: true });

					const serverEnv = consumerEnvironment({
						CI: "true",
						ASTRO_TELEMETRY_DISABLED: "1",
						EMDASH_ENCRYPTION_KEY: "emdash_enc_v1_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
						NODE_OPTIONS: nodeOptionsWithSmokeFontProvider(projectDir),
						WRANGLER_LOG_PATH: join(temporaryDirectory, "wrangler.log"),
					});
					delete serverEnv.CODEX_THREAD_ID;
					const astroBinary = join(
						projectDir,
						"node_modules/.bin",
						process.platform === "win32" ? "astro.cmd" : "astro",
					);
					const serverProcess = spawn(astroBinary, ["dev", "--port", String(platform.port)], {
						cwd: projectDir,
						env: serverEnv,
						stdio: "pipe",
					});
					let output = "";
					serverProcess.stdout?.on("data", (data: Buffer) => {
						output += data.toString();
					});
					serverProcess.stderr?.on("data", (data: Buffer) => {
						output += data.toString();
					});
					const readOutput = () =>
						stripVTControlCharacters(
							[output, existsSync(devLogPath) ? readFileSync(devLogPath, "utf8") : ""].join("\n"),
						);

					try {
						await waitForReady(serverProcess, readOutput);
						const setup = await waitForInjectedRoute(
							`http://localhost:${platform.port}/_emdash/api/setup/dev-bypass?redirect=/`,
							readOutput,
						);
						const setupBody = await setup.text();
						expect([200, 302, 307, 308], `${readOutput()}\n${setupBody}`).toContain(setup.status);

						const frontend = await fetch(`http://localhost:${platform.port}/`, {
							redirect: "manual",
							signal: AbortSignal.timeout(15_000),
						});
						const frontendBody = await frontend.text();
						expect([200, 302, 307, 308], `${readOutput()}\n${frontendBody}`).toContain(
							frontend.status,
						);

						const admin = await fetch(`http://localhost:${platform.port}/_emdash/admin/`, {
							redirect: "manual",
							signal: AbortSignal.timeout(15_000),
						});
						const adminBody = await admin.text();
						expect(admin.status, `${readOutput()}\n${adminBody}`).toBeLessThan(500);

						const observationDeadline = Date.now() + 5_000;
						while (Date.now() < observationDeadline) {
							const optimizerOutput = readOutput();
							if (platform.id === "cloudflare") {
								expect(optimizerOutput).not.toMatch(LATE_MANIFEST_OPTIMIZATION);
							}
							expect(optimizerOutput).not.toMatch(MISSING_SSR_DEPENDENCY);
							await new Promise((resolveSleep) => setTimeout(resolveSleep, 100));
						}
					} finally {
						await stopServer(serverProcess);
					}
				},
			);
		});
	}
});
