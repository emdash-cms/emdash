/**
 * Environment-probe helpers for `emdash-plugin init`.
 *
 * The goal: when the user runs init, pre-fill prompts with whatever the
 * surrounding environment already knows. None of these probes are
 * authoritative — they're just sensible defaults the user can override.
 *
 * Sources, in priority order per field:
 *
 *   - git config (user.name, user.email): the canonical "who am I" on
 *     any developer machine.
 *   - `git remote get-url origin`: the most reliable source for the
 *     plugin's repo URL.
 *   - package.json#description / #license / #repository: catches the
 *     "scaffolding into an existing repo skeleton" case.
 *
 * Every probe swallows errors. The CLI uses these as soft defaults; a
 * missing git binary, a non-git target dir, an unreadable package.json
 * are all expected and silently fall through to "no default".
 */

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Hard cap on the bytes we'll read from package.json. Pre-fills are a
 * convenience; we don't want to OOM on a deranged 1GB package.json that
 * happens to live in the target directory.
 */
const PACKAGE_JSON_MAX_BYTES = 64 * 1024;

/**
 * Timeout for the git child-process calls. Local git config / remote
 * lookup should complete in milliseconds; anything that hangs is
 * almost certainly a misconfigured remote or a network mount. We'd
 * rather skip the pre-fill than make `init` feel slow.
 */
const GIT_TIMEOUT_MS = 2_000;

/**
 * Snapshot of pre-fill values discovered from the surrounding
 * environment. Every field is optional — undefined means "nothing
 * found", and the caller should fall back to its own default.
 */
export interface EnvironmentDefaults {
	authorName: string | undefined;
	authorEmail: string | undefined;
	license: string | undefined;
	description: string | undefined;
	repo: string | undefined;
}

/**
 * Probe the environment for pre-fillable values. Inspects:
 *
 *   1. git config (global and per-dir) for user.name + user.email.
 *   2. `git remote get-url origin` (with normalization) for the repo URL.
 *   3. `<targetDir>/package.json` for description / license / repository.
 *
 * Errors in any one probe don't abort the others. The function returns
 * whatever it could determine, with each missing field as undefined.
 */
export async function probeEnvironment(targetDir: string): Promise<EnvironmentDefaults> {
	// Run independent probes in parallel — they don't depend on each
	// other and each one is the slow path of a single fs/exec call.
	const [authorName, authorEmail, repoFromGit, fromPackageJson] = await Promise.all([
		gitConfig("user.name", targetDir),
		gitConfig("user.email", targetDir),
		gitRemoteUrl(targetDir),
		readPackageJson(targetDir),
	]);

	return {
		authorName,
		authorEmail,
		// package.json#repository overrides the git remote only if it
		// looks like a deliberate, complete URL (the git remote is the
		// stronger signal of "where this code actually lives", but if a
		// pre-existing package.json points elsewhere, respect it).
		repo: fromPackageJson.repo ?? repoFromGit,
		license: fromPackageJson.license,
		description: fromPackageJson.description,
	};
}

// ──────────────────────────────────────────────────────────────────────────
// Git config
// ──────────────────────────────────────────────────────────────────────────

/**
 * Read a git config value, falling back from the target dir to the
 * global config. Returns undefined if git isn't installed, the dir
 * isn't a repo, or the key is unset.
 *
 * We use `git config --get` rather than `git config --show-origin` etc.
 * because `--get` is the simplest "give me the effective value" form
 * and it walks the repo→global→system fallback chain itself.
 */
async function gitConfig(key: string, cwd: string): Promise<string | undefined> {
	try {
		const { stdout } = await execFileAsync("git", ["config", "--get", key], {
			cwd,
			timeout: GIT_TIMEOUT_MS,
			// Limit output size to defend against a deliberately-bizarre
			// git config value. 4 KiB is generous for "name" / "email".
			maxBuffer: 4096,
		});
		const value = stdout.trim();
		return value.length === 0 ? undefined : value;
	} catch {
		return undefined;
	}
}

// ──────────────────────────────────────────────────────────────────────────
// Git remote
// ──────────────────────────────────────────────────────────────────────────

const GIT_SSH_RE = /^git@([^:]+):(.+?)(?:\.git)?$/;
const HTTPS_TRAILING_GIT_RE = /\.git$/;
const GIT_URL_PREFIX_RE = /^git\+/;

/**
 * Read `origin` remote URL and normalize to https. `git@github.com:foo/bar.git`
 * becomes `https://github.com/foo/bar`. Returns undefined if there's no
 * origin remote, no git, or the URL doesn't normalize to a recognisable
 * shape.
 */
async function gitRemoteUrl(cwd: string): Promise<string | undefined> {
	let raw: string;
	try {
		const { stdout } = await execFileAsync("git", ["remote", "get-url", "origin"], {
			cwd,
			timeout: GIT_TIMEOUT_MS,
			// 1 KiB is plenty for a URL; protects against weird remote
			// names that include the entire output of a hostile hook.
			maxBuffer: 1024,
		});
		raw = stdout.trim();
	} catch {
		return undefined;
	}
	if (raw.length === 0) return undefined;
	return normalizeRepoUrl(raw);
}

/**
 * Normalize a git remote URL to the https form the manifest's `repo`
 * field expects. Handles:
 *
 *   git@github.com:foo/bar.git  → https://github.com/foo/bar
 *   git@github.com:foo/bar      → https://github.com/foo/bar
 *   https://github.com/foo/bar.git → https://github.com/foo/bar
 *   https://github.com/foo/bar  → https://github.com/foo/bar
 *   ssh://git@...               → undefined (not auto-rewritten; user can paste)
 *
 * Returns undefined for shapes we don't recognise; the manifest schema
 * requires `https://...` and we'd rather omit the pre-fill than write
 * a value the schema will reject.
 */
function normalizeRepoUrl(raw: string): string | undefined {
	const sshMatch = GIT_SSH_RE.exec(raw);
	if (sshMatch) {
		const [, host, path] = sshMatch;
		return `https://${host}/${path}`;
	}
	if (raw.startsWith("https://")) {
		return raw.replace(HTTPS_TRAILING_GIT_RE, "");
	}
	return undefined;
}

// ──────────────────────────────────────────────────────────────────────────
// package.json
// ──────────────────────────────────────────────────────────────────────────

interface PackageJsonDefaults {
	license: string | undefined;
	description: string | undefined;
	repo: string | undefined;
}

const EMPTY_PACKAGE_JSON: PackageJsonDefaults = {
	license: undefined,
	description: undefined,
	repo: undefined,
};

/**
 * Read `<targetDir>/package.json` and pull license, description, and
 * a normalized repo URL out of it. Returns the empty defaults shape on
 * any failure (missing file, parse error, oversized file). The
 * scaffolder never trusts this output directly — values flow through
 * `EnvironmentDefaults` which the caller may or may not use.
 */
async function readPackageJson(targetDir: string): Promise<PackageJsonDefaults> {
	const path = join(targetDir, "package.json");
	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch {
		return EMPTY_PACKAGE_JSON;
	}
	if (raw.length > PACKAGE_JSON_MAX_BYTES) {
		return EMPTY_PACKAGE_JSON;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return EMPTY_PACKAGE_JSON;
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		return EMPTY_PACKAGE_JSON;
	}
	// JSON.parse returns `unknown`; the runtime check above narrows to
	// "non-array object", and the cast just makes the property accesses
	// below readable. The properties are still typed as `unknown` and
	// each one gets its own runtime check.
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- narrowed by runtime check above
	const pkg = parsed as Record<string, unknown>;

	const license = typeof pkg.license === "string" ? pkg.license.trim() : undefined;
	const description = typeof pkg.description === "string" ? pkg.description.trim() : undefined;
	const repo = repoFromPackageJsonRepository(pkg.repository);

	return {
		license: license && license.length > 0 ? license : undefined,
		description: description && description.length > 0 ? description : undefined,
		repo,
	};
}

/**
 * Pull a repo URL out of package.json#repository. Handles both forms:
 *
 *   "repository": "https://github.com/foo/bar"
 *   "repository": { "type": "git", "url": "git+https://github.com/foo/bar.git" }
 *
 * Normalizes through `normalizeRepoUrl`. Returns undefined if the
 * value isn't a recognisable string or object-with-url.
 */
function repoFromPackageJsonRepository(value: unknown): string | undefined {
	let raw: string | undefined;
	if (typeof value === "string") {
		raw = value;
	} else if (value && typeof value === "object" && !Array.isArray(value)) {
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- narrowed by runtime check above
		const url = (value as Record<string, unknown>).url;
		if (typeof url === "string") raw = url;
	}
	if (raw === undefined || raw.length === 0) return undefined;
	// npm accepts a leading `git+` on the URL (e.g. `git+https://...`).
	// Strip it before normalisation so the https-check passes.
	const stripped = raw.replace(GIT_URL_PREFIX_RE, "");
	return normalizeRepoUrl(stripped);
}
