import { parseArgs } from "node:util";

import { PROJECT_NAME_PATTERN } from "./utils.js";

/**
 * Flag-driven configuration for non-interactive scaffolding.
 *
 * Every field is optional — `main()` only skips the corresponding prompt when
 * the field is set, so partial flag use still drops the user into prompts for
 * the remaining choices. With `--yes`, missing fields fall back to sensible
 * defaults (or to `"my-site"` for the project name).
 */
export interface ParsedFlags {
	/** Positional project name (or "."). Validated against PROJECT_NAME_PATTERN. */
	name?: string;
	platform?: Platform;
	template?: TemplateKey;
	packageManager?: PackageManager;
	/** `--install` / `--no-install`. Undefined means "ask". */
	install?: boolean;
	/** `--yes` — auto-accept remaining defaults and skip overwrite prompts. */
	yes: boolean;
	/**
	 * `--force` — proceed when the target directory is non-empty. Required
	 * to overwrite a non-empty target under `--yes`; otherwise we refuse to
	 * silently clobber files.
	 */
	force: boolean;
	/** `--help` — print usage and exit. */
	help: boolean;
}

export type Platform = "node" | "cloudflare";
export type TemplateKey = "blog" | "starter" | "marketing" | "portfolio";
export type PackageManager = "pnpm" | "npm" | "yarn" | "bun";

const PLATFORMS: readonly Platform[] = ["node", "cloudflare"] as const;
const TEMPLATES: readonly TemplateKey[] = ["blog", "starter", "marketing", "portfolio"] as const;
const PACKAGE_MANAGERS: readonly PackageManager[] = ["pnpm", "npm", "yarn", "bun"] as const;

/**
 * Thrown by `parseFlags()` for malformed input. `main()` catches and prints a
 * red error line plus the help text, then exits non-zero.
 */
export class FlagError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "FlagError";
	}
}

function isPlatform(value: string): value is Platform {
	return (PLATFORMS as readonly string[]).includes(value);
}

function isTemplate(value: string): value is TemplateKey {
	return (TEMPLATES as readonly string[]).includes(value);
}

function isPackageManager(value: string): value is PackageManager {
	return (PACKAGE_MANAGERS as readonly string[]).includes(value);
}

/**
 * Quick scan for `--help` / `-h` in raw argv, used to short-circuit help
 * before strict argument parsing runs. Without this, a user who types
 * `npm create emdash@latest --help --template nope` gets the parse error
 * for the bad template instead of the help they asked for.
 */
export function wantsHelp(argv: string[]): boolean {
	return argv.slice(2).some((arg) => arg === "--help" || arg === "-h");
}

/**
 * Parse `process.argv`-style array into a {@link ParsedFlags}.
 *
 * Accepted forms (lifted from established `create-*` tools):
 * - Positional: `[name]` — the project directory (or `.` for cwd).
 * - `--template <key>` — one of `blog | starter | marketing | portfolio`,
 *   or the combined form `<platform>:<template>` (e.g. `cloudflare:blog`).
 * - `--platform <node | cloudflare>`.
 * - `--pm <pnpm | npm | yarn | bun>` (alias: `--package-manager`).
 * - `--install` / `--no-install` — toggle dependency install.
 * - `--yes`, `-y` — accept defaults; skip overwrite confirmations (with --force).
 * - `--force` — required to overwrite a non-empty target under `--yes`.
 * - `--help`, `-h`.
 *
 * Throws {@link FlagError} on unknown flags, invalid values, or unexpected
 * extra positionals. `parseArgs` itself also throws on malformed input
 * (missing values, unknown options) — those errors bubble up unchanged so the
 * caller can surface them with their own framing.
 */
export function parseFlags(argv: string[]): ParsedFlags {
	const { values, positionals } = parseArgs({
		args: argv.slice(2),
		options: {
			template: { type: "string" },
			platform: { type: "string" },
			pm: { type: "string" },
			"package-manager": { type: "string" },
			install: { type: "boolean" },
			"no-install": { type: "boolean" },
			yes: { type: "boolean", short: "y" },
			force: { type: "boolean" },
			help: { type: "boolean", short: "h" },
		},
		allowPositionals: true,
		// `strict: true` (default) makes parseArgs throw on unknown flags,
		// which we want — typos like `--temaplte` should fail loudly, not
		// silently fall through to interactive mode.
	});

	const flags: ParsedFlags = {
		yes: values.yes === true,
		force: values.force === true,
		help: values.help === true,
	};

	// Positional name: first non-flag arg. We accept "." for "scaffold into
	// cwd" — index.ts handles that branch directly. Extra positionals are
	// rejected because they're almost always typos: `npm create emdash my blog`
	// (space instead of hyphen) parses cleanly otherwise and silently uses
	// "my" as the project name, which is hostile.
	if (positionals.length > 1) {
		throw new FlagError(
			`Unexpected extra argument "${positionals[1]}". Did you mean a hyphen instead of a space in the project name?`,
		);
	}
	const positional = positionals[0];
	if (positional !== undefined) {
		// Defer name validation to the resolver so the prompt path can keep
		// its existing user-friendly error message. parseFlags only stores
		// the raw value and lets resolveProjectLocation enforce the pattern
		// at the same place the prompt's validate() runs.
		flags.name = positional;
	}

	// We collect platform from --platform *and* from the combined --template
	// form, then reconcile at the end so the conflict check is independent
	// of argv order. Tracking the *source* of each value is what makes the
	// error message useful.
	let platformFromFlag: Platform | undefined;
	let platformFromTemplate: Platform | undefined;

	// Platform: --platform <node | cloudflare>
	if (values.platform !== undefined) {
		if (!isPlatform(values.platform)) {
			throw new FlagError(
				`--platform must be one of ${PLATFORMS.join(", ")} (got "${values.platform}").`,
			);
		}
		platformFromFlag = values.platform;
	}

	// Template: --template <key> or --template <platform>:<key>.
	// The combined form is convenient for one-shot installs and matches the
	// shape suggested in the issue. We split on `:` and apply both halves.
	if (values.template !== undefined) {
		const raw = values.template;
		const colon = raw.indexOf(":");
		if (colon !== -1) {
			const platformPart = raw.slice(0, colon);
			const templatePart = raw.slice(colon + 1);
			if (platformPart === "" || templatePart === "") {
				throw new FlagError(`--template must be "<key>" or "<platform>:<key>" (got "${raw}").`);
			}
			if (!isPlatform(platformPart)) {
				throw new FlagError(
					`--template platform prefix must be one of ${PLATFORMS.join(", ")} (got "${platformPart}").`,
				);
			}
			if (!isTemplate(templatePart)) {
				throw new FlagError(
					`--template name must be one of ${TEMPLATES.join(", ")} (got "${templatePart}").`,
				);
			}
			platformFromTemplate = platformPart;
			flags.template = templatePart;
		} else {
			if (!isTemplate(raw)) {
				throw new FlagError(`--template must be one of ${TEMPLATES.join(", ")} (got "${raw}").`);
			}
			flags.template = raw;
		}
	}

	// Reconcile platform sources. If both are set and disagree, error out
	// regardless of argv order — easy footgun if a user copies a flag set
	// and edits one half.
	if (platformFromFlag !== undefined && platformFromTemplate !== undefined) {
		if (platformFromFlag !== platformFromTemplate) {
			throw new FlagError(
				`--platform "${platformFromFlag}" conflicts with --template "${values.template}". Pass one or the other.`,
			);
		}
	}
	flags.platform = platformFromFlag ?? platformFromTemplate;

	// Package manager: --pm or --package-manager (the latter for parity with
	// other ecosystem CLIs). If both are given they must agree — otherwise
	// it's almost certainly a typo on the user's end.
	const pmRaw = values.pm ?? values["package-manager"];
	if (values.pm !== undefined && values["package-manager"] !== undefined) {
		if (values.pm !== values["package-manager"]) {
			throw new FlagError(
				`--pm "${values.pm}" conflicts with --package-manager "${values["package-manager"]}". Pass one or the other.`,
			);
		}
	}
	if (pmRaw !== undefined) {
		if (!isPackageManager(pmRaw)) {
			throw new FlagError(`--pm must be one of ${PACKAGE_MANAGERS.join(", ")} (got "${pmRaw}").`);
		}
		flags.packageManager = pmRaw;
	}

	// Install: --install / --no-install. parseArgs surfaces both as separate
	// boolean keys; conflicting values are user error.
	if (values.install === true && values["no-install"] === true) {
		throw new FlagError(`--install and --no-install cannot both be set.`);
	}
	if (values.install === true) flags.install = true;
	if (values["no-install"] === true) flags.install = false;

	return flags;
}

/**
 * Validates a positional name (after `parseFlags` returns it). Kept separate
 * so the parser stays purely structural and the resolver owns the
 * "what counts as a valid project name" rule. Mirrors the prompt's validator.
 */
export function validateProjectName(name: string): string | undefined {
	if (name === ".") return undefined;
	if (!PROJECT_NAME_PATTERN.test(name)) {
		return "Project name can only contain lowercase letters, numbers, and hyphens";
	}
	return undefined;
}

/**
 * Help text printed for `--help` / `-h`. Kept in sync with {@link parseFlags}.
 */
export const HELP_TEXT = `Usage: npm create emdash@latest [name] [options]

Scaffold a new EmDash project.

When a flag is omitted, an interactive prompt is shown for that field.
With --yes, omitted fields fall back to defaults (cloudflare, blog, the
detected package manager, my-site for an unset name).

Arguments:
  [name]                       Project directory name, or "." for cwd

Options:
  --template <key>             blog | starter | marketing | portfolio
                               or "<platform>:<key>" (e.g. cloudflare:blog)
  --platform <key>             node | cloudflare
  --pm <key>                   pnpm | npm | yarn | bun
  --package-manager <key>      Alias of --pm
  --install                    Install dependencies after scaffolding
  --no-install                 Skip dependency install
  -y, --yes                    Accept defaults; skip confirmation prompts
  --force                      Allow overwriting a non-empty target dir
                               (required with --yes when the target is non-empty)
  -h, --help                   Show this help text

Examples:
  npm create emdash@latest
  npm create emdash@latest my-blog
  npm create emdash@latest my-blog -- --template cloudflare:blog --pm pnpm --yes
  npm create emdash@latest . -- --template starter --platform node --yes --force
`;
