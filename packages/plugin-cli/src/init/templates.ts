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
 *   src/plugin.ts         — `{ routes?, hooks? } satisfies SandboxedPlugin`
 *   package.json          — type:module, devDep on @emdash-cms/plugin-cli
 *   tsconfig.json         — strict, standalone
 *   .gitignore
 *   README.md
 *   tests/plugin.test.ts
 *
 * No `src/index.ts`, no `dist/` in source control. `emdash-plugin build`
 * generates `dist/` artefacts (plugin.mjs, manifest.json, index.mjs).
 */

import type { ManifestAuthor, ManifestSecurityContact } from "../manifest/schema.js";

/**
 * Inputs to the scaffolder.
 *
 * Every field except `slug` is optional. Missing fields produce a
 * placeholder in the generated manifest — either a `TODO:` line
 * comment marking a value the author must fill in before the plugin
 * works, or an outright omission of an optional field that the
 * schema doesn't require.
 *
 * The contract: a scaffold produced from `{ slug }` alone is a valid
 * starting point that the author can `cd` into, fix the TODOs in,
 * and ship. There are no "init failed because you didn't pass enough
 * flags" surprises.
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
 * route name) and a default-exported `{ hooks?, routes? }` object.
 */
export function renderPluginEntry(): string {
	return `import type { SandboxedPlugin } from "emdash/plugin";

/**
 * Sandboxed plugin entry. The default export is a bare object; the
 * \`satisfies SandboxedPlugin\` annotation gives TypeScript per-hook /
 * per-route inference (\`ctx\` is \`PluginContext\` automatically; hook
 * \`event\` parameters are typed by hook name).
 */
export default {
\troutes: {
\t\thello: {
\t\t\thandler: async (_routeCtx, ctx) => {
\t\t\t\tctx.log.info("hello route called", { pluginId: ctx.plugin.id });
\t\t\t\treturn { greeting: "hello", pluginId: ctx.plugin.id };
\t\t\t},
\t\t},
\t},
} satisfies SandboxedPlugin;
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
			build: "emdash-plugin build",
			dev: "emdash-plugin dev",
			typecheck: "tsc --noEmit",
			test: "vitest run",
		},
		peerDependencies: {
			emdash: ">=0.12.0",
		},
		devDependencies: {
			"@emdash-cms/plugin-cli": ">=0.1.0",
			emdash: ">=0.12.0",
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
	return `# ${title}

A sandboxed plugin for [EmDash CMS](https://emdashcms.com).

## Develop

\`\`\`sh
pnpm install
pnpm typecheck
pnpm test
\`\`\`

To test against a running EmDash site, run \`pnpm dev\` in this
directory (rebuilds on save) and \`pnpm add file:../path/to/this\`
in the site. Then \`import ${title} from "${input.slug}"\` and pass
it into \`emdash({ sandboxed: [${title}] })\`.

## Publish

\`\`\`sh
emdash-plugin login        # if you're not already logged in
emdash-plugin bundle       # produces dist/${title}-<version>.tar.gz
# upload that tarball to a public URL, then:
emdash-plugin publish --url https://your-host/...
\`\`\`

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
export function renderTest(): string {
	return `import { describe, expect, it } from "vitest";

import plugin from "../src/plugin.js";

describe("hello route", () => {
\tit("returns a greeting", async () => {
\t\tconst handler = plugin.routes?.hello;
\t\tif (!handler || typeof handler !== "object" || !("handler" in handler)) {
\t\t\tthrow new Error("hello route handler not found");
\t\t}
\t\tconst result = await handler.handler({} as never, makeTestContext());
\t\texpect(result).toEqual({ greeting: "hello", pluginId: "test-plugin" });
\t});
});

function makeTestContext() {
\t// Minimal stub PluginContext: the hello route only reads
\t// \`ctx.log.info\` and \`ctx.plugin.id\`. Real PluginContext has many
\t// more methods; add them as your plugin grows.
\treturn {
\t\tplugin: { id: "test-plugin", version: "0.1.0" },
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

/**
 * JSON-stringify a string with double quotes and proper escaping.
 * Trivially `JSON.stringify` does the job, but wrapping it gives us
 * a single place to switch quote styles or escape behaviour later.
 */
function jsonString(value: string): string {
	return JSON.stringify(value);
}
