/**
 * `emdash-registry init [name]`
 *
 * Scaffold a new sandboxed plugin. Produces the three-file authoring
 * contract (manifest + src/plugin.ts + package.json) plus tsconfig,
 * README, .gitignore, and a passing test.
 *
 * Three modes:
 *
 *   1. Interactive (default on a TTY): clack prompts for each unset
 *      field with sensible defaults. ESC / Ctrl+C cancels cleanly.
 *   2. `--yes` / `-y` (non-interactive): no prompts; unset fields
 *      become TODO placeholders in the generated manifest. The user
 *      fixes them before first use.
 *   3. Non-TTY (CI, pipes): same as `--yes`. Prompting into a
 *      non-interactive stdin would hang.
 *
 * In all modes, explicit flags win — they're treated as final answers
 * and skip the prompt for that field.
 *
 * Exit codes:
 *   0 — scaffold written.
 *   1 — input validation failed, target conflict (without --force),
 *       prompt cancelled, or filesystem error.
 */

import { basename, resolve } from "node:path";

import { isDid, isHandle } from "@atcute/lexicons/syntax";
import * as clack from "@clack/prompts";
import { isPluginSlug } from "@emdash-cms/plugin-types";
import { FileCredentialStore } from "@emdash-cms/registry-client";
import { defineCommand } from "citty";
import consola from "consola";
import pc from "picocolors";

import { probeEnvironment, type EnvironmentDefaults } from "../init/environment.js";
import { InitError, scaffold } from "../init/scaffold.js";
import type { ScaffoldInputs } from "../init/templates.js";
import { PublisherCheckError, resolveHandleToDid } from "../manifest/publisher.js";

export const initCommand = defineCommand({
	meta: {
		name: "init",
		description:
			"Scaffold a new sandboxed plugin: emdash-plugin.jsonc, src/plugin.ts, package.json, tests, and a README.",
	},
	args: {
		name: {
			type: "positional",
			required: false,
			description:
				"Plugin slug. Used as the directory name and the manifest's `slug` field. If omitted, the slug is derived from the current directory name (or prompted in interactive mode).",
		},
		dir: {
			type: "string",
			description:
				"Target directory. Defaults to ./<name> when `name` is given, or the current directory when it isn't.",
		},
		publisher: {
			type: "string",
			description:
				"Atproto handle or DID. In interactive mode this is prompted; in --yes mode an unset value becomes a TODO placeholder.",
		},
		license: {
			type: "string",
			description: 'SPDX license expression. Defaults to "MIT".',
		},
		"author-name": {
			type: "string",
			description: "Author name.",
		},
		"author-url": {
			type: "string",
			description: "Author URL.",
		},
		"author-email": {
			type: "string",
			description: "Author email.",
		},
		"security-email": {
			type: "string",
			description:
				"Security contact email. Either --security-email or --security-url should be set; in --yes mode an unset value becomes a TODO placeholder.",
		},
		"security-url": {
			type: "string",
			description: "Security contact URL.",
		},
		description: {
			type: "string",
			description: "Short plugin description (omitted from the manifest if not provided).",
		},
		repo: {
			type: "string",
			description: "Source repository URL (omitted from the manifest if not provided).",
		},
		yes: {
			type: "boolean",
			alias: "y",
			description:
				"Skip interactive prompts. Unset fields become TODO placeholders in the manifest. Automatically enabled when stdin is not a TTY.",
			default: false,
		},
		force: {
			type: "boolean",
			description:
				"Overwrite existing files in the target directory. Without this flag, init refuses if any target file already exists.",
			default: false,
		},
	},
	async run({ args }) {
		try {
			await runInit(args);
		} catch (error) {
			if (error instanceof InitError || error instanceof InputError) {
				consola.error(error.message);
				process.exit(1);
			}
			throw error;
		}
	},
});

interface InitArgs {
	name?: string;
	dir?: string;
	publisher?: string;
	license?: string;
	"author-name"?: string;
	"author-url"?: string;
	"author-email"?: string;
	"security-email"?: string;
	"security-url"?: string;
	description?: string;
	repo?: string;
	yes?: boolean;
	force?: boolean;
}

async function runInit(args: InitArgs): Promise<void> {
	// Non-TTY stdin → can't prompt; behave as if --yes were passed.
	// stdout being a pipe is fine (we still write progress); it's the
	// input side that has to be a terminal for prompts to work.
	const interactive = !(args.yes ?? false) && process.stdin.isTTY === true;

	if (interactive) clack.intro(pc.bold("emdash-registry init"));

	// Load the active session (if any). Used to pre-fill the publisher
	// prompt and to silently fill it in `--yes` mode. We swallow load
	// errors entirely — init is reachable from a fresh checkout where
	// the credentials store doesn't exist yet, and a corrupt-store
	// failure should not block scaffolding.
	const session = await loadCurrentSessionSilently();

	// Resolve slug + target dir. Slug may come from positional, --dir's
	// basename, cwd's basename, or (interactive only) a prompt.
	let { slug, targetDir } = resolveSlugAndDir(args);
	if (nonEmpty(args.name) === undefined && nonEmpty(args.dir) === undefined && interactive) {
		const answer = await clack.text({
			message: "Plugin slug",
			placeholder: "my-plugin",
			defaultValue: slug,
		});
		assertNotCancelled(answer);
		if (typeof answer === "string" && answer.trim().length > 0) {
			slug = answer.trim();
			targetDir = resolve(`./${slug}`);
		}
	}

	if (!isPluginSlug(slug)) {
		throw new InputError(
			`Slug "${slug}" is not a valid plugin slug. Expected: lowercase letter, then lowercase letters / digits / "-" / "_" (max 64 chars).`,
		);
	}

	// Probe the surrounding environment for pre-fillable defaults
	// (git user.name / user.email, git remote URL, package.json fields).
	// Probe the target dir if it exists, otherwise cwd — that covers
	// both "init into existing repo skeleton" and "init alongside the
	// current project" workflows. Failures inside the probe are
	// swallowed; missing fields stay undefined.
	const env = await probeEnvironment(await pickProbeDir(targetDir));

	const publisherResult = await resolvePublisher(args, interactive, session);
	const license = await resolveLicense(args, interactive, env);
	const author = await resolveAuthor(args, interactive, env);
	const security = await resolveSecurity(args, interactive);
	const description = await resolveDescription(args, interactive, env);
	const repo = await resolveRepo(args, interactive, env);

	const inputs: ScaffoldInputs = {
		slug,
		publisher: publisherResult?.did,
		publisherHandle: publisherResult?.handle,
		license,
		author,
		security,
		description,
		repo,
	};

	const spin = interactive ? clack.spinner() : null;
	spin?.start(`Scaffolding ${slug} in ${targetDir}`);

	let result;
	try {
		result = await scaffold({
			targetDir,
			inputs,
			force: args.force ?? false,
			onFileWritten: interactive
				? undefined
				: (relPath) => consola.info(`  ${pc.green("+")} ${relPath}`),
		});
	} catch (error) {
		// `error()` on the spinner reports the failure with the right
		// glyph; the outer dispatch handles the actual exit code.
		spin?.error("Scaffold failed");
		throw error;
	}

	spin?.stop(`Scaffolded ${result.written.length} files`);
	if (!interactive) {
		consola.success(`Scaffolded ${result.written.length} files in ${targetDir}`);
	}

	printNextSteps(targetDir, inputs, interactive);
}

// ──────────────────────────────────────────────────────────────────────────
// Per-field resolvers. Each consults the flag first; falls through to a
// clack prompt in interactive mode; falls through to `undefined` (→ the
// template emits a TODO) in non-interactive mode.
// ──────────────────────────────────────────────────────────────────────────

/**
 * The publisher resolution result. We always write a DID to the manifest
 * (the runtime compares DIDs), but if the user typed a handle (or had
 * one from their active session) we carry it through so the rendered
 * manifest can emit a `// <handle>` comment next to the pinned DID.
 */
interface PublisherResult {
	did: string;
	handle: string | undefined;
}

/**
 * Resolve the publisher to write into the manifest. Precedence:
 *
 *   1. `--publisher` flag (handle or DID; resolved to DID if a handle).
 *   2. In `--yes` / non-TTY mode: the active session's handle/DID.
 *   3. In interactive mode: a prompt pre-filled with the active session's
 *      handle (if logged in).
 *   4. Otherwise: undefined → manifest gets a TODO placeholder.
 *
 * For user-typed handles, we eagerly resolve to a DID. The runtime only
 * cares about the DID; writing it now means the post-publish write-back
 * isn't needed for handle→DID conversion later.
 */
async function resolvePublisher(
	args: InitArgs,
	interactive: boolean,
	session: SessionInfo | undefined,
): Promise<PublisherResult | undefined> {
	const flag = nonEmpty(args.publisher);
	if (flag !== undefined) {
		return await resolvePublisherInput(flag, "--publisher");
	}

	// --yes / non-TTY with an active session: silently fill from session.
	// The user can override by passing --publisher; we only reach here
	// when they didn't.
	if (!interactive) {
		if (session) return { did: session.did, handle: session.handle ?? undefined };
		return undefined;
	}

	const placeholder = session?.handle ?? "example.com";
	const defaultValue = session?.handle ?? undefined;

	const answer = await clack.text({
		message: session
			? "Atproto publisher (press enter to use your logged-in handle, or type a handle / DID)"
			: "Atproto publisher (handle or DID, leave blank to fill in later)",
		placeholder,
		...(defaultValue !== undefined && { defaultValue }),
		validate: (raw) => {
			// clack 1.x types `raw` as `string | undefined` because the
			// user can submit without typing anything. Treat that as
			// "blank, fine — user wants to fill it in later".
			const v = (raw ?? "").trim();
			if (v.length === 0) return undefined;
			if (isDid(v) || isHandle(v)) return undefined;
			return 'Must be a handle (e.g. "example.com") or DID (e.g. "did:plc:...").';
		},
	});
	assertNotCancelled(answer);
	const value = typeof answer === "string" ? answer.trim() : "";
	if (value.length === 0) return undefined;
	return await resolvePublisherInput(value, "publisher");
}

/**
 * Turn a raw publisher input (handle or DID) into a `PublisherResult`.
 * DIDs pass through verbatim with no handle. Handles round-trip through
 * the atproto resolver to produce a DID; the original handle is carried
 * for the manifest comment.
 *
 * `sourceLabel` is used in error messages to disambiguate "the
 * --publisher flag" from "the prompt".
 */
async function resolvePublisherInput(input: string, sourceLabel: string): Promise<PublisherResult> {
	if (isDid(input)) {
		return { did: input, handle: undefined };
	}
	if (!isHandle(input)) {
		throw new InputError(
			`${sourceLabel} "${input}" is not a valid atproto handle or DID. Expected a handle (e.g. "example.com") or DID (e.g. "did:plc:abc...").`,
		);
	}
	try {
		const did = await resolveHandleToDid(input);
		return { did, handle: input };
	} catch (error) {
		if (error instanceof PublisherCheckError) {
			throw new InputError(error.message);
		}
		throw error;
	}
}

async function resolveLicense(
	args: InitArgs,
	interactive: boolean,
	env: EnvironmentDefaults,
): Promise<string | undefined> {
	const flag = nonEmpty(args.license);
	if (flag !== undefined) return flag;
	// --yes / non-TTY: take whatever the environment told us, fall
	// through to undefined (template defaults to "MIT").
	if (!interactive) return env.license;
	const defaultValue = env.license ?? "MIT";
	const answer = await clack.text({
		message: "License (SPDX expression)",
		defaultValue,
		placeholder: defaultValue,
	});
	assertNotCancelled(answer);
	const value = typeof answer === "string" ? answer.trim() : "";
	return value.length === 0 ? undefined : value;
}

async function resolveAuthor(args: InitArgs, interactive: boolean, env: EnvironmentDefaults) {
	const flagName = nonEmpty(args["author-name"]);
	const flagUrl = nonEmpty(args["author-url"]);
	const flagEmail = nonEmpty(args["author-email"]);

	if (flagName !== undefined || flagUrl !== undefined || flagEmail !== undefined) {
		// Any author flag set → assemble what we have. Missing sub-fields
		// stay undefined; the template only emits the ones that are set.
		// Fall back to environment values for the unset sub-fields so
		// the user gets a complete author block when their git config
		// has the info.
		return {
			name: flagName ?? env.authorName ?? "TODO: replace with your name",
			...((flagUrl ?? undefined) !== undefined && { url: flagUrl! }),
			...((flagEmail ?? env.authorEmail) !== undefined && {
				email: flagEmail ?? env.authorEmail!,
			}),
		};
	}

	// --yes / non-TTY: use environment defaults only. If git config has
	// both name and email, scaffolding picks them up silently.
	if (!interactive) {
		if (env.authorName === undefined && env.authorEmail === undefined) {
			return undefined;
		}
		return {
			name: env.authorName ?? "TODO: replace with your name",
			...(env.authorEmail !== undefined && { email: env.authorEmail }),
		};
	}

	const nameAns = await clack.text({
		message: env.authorName
			? "Author name (press enter to use your git config)"
			: "Author name (leave blank to fill in later)",
		...(env.authorName !== undefined && { defaultValue: env.authorName }),
		placeholder: env.authorName ?? "Jane Doe",
	});
	assertNotCancelled(nameAns);
	const name = stringOrEmpty(nameAns);
	if (name.length === 0) return undefined;

	const urlAns = await clack.text({
		message: "Author URL (optional)",
	});
	assertNotCancelled(urlAns);
	const url = stringOrEmpty(urlAns);

	const emailAns = await clack.text({
		message: env.authorEmail
			? "Author email (press enter to use your git config)"
			: "Author email (optional)",
		...(env.authorEmail !== undefined && { defaultValue: env.authorEmail }),
		placeholder: env.authorEmail ?? "jane@example.com",
	});
	assertNotCancelled(emailAns);
	const email = stringOrEmpty(emailAns);

	return {
		name,
		...(url.length > 0 && { url }),
		...(email.length > 0 && { email }),
	};
}

async function resolveDescription(
	args: InitArgs,
	interactive: boolean,
	env: EnvironmentDefaults,
): Promise<string | undefined> {
	const flag = nonEmpty(args.description);
	if (flag !== undefined) return flag;
	if (!interactive) return env.description;
	const answer = await clack.text({
		message: env.description
			? "Short description (press enter to use package.json#description)"
			: "Short description (optional)",
		...(env.description !== undefined && { defaultValue: env.description }),
		placeholder: env.description ?? "What does the plugin do?",
	});
	assertNotCancelled(answer);
	const value = stringOrEmpty(answer);
	return value.length === 0 ? undefined : value;
}

async function resolveRepo(
	args: InitArgs,
	interactive: boolean,
	env: EnvironmentDefaults,
): Promise<string | undefined> {
	const flag = nonEmpty(args.repo);
	if (flag !== undefined) return flag;
	if (!interactive) return env.repo;
	const answer = await clack.text({
		message: env.repo
			? "Source repository URL (press enter to use the detected origin)"
			: "Source repository URL (optional)",
		...(env.repo !== undefined && { defaultValue: env.repo }),
		placeholder: env.repo ?? "https://github.com/...",
		validate: (raw) => {
			const v = (raw ?? "").trim();
			if (v.length === 0) return undefined;
			if (!v.startsWith("https://")) return "Must start with https://";
			return undefined;
		},
	});
	assertNotCancelled(answer);
	const value = stringOrEmpty(answer);
	return value.length === 0 ? undefined : value;
}

async function resolveSecurity(args: InitArgs, interactive: boolean) {
	const flagEmail = nonEmpty(args["security-email"]);
	const flagUrl = nonEmpty(args["security-url"]);

	if (flagEmail !== undefined || flagUrl !== undefined) {
		return {
			...(flagEmail !== undefined && { email: flagEmail }),
			...(flagUrl !== undefined && { url: flagUrl }),
		};
	}
	if (!interactive) return undefined;

	const emailAns = await clack.text({
		message: "Security contact email (leave blank to provide a URL or fill in later)",
	});
	assertNotCancelled(emailAns);
	const email = stringOrEmpty(emailAns);
	if (email.length > 0) return { email };

	const urlAns = await clack.text({
		message: "Security contact URL (leave blank to fill in later)",
	});
	assertNotCancelled(urlAns);
	const url = stringOrEmpty(urlAns);
	if (url.length === 0) return undefined;
	return { url };
}

// ──────────────────────────────────────────────────────────────────────────
// Session pre-fill
// ──────────────────────────────────────────────────────────────────────────

/**
 * The slice of the active session init cares about. Pulled out so the
 * session-loading helper can return a plain shape without dragging the
 * full StoredSession type through the rest of the command.
 */
interface SessionInfo {
	did: string;
	handle: string | null;
}

/**
 * Choose where to run environment probes against:
 *
 *   - target dir if it exists (already a git repo with a package.json,
 *     scaffolding into it),
 *   - cwd otherwise (init creating a new sibling dir).
 *
 * Picking the target lets us read package.json#description / #license
 * for the "scaffold into existing repo" case; falling back to cwd
 * still gets us git user.name/user.email which live in the global
 * config and don't depend on which dir we run from.
 */
async function pickProbeDir(targetDir: string): Promise<string> {
	const { stat } = await import("node:fs/promises");
	try {
		const info = await stat(targetDir);
		if (info.isDirectory()) return targetDir;
	} catch {
		// Target dir doesn't exist yet — that's the common case for
		// `init my-plugin`. Fall through to cwd.
	}
	return process.cwd();
}

/**
 * Load the active publisher session from the on-disk credentials store.
 * Returns `undefined` on every failure path — the credentials file
 * doesn't exist (fresh checkout), is corrupted, contains no current
 * session, etc. init is reachable in all these states; we never want
 * scaffolding to be blocked by a session lookup.
 */
async function loadCurrentSessionSilently(): Promise<SessionInfo | undefined> {
	try {
		const credentials = new FileCredentialStore();
		const current = await credentials.current();
		if (!current) return undefined;
		return { did: current.did, handle: current.handle };
	} catch {
		return undefined;
	}
}

// ──────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────

/**
 * Resolve `slug` and `targetDir` from the positional `name` + `--dir`
 * combo. In all modes:
 *
 *   - `init my-plugin`            → slug="my-plugin", dir="./my-plugin"
 *   - `init my-plugin --dir foo`  → slug="my-plugin", dir="./foo"
 *   - `init --dir foo`            → slug=basename(foo), dir="./foo"
 *   - `init`                      → slug=basename(cwd), dir=cwd
 */
function resolveSlugAndDir(args: InitArgs): { slug: string; targetDir: string } {
	const name = nonEmpty(args.name);
	const dirArg = nonEmpty(args.dir);
	if (name !== undefined) {
		const slug = name;
		const targetDir = dirArg !== undefined ? resolve(dirArg) : resolve(`./${slug}`);
		return { slug, targetDir };
	}
	const targetDir = dirArg !== undefined ? resolve(dirArg) : resolve(".");
	const slug = basename(targetDir);
	return { slug, targetDir };
}

function printNextSteps(targetDir: string, inputs: ScaffoldInputs, interactive: boolean): void {
	const todos: string[] = [];
	if (inputs.publisher === undefined) todos.push("publisher");
	if (inputs.author === undefined) todos.push("author");
	if (inputs.security === undefined) todos.push("security");

	if (interactive) {
		const lines: string[] = [];
		if (todos.length > 0) {
			lines.push(
				`${pc.yellow("⚠")} Fill in the TODO placeholders in emdash-plugin.jsonc (${todos.join(", ")}) before bundling.`,
			);
		}
		lines.push(`1. ${pc.cyan(`cd ${targetDir}`)}`);
		lines.push(`2. ${pc.cyan("pnpm install")}`);
		lines.push(`3. ${pc.cyan("pnpm test")}    confirm the scaffold passes its own test`);
		lines.push(`4. Edit src/plugin.ts to add routes and hooks.`);
		lines.push(`5. ${pc.cyan("emdash-registry bundle")}   when ready to publish`);
		clack.note(lines.join("\n"), "Next steps");
		clack.outro(`Plugin ready at ${pc.bold(targetDir)}`);
		return;
	}

	consola.info("");
	consola.info("Next steps:");
	if (todos.length > 0) {
		consola.info(
			`  ${pc.yellow("!")} Fill in the TODO placeholders in ${pc.dim(`${targetDir}/emdash-plugin.jsonc`)} (${todos.join(", ")}) before bundling.`,
		);
	}
	consola.info(`  1. ${pc.cyan(`cd ${targetDir}`)}`);
	consola.info(`  2. ${pc.cyan("pnpm install")}`);
	consola.info(`  3. ${pc.cyan("pnpm test")}    # confirm the scaffold passes its own test`);
	consola.info(`  4. Edit ${pc.dim("src/plugin.ts")} to add routes and hooks.`);
	consola.info(`  5. ${pc.cyan("emdash-registry bundle")}   # when ready to publish`);
}

/**
 * clack prompts return either the answer value or `Symbol.for("clack:cancel")`
 * when the user hits Ctrl+C / ESC. We turn that into a clean cancel-and-
 * exit rather than letting it propagate as an unrelated runtime error.
 */
function assertNotCancelled(value: unknown): void {
	if (clack.isCancel(value)) {
		clack.cancel("Cancelled.");
		process.exit(0);
	}
}

/**
 * Normalise clack's prompt return value to a trimmed string. `text()`
 * returns `string | symbol`; the symbol case is handled separately by
 * `assertNotCancelled`, so by the time this runs the value is either a
 * string or something we treat as empty.
 */
function stringOrEmpty(value: unknown): string {
	if (typeof value !== "string") return "";
	return value.trim();
}

/**
 * Trim+empty-string treats `--flag=`, `--flag ""`, and an unprovided
 * flag identically. citty leaves explicit empty strings as `""`; we
 * normalise to `undefined` so downstream branching is uniform.
 */
function nonEmpty(value: string | undefined): string | undefined {
	if (value === undefined) return undefined;
	const trimmed = value.trim();
	return trimmed.length === 0 ? undefined : trimmed;
}

/**
 * Thrown for CLI-input validation failures (invalid slug, malformed
 * publisher). Distinct from `InitError` (filesystem / conflict
 * failures) so the outer dispatch can produce a different exit class
 * if we ever add more granular codes.
 */
class InputError extends Error {
	override readonly name = "InputError";
}
