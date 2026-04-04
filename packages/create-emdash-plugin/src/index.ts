#!/usr/bin/env node

/**
 * create-emdash-plugin
 *
 * Scaffolds a new EmDash CMS plugin with:
 * - Plugin descriptor (index.ts)
 * - Sandbox entry (sandbox-entry.ts)
 * - Package.json with correct peer dependencies
 * - TypeScript config
 * - Basic test setup
 * - GitHub Actions CI
 *
 * Usage: npm create emdash-plugin my-plugin
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";

import * as p from "@clack/prompts";
import pc from "picocolors";

const PLUGIN_NAME_RE = /^[a-z][a-z0-9-]*$/;
const CAMEL_RE = /-([a-z])/g;

async function main() {
	p.intro(pc.cyan("create-emdash-plugin"));

	const args = process.argv.slice(2);
	let pluginName = args[0];

	if (!pluginName) {
		const result = await p.text({
			message: "Plugin name:",
			placeholder: "my-awesome-plugin",
			validate: (value) => {
				if (!value) return "Plugin name is required";
				if (!PLUGIN_NAME_RE.test(value)) return "Use lowercase letters, numbers, and hyphens";
				return undefined;
			},
		});

		if (p.isCancel(result)) {
			p.cancel("Cancelled.");
			process.exit(0);
		}
		pluginName = result;
	}

	const description = await p.text({
		message: "Description:",
		placeholder: `An EmDash plugin for ${pluginName}`,
	});

	if (p.isCancel(description)) {
		p.cancel("Cancelled.");
		process.exit(0);
	}

	const capabilities = await p.multiselect({
		message: "Capabilities:",
		options: [
			{ value: "read:content", label: "Read content", hint: "Access published content" },
			{ value: "write:content", label: "Write content", hint: "Create and modify content" },
			{ value: "read:media", label: "Read media", hint: "Access media files" },
			{ value: "email:send", label: "Send email", hint: "Send emails via configured pipeline" },
		],
		required: false,
	});

	if (p.isCancel(capabilities)) {
		p.cancel("Cancelled.");
		process.exit(0);
	}

	const replaces = await p.text({
		message: "WordPress plugins this replaces (comma-separated, or empty):",
		placeholder: "e.g., yoast-seo, contact-form-7",
		defaultValue: "",
	});

	if (p.isCancel(replaces)) {
		p.cancel("Cancelled.");
		process.exit(0);
	}

	const dir = resolve(process.cwd(), pluginName);

	if (existsSync(dir)) {
		p.cancel(`Directory "${pluginName}" already exists.`);
		process.exit(1);
	}

	const s = p.spinner();
	s.start("Scaffolding plugin...");

	// Create directory structure
	mkdirSync(join(dir, "src"), { recursive: true });
	mkdirSync(join(dir, ".github", "workflows"), { recursive: true });

	const packageName = `@emdash-cms/plugin-${pluginName}`;
	const pluginId = pluginName;
	const capsArray = (capabilities as string[]) || [];
	const replacesArray = (replaces as string)
		.split(",")
		.map((part) => part.trim())
		.filter(Boolean);

	// package.json
	writeFileSync(
		join(dir, "package.json"),
		JSON.stringify(
			{
				name: packageName,
				version: "0.1.0",
				description: description || `EmDash plugin: ${pluginName}`,
				type: "module",
				main: "src/index.ts",
				exports: {
					".": "./src/index.ts",
					"./sandbox": "./src/sandbox-entry.ts",
				},
				files: ["src"],
				keywords: ["emdash", "cms", "plugin", pluginName],
				license: "MIT",
				peerDependencies: {
					emdash: "*",
				},
				scripts: {
					typecheck: "tsgo --noEmit",
					test: "vitest run",
				},
				devDependencies: {
					vitest: "^3.0.0",
				},
			},
			null,
			"\t",
		) + "\n",
	);

	// tsconfig.json
	writeFileSync(
		join(dir, "tsconfig.json"),
		JSON.stringify(
			{
				compilerOptions: {
					target: "ES2022",
					module: "preserve",
					strict: true,
					noUncheckedIndexedAccess: true,
					verbatimModuleSyntax: true,
					outDir: "dist",
					rootDir: "src",
				},
				include: ["src"],
			},
			null,
			"\t",
		) + "\n",
	);

	// src/index.ts - Plugin descriptor
	const capsStr =
		capsArray.length > 0
			? `\n\t\tcapabilities: [${capsArray.map((c) => `"${c}"`).join(", ")}],`
			: "";
	const replacesStr =
		replacesArray.length > 0
			? `\n\t\treplaces: [${replacesArray.map((r) => `"${r}"`).join(", ")}],`
			: "";

	writeFileSync(
		join(dir, "src", "index.ts"),
		`/**
 * ${description || pluginName} - EmDash Plugin
 */

import type { PluginDescriptor } from "emdash";

export function ${camelCase(pluginName)}Plugin(): PluginDescriptor {
\treturn {
\t\tid: "${pluginId}",
\t\tversion: "0.1.0",
\t\tformat: "standard",
\t\tentrypoint: "${packageName}/sandbox",${capsStr}${replacesStr}
\t\tstorage: {
\t\t\tsettings: {},
\t\t},
\t};
}

export default ${camelCase(pluginName)}Plugin;
`,
	);

	// src/sandbox-entry.ts - Sandbox entry point
	writeFileSync(
		join(dir, "src", "sandbox-entry.ts"),
		`/**
 * ${pluginName} - Sandbox entry point
 *
 * This runs inside the plugin sandbox with declared capabilities.
 * Edit the hooks below to add your plugin's behavior.
 */

import { definePlugin } from "emdash";

export default () =>
\tdefinePlugin({
\t\tid: "${pluginId}",
\t\tcapabilities: [${capsArray.map((c) => `"${c}"`).join(", ")}],
\t\thooks: {
\t\t\t// Add your hooks here. Example:
\t\t\t// "content:afterSave": async (event, ctx) => {
\t\t\t//   console.log("Content saved:", event.content.data.title);
\t\t\t// },
\t\t},
\t});
`,
	);

	// .github/workflows/ci.yml
	writeFileSync(
		join(dir, ".github", "workflows", "ci.yml"),
		`name: CI
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm install
      - run: npm test
`,
	);

	// README.md
	writeFileSync(
		join(dir, "README.md"),
		`# ${packageName}

${description || `EmDash plugin: ${pluginName}`}

## Install

\`\`\`bash
npm install ${packageName}
\`\`\`

## Usage

Add to your \`live.config.ts\`:

\`\`\`typescript
import { ${camelCase(pluginName)}Plugin } from "${packageName}";

export default emdash({
  plugins: [${camelCase(pluginName)}Plugin()],
});
\`\`\`

## Development

\`\`\`bash
npm test        # Run tests
npm run typecheck  # Type check
\`\`\`

## Publishing

\`\`\`bash
emdash publish  # Publish to the EmDash marketplace
\`\`\`
`,
	);

	s.stop("Plugin scaffolded!");

	p.note(
		[
			`cd ${pluginName}`,
			"npm install",
			"npm test",
			"",
			"Then add to your EmDash site's live.config.ts:",
			`  import { ${camelCase(pluginName)}Plugin } from "${packageName}";`,
		].join("\n"),
		"Next steps",
	);

	p.outro(pc.green("Happy building!"));
}

function camelCase(str: string): string {
	return str.replace(CAMEL_RE, (_, c) => c.toUpperCase());
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
