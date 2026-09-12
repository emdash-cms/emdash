/**
 * `emdash-plugin init [name]`
 *
 * Scaffold a new sandboxed plugin with its manifest, runtime source,
 * package configuration, test, agent instructions, and local skill.
 *
 * Three modes:
 *
 *   1. Interactive (default on a TTY): clack prompts for each unset
 *      field with sensible defaults. ESC / Ctrl+C cancels cleanly.
 *   2. `--yes` / `-y` (non-interactive): no prompts; ownership fields
 *      must be supplied explicitly. `--use-detected` opts into local
 *      publisher and Git metadata.
 *   3. Non-TTY (CI, pipes): same as `--yes`.
 *
 * In all modes, explicit flags win — they're treated as final answers
 * and skip the prompt for that field.
 *
 * Exit codes:
 *   0 — scaffold written.
 *   1 — input validation failed, target conflict (without --force),
 *       prompt cancelled, or filesystem error.
 */

import { execFile } from "node:child_process";
import { basename, resolve } from "node:path";
import { promisify } from "node:util";

import { isDid, isHandle } from "@atcute/lexicons/syntax";
import * as clack from "@clack/prompts";
import { isPluginSlug } from "@emdash-cms/plugin-types";
import { FileCredentialStore } from "@emdash-cms/registry-client";
import { defineCommand } from "citty";
import consola from "consola";
import pc from "picocolors";

import { probeEnvironment, type EnvironmentDefaults } from "../init/environment.js";
import {
	assertScaffoldTargetAvailable,
	InitError,
	scaffold,
	validateScaffoldInputs,
} from "../init/scaffold.js";
import type { ScaffoldInputs, ScaffoldPackageManager } from "../init/templates.js";
import { PublisherCheckError, resolveHandleToDid } from "../manifest/publisher.js";
import { installedCliVersion } from "../package-version.js";

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
			description: "Atmosphere account handle or DID. Required for a valid scaffold.",
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
			description: "Security contact email. Either --security-email or --security-url is required.",
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
				"Skip interactive prompts. Publisher, author, and security flags are required unless --use-detected supplies them. Automatically enabled when stdin is not a TTY.",
			default: false,
		},
		force: {
			type: "boolean",
			description:
				"Overwrite existing files in the target directory. Without this flag, init refuses if any target file already exists.",
			default: false,
		},
		"package-manager": {
			type: "string",
			description: "Package manager for generated commands: npm, pnpm, yarn, or bun.",
		},
		"use-detected": {
			type: "boolean",
			description:
				"Use the active publisher session and detected Git author or repository metadata in non-interactive mode.",
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

export interface InitArgs {
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
	"package-manager"?: string;
	"use-detected"?: boolean;
}

interface DetectedPackageManager {
	name: ScaffoldPackageManager;
	version: string;
}

const PACKAGE_MANAGER_VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/;
const execFileAsync = promisify(execFile);
const EMPTY_ENVIRONMENT_DEFAULTS: EnvironmentDefaults = {
	authorName: undefined,
	authorEmail: undefined,
	license: undefined,
	description: undefined,
	repo: undefined,
};

export function detectPackageManager(
	explicit: string | undefined,
	userAgent = process.env["npm_config_user_agent"],
): DetectedPackageManager {
	const rawRequested = explicit?.trim();
	let requested: ScaffoldPackageManager | undefined;
	if (rawRequested) {
		if (!isScaffoldPackageManager(rawRequested)) {
			throw new InputError("--package-manager must be npm, pnpm, yarn, or bun.");
		}
		requested = rawRequested;
	}
	const agent = userAgent?.split(" ", 1)[0]?.split("/");
	const agentName = agent?.[0];
	const agentVersion = agent?.[1];
	const name = requested || (isScaffoldPackageManager(agentName) ? agentName : undefined);
	return {
		name: name ?? "pnpm",
		version:
			name === agentName && agentVersion && PACKAGE_MANAGER_VERSION_PATTERN.test(agentVersion)
				? agentVersion
				: "",
	};
}

function isScaffoldPackageManager(value: unknown): value is ScaffoldPackageManager {
	return value === "bun" || value === "npm" || value === "pnpm" || value === "yarn";
}

async function resolvePackageManager(
	explicit: string | undefined,
): Promise<DetectedPackageManager> {
	const detected = detectPackageManager(explicit);
	if (detected.version) return detected;
	try {
		const { stdout } = await execFileAsync(detected.name, ["--version"], {
			timeout: 2_000,
			maxBuffer: 1024,
		});
		const version = stdout.trim();
		if (PACKAGE_MANAGER_VERSION_PATTERN.test(version)) return { ...detected, version };
	} catch {
		// Report one stable input error below.
	}
	throw new InputError(
		`Could not determine the ${detected.name} version. Run init through that package manager or install it first.`,
	);
}

export function missingRequiredInitFields(
	inputs: Pick<ScaffoldInputs, "author" | "publisher" | "security">,
): string[] {
	return [
		...(inputs.publisher ? [] : ["--publisher"]),
		...(inputs.author?.name ? [] : ["--author-name"]),
		...(inputs.security?.email || inputs.security?.url
			? []
			: ["--security-email or --security-url"]),
	];
}

export async function runInit(args: InitArgs): Promise<void> {
	// Non-TTY stdin → can't prompt; behave as if --yes were passed.
	// stdout being a pipe is fine (we still write progress); it's the
	// input side that has to be a terminal for prompts to work.
	const interactive = !(args.yes ?? false) && process.stdin.isTTY === true;

	if (interactive) clack.intro(pc.bold("emdash-plugin init"));

	const packageManager = await resolvePackageManager(args["package-manager"]);

	// Load the active session (if any). Used to pre-fill the publisher
	// prompt and to silently fill it in `--yes` mode. We swallow load
	// errors entirely — init is reachable from a fresh checkout where
	// the credentials store doesn't exist yet, and a corrupt-store
	// failure should not block scaffolding.
	const session =
		interactive || args["use-detected"] ? await loadCurrentSessionSilently() : undefined;

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
		}
	}

	if (!isPluginSlug(slug)) {
		throw new InputError(
			`Slug "${slug}" is not a valid plugin slug. Expected: lowercase letter, then lowercase letters / digits / "-" / "_" (max 64 chars).`,
		);
	}
	await assertScaffoldTargetAvailable(targetDir, packageManager.name, args.force ?? false);

	// Probe the surrounding environment for pre-fillable defaults
	// (git user.name / user.email, git remote URL, package.json fields).
	// Probe the target dir if it exists, otherwise cwd — that covers
	// both "init into existing repo skeleton" and "init alongside the
	// current project" workflows. Failures inside the probe are
	// swallowed; missing fields stay undefined.
	const env =
		interactive || args["use-detected"]
			? await probeEnvironment(await pickProbeDir(targetDir))
			: EMPTY_ENVIRONMENT_DEFAULTS;

	const publisherResult = await resolvePublisher(args, interactive, session);
	const license = resolveLicense(args, env);
	const author = await resolveAuthor(args, interactive, env);
	const security = await resolveSecurity(args, interactive);
	const description = resolveDescription(args, env);
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
		packageManager: packageManager.name,
		packageManagerVersion: packageManager.version,
		cliVersion: await installedCliVersion(),
	};
	const missing = missingRequiredInitFields(inputs);
	if (missing.length > 0) {
		throw new InputError(
			`${interactive ? "Complete" : "Non-interactive setup requires"}: ${missing.join(", ")}.`,
		);
	}
	validateScaffoldInputs(inputs);
	if (interactive) await confirmScaffold(targetDir, inputs);
	else printScaffoldSummary(targetDir, inputs);

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
 *   4. Otherwise: undefined, which the required-input check rejects.
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
			? "Atmosphere publisher (press enter to use your logged-in handle, or type a handle / DID)"
			: "Atmosphere publisher (handle or DID)",
		placeholder,
		...(defaultValue !== undefined && { defaultValue }),
		validate: (raw) => {
			// clack 1.x types `raw` as `string | undefined` because the
			const v = (raw ?? "").trim();
			if (v.length === 0) return "Publisher is required.";
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

function resolveLicense(args: InitArgs, env: EnvironmentDefaults): string | undefined {
	const flag = nonEmpty(args.license);
	if (flag !== undefined) return flag;
	return env.license ?? "MIT";
}

async function resolveAuthor(args: InitArgs, interactive: boolean, env: EnvironmentDefaults) {
	const flagName = nonEmpty(args["author-name"]);
	const flagUrl = nonEmpty(args["author-url"]);
	const flagEmail = nonEmpty(args["author-email"]);

	if (flagName !== undefined) {
		return {
			name: flagName,
			...(flagUrl !== undefined && { url: flagUrl }),
			...(flagEmail !== undefined && { email: flagEmail }),
		};
	}

	if (!interactive) {
		if (env.authorName === undefined) {
			return undefined;
		}
		return {
			name: env.authorName,
			...(flagUrl !== undefined && { url: flagUrl }),
			...(flagEmail !== undefined
				? { email: flagEmail }
				: env.authorEmail !== undefined
					? { email: env.authorEmail }
					: {}),
		};
	}

	const nameAns = await clack.text({
		message: env.authorName ? "Author name (press enter to use your git config)" : "Author name",
		...(env.authorName !== undefined && { defaultValue: env.authorName }),
		placeholder: env.authorName ?? "Jane Doe",
		validate: (raw) => ((raw ?? "").trim().length > 0 ? undefined : "Author name is required."),
	});
	assertNotCancelled(nameAns);
	const name = stringOrEmpty(nameAns);
	if (name.length === 0) return undefined;

	return {
		name,
		...(flagUrl !== undefined && { url: flagUrl }),
		...(flagEmail !== undefined && { email: flagEmail }),
	};
}

function resolveDescription(args: InitArgs, env: EnvironmentDefaults): string | undefined {
	const flag = nonEmpty(args.description);
	if (flag !== undefined) return flag;
	return args["use-detected"] ? env.description : undefined;
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
		message: "Security contact URL",
		validate: (raw) =>
			validHttpsUrl((raw ?? "").trim()) ? undefined : "Enter an HTTPS security contact URL.",
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
export function resolveSlugAndDir(
	args: Pick<InitArgs, "dir" | "name">,
	cwd = process.cwd(),
): { slug: string; targetDir: string } {
	const name = nonEmpty(args.name);
	const dirArg = nonEmpty(args.dir);
	if (name !== undefined) {
		const slug = name;
		const targetDir = dirArg !== undefined ? resolve(cwd, dirArg) : resolve(cwd, slug);
		return { slug, targetDir };
	}
	const targetDir = dirArg !== undefined ? resolve(cwd, dirArg) : resolve(cwd);
	const slug = basename(targetDir);
	return { slug, targetDir };
}

async function confirmScaffold(targetDir: string, inputs: ScaffoldInputs): Promise<void> {
	const author = inputs.author!;
	const security = inputs.security!;
	clack.note(
		[
			`Directory: ${targetDir}`,
			`Plugin ID: ${inputs.slug}`,
			`Publisher: ${inputs.publisher}`,
			`Author: ${author.name}${author.email ? ` <${author.email}>` : ""}`,
			`Security: ${security.email ?? security.url}`,
			`Repository: ${inputs.repo ?? "not set"}`,
			`Package manager: ${inputs.packageManager}@${inputs.packageManagerVersion}`,
		].join("\n"),
		"Project summary",
	);
	const confirmed = await clack.confirm({ message: "Create this plugin?", initialValue: true });
	assertNotCancelled(confirmed);
	if (confirmed !== true) {
		clack.cancel("Cancelled.");
		process.exit(0);
	}
}

function printScaffoldSummary(targetDir: string, inputs: ScaffoldInputs): void {
	const author = inputs.author!;
	const security = inputs.security!;
	consola.info(`Plugin: ${inputs.slug}`);
	consola.info(`Directory: ${targetDir}`);
	consola.info(`Publisher: ${inputs.publisher}`);
	consola.info(`Author: ${author.name}${author.email ? ` <${author.email}>` : ""}`);
	consola.info(`Security: ${security.email ?? security.url}`);
	consola.info(`Repository: ${inputs.repo ?? "not set"}`);
	consola.info(`Package manager: ${inputs.packageManager}@${inputs.packageManagerVersion}`);
}

function printNextSteps(targetDir: string, inputs: ScaffoldInputs, interactive: boolean): void {
	const install = `${inputs.packageManager} install`;
	const run = (script: string) => `${inputs.packageManager} run ${script}`;
	if (interactive) {
		const lines: string[] = [];
		lines.push(`1. ${pc.cyan(`cd ${targetDir}`)}`);
		lines.push(`2. ${pc.cyan(install)}`);
		lines.push(`3. ${pc.cyan(run("validate"))}`);
		lines.push(`4. ${pc.cyan(run("test"))}`);
		lines.push(`5. ${pc.cyan(run("build"))}`);
		lines.push(`6. Edit src/plugin.ts, then run ${pc.cyan(run("dev"))}.`);
		clack.note(lines.join("\n"), "Next steps");
		clack.outro(`Plugin ready at ${pc.bold(targetDir)}`);
		return;
	}

	consola.info("");
	consola.info("Next steps:");
	consola.info(`  1. ${pc.cyan(`cd ${targetDir}`)}`);
	consola.info(`  2. ${pc.cyan(install)}`);
	consola.info(`  3. ${pc.cyan(run("validate"))}`);
	consola.info(`  4. ${pc.cyan(run("test"))}`);
	consola.info(`  5. ${pc.cyan(run("build"))}`);
	consola.info(`  6. Edit ${pc.dim("src/plugin.ts")}, then run ${pc.cyan(run("dev"))}.`);
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

function validHttpsUrl(value: string): boolean {
	try {
		return new URL(value).protocol === "https:";
	} catch {
		return false;
	}
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
