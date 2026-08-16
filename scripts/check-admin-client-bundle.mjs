#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ANALYSIS_FILE = "emdash-client-bundle.json";
// The entry and closure ceilings retain roughly 400 KB of normal bundle drift,
// but less than one deferred chart payload. The definition cap is over twice
// the optimized fixture count while remaining far below the full icon catalog.
const MAX_PLUGIN_REGISTRY_BYTES = 2_250_000;
const MAX_INITIAL_CLOSURE_BYTES = 3_150_000;
const MAX_INITIAL_PHOSPHOR_DEFS = 350;
// Feature chunks may carry a focused icon set; namespace imports exceed both caps by an order of magnitude.
const MAX_NON_BUCKET_LAZY_PHOSPHOR_DEFS = 32;
const MAX_TOTAL_NON_BUCKET_LAZY_PHOSPHOR_DEFS = 96;
// A deferred bucket has about 25% growth room before one icon request becomes too large.
const MAX_ICON_BUCKET_BYTES = 275_000;

const scriptDir = dirname(fileURLToPath(import.meta.url));
const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = resolve(scriptDir, "..");
const fixtureDir = resolve(repoRoot, "fixtures", "perf-site");
const clientDir = resolve(fixtureDir, "dist", "client");
const analysisPath = resolve(clientDir, ANALYSIS_FILE);
const buildMarkerPath = resolve(fixtureDir, "dist", ".perf-target");
const workspaceInputs = [
	resolve(repoRoot, "pnpm-lock.yaml"),
	resolve(repoRoot, "pnpm-workspace.yaml"),
];
const packageBuilds = [
	{
		name: "@emdash-cms/blocks",
		artifact: resolve(repoRoot, "packages", "blocks", "dist", "index.js"),
		inputs: [
			resolve(repoRoot, "packages", "blocks", "src"),
			resolve(repoRoot, "packages", "blocks", "package.json"),
			resolve(repoRoot, "packages", "blocks", "tsdown.config.ts"),
			...workspaceInputs,
		],
	},
	{
		name: "@emdash-cms/admin",
		artifact: resolve(repoRoot, "packages", "admin", "dist", "index.js"),
		inputs: [
			resolve(repoRoot, "packages", "admin", "src"),
			resolve(repoRoot, "packages", "admin", "scripts"),
			resolve(repoRoot, "packages", "admin", "package.json"),
			resolve(repoRoot, "packages", "admin", "tsdown.config.ts"),
			...workspaceInputs,
		],
	},
	{
		name: "emdash",
		artifact: resolve(
			repoRoot,
			"packages",
			"core",
			"dist",
			"astro",
			"routes",
			"PluginRegistry.mjs",
		),
		inputs: [
			resolve(repoRoot, "packages", "core", "src"),
			resolve(repoRoot, "packages", "core", "package.json"),
			resolve(repoRoot, "packages", "core", "tsdown.config.ts"),
			...workspaceInputs,
		],
	},
];

function normalizeId(id) {
	return id.replaceAll("\\", "/");
}

function isWorkspacePackageDistModule(id, packageDir) {
	const packageDist = `${normalizeId(resolve(repoRoot, "packages", packageDir, "dist"))}/`;
	return normalizeId(id).startsWith(packageDist);
}

function isPackageDistModule(id, packagePath) {
	const normalized = normalizeId(id);
	return (
		normalized.includes(`/packages/${packagePath}/dist/`) ||
		normalized.includes(`/node_modules/@emdash-cms/${packagePath}/dist/`)
	);
}

function isIconBucketModule(id) {
	return isPackageDistModule(id, "admin") && /\/bucket-\d{2}(?:-[^/]+)?\.js$/.test(normalizeId(id));
}

function isChartModule(id) {
	return isPackageDistModule(id, "blocks") && /\/chart(?:-[^/]+)?\.js$/.test(normalizeId(id));
}

function phosphorDefinitionName(id) {
	return normalizeId(id).match(
		/\/node_modules\/@phosphor-icons\/react\/dist\/defs\/([^/]+)\.es\.js$/,
	)?.[1];
}

function getBundledPhosphorDefinitions(moduleIds, missingSourceMaps) {
	const definitions = new Set();
	for (const id of moduleIds) {
		const directDefinition = phosphorDefinitionName(id);
		if (directDefinition) definitions.add(directDefinition);
		const workspacePackageModule = ["admin", "blocks", "core"].some((packageDir) =>
			isWorkspacePackageDistModule(id, packageDir),
		);
		if (!workspacePackageModule || !/\.m?js$/.test(id)) continue;
		const sourceMapPath = `${id}.map`;
		if (!existsSync(sourceMapPath)) {
			missingSourceMaps.add(sourceMapPath);
			continue;
		}
		const sourceMap = JSON.parse(readFileSync(sourceMapPath, "utf8"));
		for (const source of sourceMap.sources ?? []) {
			const definition = phosphorDefinitionName(source);
			if (definition) definitions.add(definition);
		}
	}
	return definitions;
}

function collectClosure(chunks, entryFile, includeDynamic) {
	const visited = new Set();
	const pending = [entryFile];
	while (pending.length > 0) {
		const fileName = pending.pop();
		if (!fileName || visited.has(fileName)) continue;
		const chunk = chunks[fileName];
		if (!chunk) throw new Error(`Bundle metadata references missing chunk ${fileName}`);
		visited.add(fileName);
		pending.push(...chunk.imports);
		if (includeDynamic) pending.push(...chunk.dynamicImports);
	}
	return visited;
}

function chunkBytes(fileName) {
	return statSync(resolve(clientDir, fileName)).size;
}

function formatBytes(bytes) {
	return new Intl.NumberFormat("en-US").format(bytes);
}

function newestMtime(paths) {
	let newest = 0;
	const pending = [...paths];
	while (pending.length > 0) {
		const path = pending.pop();
		if (!path || !existsSync(path)) continue;
		const stats = statSync(path);
		if (stats.isDirectory()) {
			pending.push(...readdirSync(path).map((entry) => join(path, entry)));
		} else {
			newest = Math.max(newest, stats.mtimeMs);
		}
	}
	return newest;
}

function assertFresh(artifact, inputs, label) {
	if (!existsSync(artifact)) throw new Error(`Missing ${label}: ${artifact}`);
	if (statSync(artifact).mtimeMs < newestMtime(inputs)) {
		throw new Error(`${label} is older than its workspace inputs; run pnpm bundle:check`);
	}
}

function run(command, args, cwd = repoRoot, env = process.env) {
	process.stdout.write(`$ ${command} ${args.join(" ")}\n`);
	const result = spawnSync(command, args, { cwd, stdio: "inherit", env });
	if (result.status !== 0) process.exit(result.status ?? 1);
}

function buildWorkspacePackages() {
	for (const { name } of packageBuilds) run("pnpm", ["--filter", name, "build"]);
}

function buildFixture() {
	run("pnpm", ["exec", "astro", "build"], fixtureDir, {
		...process.env,
		ASTRO_TELEMETRY_DISABLED: "1",
		EMDASH_FIXTURE_TARGET: "sqlite",
	});
	writeFileSync(buildMarkerPath, "sqlite\n");
}

function assertReusableCiBuild() {
	if (!existsSync(buildMarkerPath) || readFileSync(buildMarkerPath, "utf8").trim() !== "sqlite") {
		throw new Error("bundle:check:ci requires the preceding SQLite query-count build");
	}
	for (const { artifact, inputs, name } of packageBuilds) {
		assertFresh(artifact, inputs, `${name} build artifact`);
	}
	assertFresh(
		analysisPath,
		[
			scriptPath,
			resolve(fixtureDir, "src"),
			resolve(fixtureDir, "package.json"),
			resolve(fixtureDir, "astro.config.mjs"),
			...packageBuilds.map(({ artifact }) => artifact),
		],
		"Astro client bundle metadata",
	);
	if (statSync(buildMarkerPath).mtimeMs < statSync(analysisPath).mtimeMs) {
		throw new Error("SQLite build marker is older than the analyzed client bundle");
	}
}

export function adminClientBundleMetadata() {
	return {
		name: "emdash-admin-client-bundle-metadata",
		apply: "build",
		generateBundle(_options, bundle) {
			const outputs = Object.values(bundle);
			const hasPluginRegistryEntry = outputs.some(
				(output) =>
					output.type === "chunk" &&
					normalizeId(output.facadeModuleId ?? "").endsWith("/PluginRegistry.mjs"),
			);
			if (!hasPluginRegistryEntry) return;
			const chunks = {};
			for (const output of outputs) {
				if (output.type !== "chunk") continue;
				chunks[output.fileName] = {
					isEntry: output.isEntry,
					isDynamicEntry: output.isDynamicEntry,
					facadeModuleId: output.facadeModuleId,
					imports: output.imports,
					dynamicImports: output.dynamicImports,
					modules: Object.keys(output.modules).toSorted(),
				};
			}
			this.emitFile({
				type: "asset",
				fileName: ANALYSIS_FILE,
				source: JSON.stringify({ version: 1, chunks }),
			});
		},
	};
}

export function checkAdminClientBundle() {
	const analysis = JSON.parse(readFileSync(analysisPath, "utf8"));
	if (analysis.version !== 1 || !analysis.chunks || typeof analysis.chunks !== "object") {
		throw new Error(`Unsupported bundle metadata in ${analysisPath}`);
	}
	const chunks = analysis.chunks;
	const pluginRegistryEntries = Object.entries(chunks).filter(([, chunk]) =>
		normalizeId(chunk.facadeModuleId ?? "").endsWith("/PluginRegistry.mjs"),
	);
	if (pluginRegistryEntries.length !== 1) {
		throw new Error(
			`Expected one PluginRegistry client entry, found ${pluginRegistryEntries.length}`,
		);
	}

	const [pluginRegistryFile, pluginRegistryChunk] = pluginRegistryEntries[0];
	if (!pluginRegistryChunk.isEntry || pluginRegistryChunk.isDynamicEntry) {
		throw new Error("PluginRegistry is not an initial client entry");
	}
	const staticClosure = collectClosure(chunks, pluginRegistryFile, false);
	const completeClosure = collectClosure(chunks, pluginRegistryFile, true);
	const completeModules = new Set(
		[...completeClosure].flatMap((fileName) => chunks[fileName].modules),
	);
	const pluginRegistryBytes = chunkBytes(pluginRegistryFile);
	const initialClosureBytes = [...staticClosure].reduce(
		(total, fileName) => total + chunkBytes(fileName),
		0,
	);
	const initialPhosphorDefinitions = new Set(
		[...staticClosure].flatMap((fileName) =>
			chunks[fileName].modules.map(phosphorDefinitionName).filter(Boolean),
		),
	);
	const iconBuckets = Object.entries(chunks).filter(([, chunk]) =>
		chunk.modules.some(isIconBucketModule),
	);
	const iconBucketFiles = new Set(iconBuckets.map(([fileName]) => fileName));
	const missingSourceMaps = new Set();
	const nonBucketLazyPhosphorDefinitions = [...completeClosure]
		.filter((fileName) => !staticClosure.has(fileName) && !iconBucketFiles.has(fileName))
		.map((fileName) => ({
			fileName,
			definitions: getBundledPhosphorDefinitions(chunks[fileName].modules, missingSourceMaps),
		}))
		.filter(({ definitions }) => definitions.size > 0);
	const allNonBucketLazyPhosphorDefinitions = new Set(
		nonBucketLazyPhosphorDefinitions.flatMap(({ definitions }) => [...definitions]),
	);
	const chartChunks = Object.entries(chunks).filter(([, chunk]) =>
		chunk.modules.some(isChartModule),
	);

	const failures = [];
	for (const [packageName, packageDir] of [
		["emdash", "core"],
		["@emdash-cms/admin", "admin"],
		["@emdash-cms/blocks", "blocks"],
	]) {
		if (![...completeModules].some((id) => isWorkspacePackageDistModule(id, packageDir))) {
			failures.push(`Consumer graph does not include workspace-built ${packageName}`);
		}
	}
	if (pluginRegistryBytes > MAX_PLUGIN_REGISTRY_BYTES) {
		failures.push(
			`PluginRegistry is ${formatBytes(pluginRegistryBytes)} bytes (limit ${formatBytes(MAX_PLUGIN_REGISTRY_BYTES)})`,
		);
	}
	if (initialClosureBytes > MAX_INITIAL_CLOSURE_BYTES) {
		failures.push(
			`PluginRegistry static closure is ${formatBytes(initialClosureBytes)} bytes (limit ${formatBytes(MAX_INITIAL_CLOSURE_BYTES)})`,
		);
	}
	if (initialPhosphorDefinitions.size > MAX_INITIAL_PHOSPHOR_DEFS) {
		failures.push(
			`PluginRegistry static closure contains ${initialPhosphorDefinitions.size} Phosphor definitions (limit ${MAX_INITIAL_PHOSPHOR_DEFS})`,
		);
	}
	if (missingSourceMaps.size > 0) {
		failures.push(
			`Missing source maps for ${missingSourceMaps.size} deferred workspace modules; package membership cannot be verified`,
		);
	}
	const oversizedNonBucketLazyChunks = nonBucketLazyPhosphorDefinitions.filter(
		({ definitions }) => definitions.size > MAX_NON_BUCKET_LAZY_PHOSPHOR_DEFS,
	);
	for (const { definitions, fileName } of oversizedNonBucketLazyChunks.slice(0, 5)) {
		failures.push(
			`Non-bucket lazy chunk ${fileName} contains ${definitions.size} Phosphor definitions (limit ${MAX_NON_BUCKET_LAZY_PHOSPHOR_DEFS})`,
		);
	}
	if (oversizedNonBucketLazyChunks.length > 5) {
		failures.push(
			`${oversizedNonBucketLazyChunks.length - 5} more non-bucket lazy chunks exceed the Phosphor definition limit`,
		);
	}
	if (allNonBucketLazyPhosphorDefinitions.size > MAX_TOTAL_NON_BUCKET_LAZY_PHOSPHOR_DEFS) {
		failures.push(
			`Non-bucket lazy chunks contain ${allNonBucketLazyPhosphorDefinitions.size} Phosphor definitions in total (limit ${MAX_TOTAL_NON_BUCKET_LAZY_PHOSPHOR_DEFS})`,
		);
	}
	if (iconBuckets.length === 0)
		failures.push("No generated Phosphor icon bucket chunks were emitted");
	for (const [fileName] of iconBuckets) {
		const bytes = chunkBytes(fileName);
		if (!completeClosure.has(fileName)) {
			failures.push(`Icon bucket ${fileName} is not reachable from PluginRegistry`);
		}
		if (staticClosure.has(fileName)) failures.push(`Icon bucket ${fileName} is loaded statically`);
		if (bytes > MAX_ICON_BUCKET_BYTES) {
			failures.push(
				`Icon bucket ${fileName} is ${formatBytes(bytes)} bytes (limit ${formatBytes(MAX_ICON_BUCKET_BYTES)})`,
			);
		}
	}
	if (chartChunks.length !== 1) {
		failures.push(`Expected one lazy Block Kit chart chunk, found ${chartChunks.length}`);
	}
	for (const [fileName] of chartChunks) {
		if (!completeClosure.has(fileName)) {
			failures.push(`Chart chunk ${fileName} is not reachable from PluginRegistry`);
		}
		if (staticClosure.has(fileName)) failures.push(`Chart chunk ${fileName} is loaded statically`);
	}

	const largestBucket = iconBuckets.reduce(
		(largest, [fileName]) => Math.max(largest, chunkBytes(fileName)),
		0,
	);
	const largestNonBucketLazyPhosphorSet = nonBucketLazyPhosphorDefinitions.reduce(
		(largest, { definitions }) => Math.max(largest, definitions.size),
		0,
	);
	process.stdout.write(
		[
			`PluginRegistry: ${formatBytes(pluginRegistryBytes)} / ${formatBytes(MAX_PLUGIN_REGISTRY_BYTES)} bytes`,
			`Initial static closure: ${formatBytes(initialClosureBytes)} / ${formatBytes(MAX_INITIAL_CLOSURE_BYTES)} bytes across ${staticClosure.size} chunks`,
			`Initial Phosphor definitions: ${initialPhosphorDefinitions.size} / ${MAX_INITIAL_PHOSPHOR_DEFS}`,
			`Non-bucket lazy Phosphor definitions: ${allNonBucketLazyPhosphorDefinitions.size} / ${MAX_TOTAL_NON_BUCKET_LAZY_PHOSPHOR_DEFS} total; largest chunk ${largestNonBucketLazyPhosphorSet} / ${MAX_NON_BUCKET_LAZY_PHOSPHOR_DEFS}`,
			`Lazy icon buckets: ${iconBuckets.length}; largest ${formatBytes(largestBucket)} / ${formatBytes(MAX_ICON_BUCKET_BYTES)} bytes`,
			`Lazy chart chunks: ${chartChunks.length}`,
		].join("\n") + "\n",
	);
	if (failures.length > 0) {
		throw new Error(`Admin client bundle regression:\n- ${failures.join("\n- ")}`);
	}
}

function parseArgs(args) {
	let reuseCiBuild = false;
	let help = false;
	for (const arg of args) {
		if (arg === "--ci-reuse-query-count-build") reuseCiBuild = true;
		else if (arg === "--help" || arg === "-h") help = true;
		else if (arg === "--skip-build") {
			throw new Error("--skip-build is unsafe; use pnpm bundle:check:ci with a fresh SQLite build");
		} else throw new Error(`Unknown argument: ${arg}`);
	}
	return { help, reuseCiBuild };
}

function main() {
	const { help, reuseCiBuild } = parseArgs(process.argv.slice(2));
	if (help) {
		process.stdout.write(
			"Usage:\n  pnpm bundle:check     Rebuild workspace packages and the Astro fixture, then check it.\n  pnpm bundle:check:ci  Validate and reuse the fresh SQLite build in the Query Counts workflow.\n",
		);
		return;
	}
	if (reuseCiBuild) assertReusableCiBuild();
	else {
		buildWorkspacePackages();
		buildFixture();
	}
	checkAdminClientBundle();
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main();
}
