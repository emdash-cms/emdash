/**
 * emdash plugin init
 *
 * Scaffold a new EmDash plugin. Generates the sandboxed-format boilerplate:
 *   src/index.ts         -- descriptor factory
 *   src/sandbox-entry.ts -- definePlugin({ hooks, routes })
 *   package.json
 *   tsconfig.json
 *
 * Use --format=native (or --native) to generate native-format boilerplate
 * instead (createPlugin + React admin). When neither is passed and stdout
 * is a TTY, the user is prompted to choose.
 *
 */

import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join, basename } from "node:path";

import { defineCommand } from "citty";
import consola from "consola";

import { fileExists } from "./bundle-utils.js";

const SLUG_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const SCOPE_RE = /^@[^/]+\//;

type PluginFormat = "standard" | "native";

export const pluginInitCommand = defineCommand({
	meta: {
		name: "init",
		description: "Scaffold a new plugin",
	},
	args: {
		dir: {
			type: "string",
			description: "Directory to create the plugin in (default: current directory)",
			default: ".",
		},
		name: {
			type: "string",
			description: "Plugin name/id (e.g. my-plugin or @org/my-plugin)",
		},
		format: {
			type: "string",
			description:
				"Plugin format: sandboxed or native. Prompts when running interactively if not set.",
			valueHint: "sandboxed|native",
		},
		native: {
			type: "boolean",
			description: "Shortcut for --format=native",
			default: false,
		},
	},
	async run({ args }) {
		const targetDir = resolve(args.dir);

		const format = await resolveFormat(args.format, args.native);
		if (!format) {
			consola.info("Cancelled");
			return;
		}
		const isNative = format === "native";

		// Derive plugin name from --name or directory name
		let pluginName = args.name || basename(targetDir);
		if (!pluginName || pluginName === ".") {
			pluginName = basename(resolve("."));
		}

		// Strip scope for the slug
		const slug = pluginName.replace(SCOPE_RE, "");
		if (!SLUG_RE.test(slug)) {
			consola.error(
				`Invalid plugin name "${pluginName}". ` +
					"Use lowercase letters, numbers, and hyphens (e.g. my-plugin).",
			);
			process.exit(1);
		}

		// Check if directory already has files
		const srcDir = join(targetDir, "src");
		const pkgPath = join(targetDir, "package.json");
		if (await fileExists(pkgPath)) {
			consola.error(`package.json already exists in ${targetDir}`);
			process.exit(1);
		}

		consola.start(`Scaffolding ${isNative ? "native" : "sandboxed"} plugin: ${pluginName}`);

		await mkdir(srcDir, { recursive: true });

		if (isNative) {
			await scaffoldNative(targetDir, srcDir, pluginName, slug);
		} else {
			await scaffoldStandard(targetDir, srcDir, pluginName, slug);
		}

		consola.success(`Plugin scaffolded in ${targetDir}`);
		consola.info("Next steps:");
		const steps: string[] = [];
		if (args.dir !== ".") steps.push(`cd ${args.dir}`);
		steps.push("pnpm install");
		steps.push(
			isNative
				? "Edit src/index.ts to add hooks and routes"
				: "Edit src/sandbox-entry.ts to add hooks and routes",
		);
		steps.push("pnpm build");
		if (!isNative) steps.push("emdash plugin validate --dir .");
		steps.forEach((step, i) => consola.info(`  ${i + 1}. ${step}`));
	},
});

async function resolveFormat(
	formatArg: string | undefined,
	nativeFlag: boolean,
): Promise<PluginFormat | null> {
	if (formatArg) {
		const normalized = formatArg.toLowerCase();
		let parsed: PluginFormat;
		if (normalized === "native") {
			parsed = "native";
		} else if (normalized === "sandboxed" || normalized === "standard") {
			parsed = "standard";
		} else {
			consola.error(`Invalid --format "${formatArg}". Use "sandboxed" or "native".`);
			process.exit(1);
		}
		if (nativeFlag && parsed !== "native") {
			consola.error(`Conflicting flags: --native and --format=${formatArg}. Pass only one.`);
			process.exit(1);
		}
		return parsed;
	}
	if (nativeFlag) return "native";

	if (!process.stdout.isTTY) return "standard";

	const choice = await consola.prompt("Which plugin format?", {
		type: "select",
		initial: "standard",
		options: [
			{
				label: "Sandboxed",
				value: "standard",
				hint: "runs in an isolated sandbox; safe to install from the marketplace",
			},
			{
				label: "Native",
				value: "native",
				hint: "full runtime access; install from npm",
			},
		],
		cancel: "null",
	});
	if (choice === null) return null;
	return choice as PluginFormat;
}

function camelCase(slug: string): string {
	return slug
		.split("-")
		.map((s, i) => (i === 0 ? s : s[0].toUpperCase() + s.slice(1)))
		.join("");
}

function pascalCase(slug: string): string {
	return slug
		.split("-")
		.map((s) => s[0].toUpperCase() + s.slice(1))
		.join("");
}

const TSCONFIG = {
	compilerOptions: {
		target: "ES2022",
		module: "preserve",
		moduleResolution: "bundler",
		strict: true,
		esModuleInterop: true,
		declaration: true,
		outDir: "./dist",
		rootDir: "./src",
	},
	include: ["src/**/*"],
	exclude: ["node_modules", "dist"],
} as const;

const TSDOWN_VERSION = "^0.20.0";
const TYPESCRIPT_VERSION = "^5.9.0";

// ── Sandboxed format scaffolding ─────────────────────────────────

async function scaffoldStandard(
	targetDir: string,
	srcDir: string,
	pluginName: string,
	slug: string,
): Promise<void> {
	const fnName = camelCase(slug);

	await writeFile(
		join(targetDir, "package.json"),
		JSON.stringify(
			{
				name: pluginName,
				version: "0.1.0",
				type: "module",
				main: "./dist/index.mjs",
				exports: {
					".": {
						types: "./dist/index.d.mts",
						import: "./dist/index.mjs",
					},
					"./sandbox": {
						types: "./dist/sandbox-entry.d.mts",
						import: "./dist/sandbox-entry.mjs",
					},
				},
				files: ["dist"],
				scripts: {
					build: "tsdown src/index.ts src/sandbox-entry.ts --format esm --dts --clean",
					dev: "tsdown src/index.ts src/sandbox-entry.ts --format esm --dts --watch",
					typecheck: "tsc --noEmit",
				},
				keywords: ["emdash", "emdash-plugin"],
				license: "MIT",
				peerDependencies: {
					emdash: "*",
				},
				devDependencies: {
					emdash: "*",
					tsdown: TSDOWN_VERSION,
					typescript: TYPESCRIPT_VERSION,
				},
			},
			null,
			"\t",
		) + "\n",
	);

	await writeFile(join(targetDir, "tsconfig.json"), JSON.stringify(TSCONFIG, null, "\t") + "\n");

	await writeFile(
		join(srcDir, "index.ts"),
		`import type { PluginDescriptor } from "emdash";

export function ${fnName}Plugin(): PluginDescriptor {
\treturn {
\t\tid: "${slug}",
\t\tversion: "0.1.0",
\t\tformat: "standard",
\t\tentrypoint: "${pluginName}/sandbox",

\t\tcapabilities: ["content:read"],
\t\tstorage: {
\t\t\tevents: { indexes: ["timestamp"] },
\t\t},
\t};
}
`,
	);

	await writeFile(
		join(srcDir, "sandbox-entry.ts"),
		`import { definePlugin } from "emdash";
import type { PluginContext } from "emdash";

interface ContentSaveEvent {
\tcollection: string;
\tcontent: { id: string };
\tisNew: boolean;
}

export default definePlugin({
\thooks: {
\t\t"content:afterSave": {
\t\t\thandler: async (event: ContentSaveEvent, ctx: PluginContext) => {
\t\t\t\tctx.log.info("Content saved", {
\t\t\t\t\tcollection: event.collection,
\t\t\t\t\tid: event.content.id,
\t\t\t\t});

\t\t\t\tawait ctx.storage.events.put(\`save-\${Date.now()}\`, {
\t\t\t\t\ttimestamp: new Date().toISOString(),
\t\t\t\t\tcollection: event.collection,
\t\t\t\t\tcontentId: event.content.id,
\t\t\t\t});
\t\t\t},
\t\t},
\t},

\troutes: {
\t\trecent: {
\t\t\thandler: async (_routeCtx, ctx: PluginContext) => {
\t\t\t\tconst result = await ctx.storage.events.query({
\t\t\t\t\torderBy: { timestamp: "desc" },
\t\t\t\t\tlimit: 10,
\t\t\t\t});
\t\t\t\treturn { events: result.items };
\t\t\t},
\t\t},
\t},
});
`,
	);
}

// ── Native format scaffolding ────────────────────────────────────

async function scaffoldNative(
	targetDir: string,
	srcDir: string,
	pluginName: string,
	slug: string,
): Promise<void> {
	const fnName = camelCase(slug);
	const typeName = pascalCase(slug);

	await writeFile(
		join(targetDir, "package.json"),
		JSON.stringify(
			{
				name: pluginName,
				version: "0.1.0",
				type: "module",
				main: "./dist/index.mjs",
				exports: {
					".": {
						types: "./dist/index.d.mts",
						import: "./dist/index.mjs",
					},
				},
				files: ["dist"],
				scripts: {
					build: "tsdown src/index.ts --format esm --dts --clean",
					dev: "tsdown src/index.ts --format esm --dts --watch",
					typecheck: "tsc --noEmit",
				},
				keywords: ["emdash", "emdash-plugin"],
				license: "MIT",
				peerDependencies: {
					emdash: "*",
				},
				devDependencies: {
					emdash: "*",
					tsdown: TSDOWN_VERSION,
					typescript: TYPESCRIPT_VERSION,
				},
			},
			null,
			"\t",
		) + "\n",
	);

	await writeFile(join(targetDir, "tsconfig.json"), JSON.stringify(TSCONFIG, null, "\t") + "\n");

	await writeFile(
		join(srcDir, "index.ts"),
		`import { definePlugin } from "emdash";
import type { PluginDescriptor } from "emdash";

export interface ${typeName}Options {
\tenabled?: boolean;
}

export function ${fnName}Plugin(options: ${typeName}Options = {}): PluginDescriptor<${typeName}Options> {
\treturn {
\t\tid: "${slug}",
\t\tversion: "0.1.0",
\t\tformat: "native",
\t\tentrypoint: "${pluginName}",
\t\toptions,
\t};
}

export function createPlugin(options: ${typeName}Options = {}) {
\treturn definePlugin({
\t\tid: "${slug}",
\t\tversion: "0.1.0",

\t\tcapabilities: ["content:read"],
\t\tstorage: {
\t\t\tevents: { indexes: ["createdAt"] },
\t\t},

\t\thooks: {
\t\t\t"content:afterSave": async (event, ctx) => {
\t\t\t\tif (options.enabled === false) return;
\t\t\t\tawait ctx.storage.events.put(\`evt_\${Date.now()}\`, {
\t\t\t\t\tcollection: event.collection,
\t\t\t\t\tcontentId: event.content.id,
\t\t\t\t\tcreatedAt: new Date().toISOString(),
\t\t\t\t});
\t\t\t},
\t\t},

\t\troutes: {
\t\t\trecent: {
\t\t\t\thandler: async (ctx) => {
\t\t\t\t\tconst result = await ctx.storage.events.query({
\t\t\t\t\t\torderBy: { createdAt: "desc" },
\t\t\t\t\t\tlimit: 10,
\t\t\t\t\t});
\t\t\t\t\treturn { events: result.items };
\t\t\t\t},
\t\t\t},
\t\t},
\t});
}

export default createPlugin;
`,
	);
}
