/**
 * Pure file-content producers for `emdash-plugin init`.
 *
 * No filesystem access here — each function takes the inputs and returns
 * the bytes that should land at the target path. Keeping these as pure
 * functions makes the scaffolder testable without touching disk and
 * keeps every template inspectable in one place.
 *
 * The shape produced is the authoring contract:
 *
 *   emdash-plugin.jsonc   — identity + trust contract + profile
 *   src/plugin.ts         — explicitly typed `SandboxedPlugin` runtime definition
 *   package.json          — type:module, devDep on @emdash-cms/plugin-cli
 *   tsconfig.json         — strict, standalone
 *   .gitignore
 *   README.md
 *   tests/plugin.test.ts
 *   AGENTS.md
 *   skills/creating-plugins/SKILL.md
 *   .agents/skills -> ../skills
 *   .claude/skills -> ../skills
 *   .claude/CLAUDE.md -> ../AGENTS.md
 *   pnpm-workspace.yaml   — pnpm projects only
 *
 * No `src/index.ts`, no `dist/` in source control. `emdash-plugin build`
 * generates `dist/` artefacts (plugin.mjs, manifest.json, index.mjs).
 */

import type { ManifestAuthor, ManifestSecurityContact } from "../manifest/schema.js";

export type ScaffoldPackageManager = "bun" | "npm" | "pnpm" | "yarn";

/**
 * Inputs to the scaffolder.
 *
 * The pure renderers can represent missing values for prompt previews,
 * but the scaffold validates required ownership metadata before it
 * writes the project.
 */
export interface ScaffoldInputs {
	/** Plugin slug. Used as the directory name and the `slug` field. */
	slug: string;
	/**
	 * Pre-filled publisher DID (resolved from a handle if the user
	 * typed one). When undefined, the manifest carries a TODO comment
	 * and an empty string; the author must set this before the plugin
	 * will load.
	 *
	 * The runtime only ever compares DIDs, so we write a DID — even if
	 * the user typed a handle. The handle, when known, is emitted as a
	 * `// <handle>` line comment next to the pinned DID via
	 * `publisherHandle` below.
	 */
	publisher: string | undefined;
	/**
	 * Optional handle that resolved to the `publisher` DID. Rendered as
	 * a `// <handle>` line comment next to the pinned DID so a `git
	 * diff` reviewer sees a human-readable name for the publisher. The
	 * CLI ignores the comment on subsequent reads — only the DID is
	 * authoritative.
	 */
	publisherHandle: string | undefined;
	/** SPDX license expression. Defaults to "MIT" when undefined. */
	license: string | undefined;
	/**
	 * Author block. When undefined, the manifest carries a TODO
	 * comment and a placeholder name; author.url and author.email
	 * are omitted from the output entirely (the schema makes them
	 * optional).
	 */
	author: ManifestAuthor | undefined;
	/**
	 * Security contact. When undefined, the manifest carries a TODO
	 * comment and a placeholder email; the author replaces it with
	 * a real contact before publishing.
	 */
	security: ManifestSecurityContact | undefined;
	/** Optional short description. Omitted from the manifest when undefined. */
	description: string | undefined;
	/** Optional repo URL. Omitted from the manifest when undefined. */
	repo: string | undefined;
	/** Package manager selected from the invocation or an explicit flag. */
	packageManager: ScaffoldPackageManager;
	/** Exact package-manager version when detected. */
	packageManagerVersion: string;
	/** Exact plugin CLI version that generated the project. */
	cliVersion: string;
}

/**
 * `emdash-plugin.jsonc` — the manifest. Includes a `$schema` pointer
 * for editor completion. JSONC: tab-indented, no trailing comma on the
 * final field. Fields omitted when the input is empty so the generated
 * file is the smallest valid manifest, not a sea of `""`.
 */
export function renderManifest(input: ScaffoldInputs): string {
	const lines: string[] = [];
	lines.push("{");
	lines.push(
		'\t"$schema": "./node_modules/@emdash-cms/plugin-cli/schemas/emdash-plugin.schema.json",',
	);
	lines.push("");
	lines.push(`\t"slug": ${jsonString(input.slug)},`);
	// `version` deliberately omitted — the build reads it from
	// `package.json` so there's a single source of truth. Registry-only
	// plugins (no package.json) would set it here, but the scaffold
	// always emits one.

	if (!input.publisher) {
		lines.push(
			'\t// TODO: set your atproto handle (e.g. "example.com") or DID before running `emdash-plugin bundle` or any local-dev integration. The plugin cannot load without it.',
		);
		lines.push('\t"publisher": "",');
	} else {
		// When we know the handle that resolved to this DID, append it
		// as a line comment for `git diff` readability. The handle is
		// purely informational — the CLI never reads it back.
		const trailer = input.publisherHandle ? ` // ${input.publisherHandle}` : "";
		lines.push(`\t"publisher": ${jsonString(input.publisher)},${trailer}`);
	}

	lines.push("");
	lines.push(`\t"license": ${jsonString(input.license ?? "MIT")},`);

	if (input.author) {
		lines.push(`\t"author": ${renderAuthor(input.author)},`);
	} else {
		lines.push(
			"\t// TODO: replace the placeholder with your real name and (optionally) url/email before publishing.",
		);
		lines.push(
			`\t"author": { "name": ${jsonString(`TODO: replace with your name (${input.slug} author)`)} },`,
		);
	}

	if (input.security) {
		lines.push(`\t"security": ${renderSecurityContact(input.security)},`);
	} else {
		lines.push(
			"\t// TODO: replace the placeholder with a real security contact email or url before publishing. The lexicon mandates at least one.",
		);
		lines.push('\t"security": { "email": "TODO@example.com" },');
	}

	if (input.description) {
		lines.push(`\t"description": ${jsonString(input.description)},`);
	}
	if (input.repo) {
		lines.push(`\t"repo": ${jsonString(input.repo)},`);
	}

	lines.push("");
	lines.push("\t// Trust contract — what runtime APIs the plugin asks for.");
	lines.push("\t// Empty arrays mean no extra privileges beyond logging,");
	lines.push("\t// KV, and route/hook registration. Changing these between");
	lines.push("\t// releases requires a version bump because installed");
	lines.push("\t// users have consented to the old contract.");
	lines.push('\t"capabilities": [],');
	lines.push('\t"allowedHosts": [],');
	lines.push('\t"storage": {}');
	lines.push("}");
	lines.push("");
	return lines.join("\n");
}

/**
 * Render a single author object as a JSONC inline value. Always
 * single-line so the generated manifest stays compact.
 */
function renderAuthor(author: ManifestAuthor): string {
	const parts: string[] = [`"name": ${jsonString(author.name)}`];
	if (author.url) parts.push(`"url": ${jsonString(author.url)}`);
	if (author.email) parts.push(`"email": ${jsonString(author.email)}`);
	return `{ ${parts.join(", ")} }`;
}

/**
 * Render a single security contact as a JSONC inline value.
 */
function renderSecurityContact(contact: ManifestSecurityContact): string {
	const parts: string[] = [];
	if (contact.email) parts.push(`"email": ${jsonString(contact.email)}`);
	if (contact.url) parts.push(`"url": ${jsonString(contact.url)}`);
	return `{ ${parts.join(", ")} }`;
}

/**
 * `src/plugin.ts` — runtime code. One route, no hooks. Demonstrates the
 * two primitives a sandboxed plugin author needs: the strict
 * `SandboxedPlugin` type (which infers handler signatures per hook /
 * route name) and a default-exported runtime definition.
 */
export function renderPluginEntry(): string {
	return `import type { SandboxedPlugin } from "emdash/plugin";

/**
 * Sandboxed plugin entry. The explicit \`SandboxedPlugin\` annotation gives TypeScript per-hook /
 * per-route inference (\`ctx\` is \`PluginContext\` automatically; hook
 * \`event\` parameters are typed by hook name).
 */
const plugin: SandboxedPlugin = {
\troutes: {
\t\thello: {
\t\t\thandler: async (_routeCtx, ctx) => {
\t\t\t\tctx.log.info("hello route called", { pluginId: ctx.plugin.id });
\t\t\t\treturn { greeting: "hello", pluginId: ctx.plugin.id };
\t\t\t},
\t\t},
\t},
};

export default plugin;
`;
}

/**
 * `package.json` — npm-shape so the plugin is `pnpm add`-able. The
 * scaffold sets `private: true` defensively; flip it off when you're
 * ready to publish to npm. `version` here is the single source of
 * truth — the build reads it and writes it into the bundled manifest.
 *
 * `./sandbox` export points at the built runtime bytes that both
 * in-process and isolate loaders consume. `main` / `import` point at
 * the auto-generated descriptor module the integration imports for
 * default in `astro.config.mjs`.
 */
export function renderPackageJson(input: ScaffoldInputs): string {
	const pkg = {
		name: input.slug,
		version: "0.1.0",
		private: true,
		type: "module",
		packageManager: `${input.packageManager}@${input.packageManagerVersion}`,
		main: "dist/index.mjs",
		exports: {
			".": {
				import: "./dist/index.mjs",
				types: "./dist/index.d.mts",
			},
			"./sandbox": "./dist/plugin.mjs",
		},
		files: ["dist", "emdash-plugin.jsonc"],
		scripts: {
			validate: "emdash-plugin validate",
			build: "emdash-plugin build",
			dev: "emdash-plugin dev",
			typecheck: "tsc --noEmit",
			test: "emdash-plugin validate && vitest run",
			bundle: "emdash-plugin bundle",
			login: "emdash-plugin login",
			publish: "emdash-plugin publish",
			"release:setup": "emdash-plugin release setup",
		},
		peerDependencies: {
			emdash: ">=0.12.0",
		},
		devDependencies: {
			"@emdash-cms/plugin-cli": input.cliVersion,
			emdash: ">=0.12.0 <1.0.0",
			typescript: "^5.9.0",
			vitest: "^4.1.0",
		},
	};
	return `${JSON.stringify(pkg, null, "\t")}\n`;
}

/**
 * `tsconfig.json` — strict, ES2022, bundler resolution. Mirrors the
 * `node22 + bundler` style the rest of the EmDash workspace uses, but
 * doesn't extend anything from the workspace so the scaffold is
 * self-contained.
 */
export function renderTsconfig(): string {
	const config = {
		compilerOptions: {
			target: "ES2022",
			module: "preserve",
			moduleResolution: "bundler",
			strict: true,
			esModuleInterop: true,
			verbatimModuleSyntax: true,
			skipLibCheck: true,
			types: [],
		},
		include: ["src/**/*", "tests/**/*"],
		exclude: ["node_modules"],
	};
	return `${JSON.stringify(config, null, "\t")}\n`;
}

/**
 * `.gitignore` — node_modules + dist (build output should not be
 * committed; rebuild on every install).
 */
export function renderGitignore(): string {
	return "node_modules/\ndist/\n";
}

/**
 * `README.md` — three sections: develop, publish, version-bump rules.
 * Nothing else. The author can extend; the scaffold doesn't pre-write
 * marketing copy.
 */
export function renderReadme(input: ScaffoldInputs): string {
	const title = input.slug;
	const importBinding = toCamelCase(input.slug);
	const install = `${input.packageManager} install`;
	const run = (script: string) => `${input.packageManager} run ${script}`;
	const addLocal =
		input.packageManager === "npm"
			? "npm install file:../path/to/this"
			: `${input.packageManager} add file:../path/to/this`;
	return `# ${title}

A sandboxed plugin for [EmDash CMS](https://emdashcms.com).

## Develop

\`\`\`sh
${install}
${run("validate")}
${run("typecheck")}
${run("test")}
${run("build")}
\`\`\`

To test against a running EmDash site, run \`${run("dev")}\` in this
directory (rebuilds on save) and \`${addLocal}\`
in the site. Then \`import ${importBinding} from "${input.slug}"\` and pass
it into \`emdash({ sandboxed: [${importBinding}] })\`.

## Publish

\`\`\`sh
${run("login")} -- alice.example.com
${run("publish")}          # builds and uploads artifacts to your PDS
\`\`\`

To publish from GitHub Actions, run \`${run("release:setup")}\`. The command
creates one shared workflow at the Git repository root.

## Version bumps

Bump \`version\` in \`package.json\` when you ship a release. The
scaffold's \`emdash-plugin.jsonc\` deliberately omits \`version\` —
the build pipeline reads it from \`package.json\` so there's a single
source of truth. **Bump major** for breaking changes, **bump minor**
for new routes or hooks, **bump patch** for fixes.

You MUST bump version whenever you change \`capabilities\`, \`allowedHosts\`,
or \`storage\` in the manifest. Installed users have consented to the
old trust contract; a change without a version bump would let new
behaviour slip past consent.
`;
}

/**
 * `tests/plugin.test.ts` — one passing test that exercises the
 * hello route. Uses a minimal stubbed PluginContext rather than
 * pulling in the runtime: the test asserts the handler returns the
 * expected shape, not that the runtime wires it up correctly.
 */
export function renderTest(input: ScaffoldInputs): string {
	return `import { describe, expect, it } from "vitest";

import plugin from "../src/plugin.js";

describe("hello route", () => {
\tit("returns a greeting", async () => {
\t\tconst handler = plugin.routes?.hello;
\t\tif (!handler || typeof handler !== "object" || !("handler" in handler)) {
\t\t\tthrow new Error("hello route handler not found");
\t\t}
\t\tconst result = await handler.handler({} as never, makeTestContext());
\t\texpect(result).toEqual({ greeting: "hello", pluginId: ${JSON.stringify(input.slug)} });
\t});
});

function makeTestContext() {
\t// Minimal stub PluginContext: the hello route only reads
\t// \`ctx.log.info\` and \`ctx.plugin.id\`. Real PluginContext has many
\t// more methods; add them as your plugin grows.
\treturn {
\t\tplugin: { id: ${JSON.stringify(input.slug)}, version: "0.1.0" },
\t\tlog: {
\t\t\tinfo: () => {},
\t\t\twarn: () => {},
\t\t\terror: () => {},
\t\t\tdebug: () => {},
\t\t},
\t} as unknown as import("emdash").PluginContext;
}
`;
}

export function renderPnpmWorkspace(): string {
	return `packages:
  - "."

strictDepBuilds: true
dangerouslyAllowAllBuilds: false
allowBuilds:
  esbuild: true
`;
}

export function renderAgentsGuide(): string {
	return `# Agent instructions

Before editing this plugin, read \`skills/creating-plugins/SKILL.md\` completely. Codex discovers the same directory through \`.agents/skills\`; Claude discovers it through \`.claude/skills\` and reads these instructions through \`.claude/CLAUDE.md\`.
Keep \`emdash-plugin.jsonc\` aligned with the runtime implementation, declare every capability and host the plugin uses, and run the generated validation, typecheck, test, and build scripts after changes.
`;
}

export function renderCreatingPluginsSkill(): string {
	return `---
name: creating-plugins
description: Build, test, and publish this sandboxed EmDash plugin. Use for changes to emdash-plugin.jsonc, src/plugin.ts, hooks, routes, capabilities, storage, Block Kit admin UI, bundling, or releases.
---

# Creating EmDash plugins

Read \`emdash-plugin.jsonc\` and \`src/plugin.ts\` before editing. The manifest is the identity and trust contract; the source contains runtime hooks and routes.

## Runtime rules

- Assign the runtime definition to a \`SandboxedPlugin\`-typed constant and export it as default from \`src/plugin.ts\`.
- Use Web APIs. Do not import Node.js built-ins into plugin runtime code.
- Declare every runtime API in \`capabilities\` and every network destination in \`allowedHosts\`.
- Use \`ctx.storage\` for queryable records and \`ctx.kv\` for key-value state.
- Use Block Kit for sandboxed admin UI. Do not ship browser React components.
- Treat public routes as internet-facing and validate their inputs.

## Validation

Use the package scripts in this repository. Before handing off a change, run validation, typecheck, tests, and build. A release also requires a version bump in \`package.json\` when runtime behavior or the trust contract changes.

## Publishing

Use the local publish script for a release started from this computer. Use the release-setup script for GitHub Actions. The first automated release connects the repository workflow; later packages reuse it only when their signed profiles name the same repository.

For complete EmDash patterns and API details, use https://docs.emdashcms.com/plugins/creating-plugins/.
`;
}

/**
 * JSON-stringify a string with double quotes and proper escaping.
 * Trivially `JSON.stringify` does the job, but wrapping it gives us
 * a single place to switch quote styles or escape behaviour later.
 */
function jsonString(value: string): string {
	return JSON.stringify(value);
}

const SLUG_SEPARATOR_RE = /[-_]([a-z0-9])/g;

/**
 * Convert a plugin slug (`my-plugin`, `my_plugin`) into a JS identifier
 * for use as an import binding. Slugs are validated to start with a
 * letter (see `PLUGIN_SLUG_RE`), so the result is always a legal
 * identifier.
 */
function toCamelCase(slug: string): string {
	return slug.replace(SLUG_SEPARATOR_RE, (_, ch: string) => ch.toUpperCase());
}
