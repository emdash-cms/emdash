/**
 * Environment compatibility for release `requires` constraints.
 *
 * A release record's `requires` block is a map of `env:*` keys (host
 * environment requirements like `env:emdash`, `env:astro`) or package DIDs to
 * semver-range constraint strings. The lexicon types it as `unknown`; nothing
 * upstream guarantees its shape, so {@link parseRequires} guards it before any
 * consumer reads it.
 *
 * Range evaluation delegates to node-semver (`satisfies` / `validRange` /
 * `valid`), so the full range grammar — comparator sets, caret, tilde, partial
 * versions, wildcards, and `||` unions — and node-semver's prerelease gating
 * apply. semver is pure JS, so this stays isomorphic across the CLI
 * (publish-time validation), the server (install/update gate), and the admin
 * (browser compat warning), all sharing one implementation.
 */

import { satisfies, valid, validRange } from "semver";

export interface HostEnv {
	/** Map of `env:*` key to the host's current version of that environment. */
	[key: string]: string | undefined;
}

export interface EnvMismatch {
	/** The `requires` key that was not satisfied (e.g. `env:astro`). */
	key: string;
	/** The required range string from the release record. */
	required: string;
	/** The host's version of that environment. */
	host: string;
}

/** `env:<name>` keys, where `<name>` is one or more non-colon characters. */
const ENV_KEY_RE = /^env:[^:]+$/;
/** Structural DID shape: `did:<method>:<id>` (forward-compat for package deps). */
const DID_KEY_RE = /^did:[a-z]+:.+$/;

/**
 * Build the host-environment map the install/update gate compares a release's
 * `requires` against, from the EmDash and Astro versions the host advertises.
 *
 * An environment whose version is unknown is omitted so the gate skips it
 * rather than blocking on a version it can't evaluate: an uncompiled build
 * reporting `"dev"` for EmDash, or an unresolved Astro version. Shared by the
 * server install/update gate and the admin's client-side compat warning so the
 * dev-skip / astro-omit rule lives in exactly one place.
 */
export function hostEnvFromVersions(
	emdashVersion: string | undefined,
	astroVersion: string | undefined,
): HostEnv {
	const host: HostEnv = {};
	if (emdashVersion && emdashVersion !== "dev") host["env:emdash"] = emdashVersion;
	if (astroVersion) host["env:astro"] = astroVersion;
	return host;
}

/**
 * Guard the lexicon-`unknown` `requires` value into a string-valued record of
 * recognised keys. Drops any entry whose key is not `env:*`/DID-shaped or whose
 * value is not a string. Never throws.
 */
export function parseRequires(value: unknown): Record<string, string> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
	const out: Record<string, string> = {};
	for (const [key, raw] of Object.entries(value)) {
		if (typeof raw !== "string") continue;
		if (!ENV_KEY_RE.test(key) && !DID_KEY_RE.test(key)) continue;
		out[key] = raw;
	}
	return out;
}

/**
 * True when `range` is a syntactically valid version range we can evaluate.
 *
 * The empty string is rejected: node-semver normalises it to `*` (match any),
 * which is never what a publisher means when they write a constraint.
 */
export function isValidVersionRange(range: string): boolean {
	if (range.trim() === "") return false;
	return validRange(range) !== null;
}

/**
 * True when `version` satisfies `range`.
 *
 * Fails open (returns `true`) when either input is unparseable: an unparseable
 * host version cannot be proven incompatible, and an unparseable range is
 * garbage we decline to enforce. Both cases are non-blocking by design — the
 * gate only refuses on a definite mismatch.
 *
 * `includePrerelease` evaluates a prerelease host version (a beta EmDash/Astro
 * build) by its precedence rather than excluding it from release-only ranges.
 * Without it, node-semver would refuse `1.0.0-rc.1` against `*` or `>=0.13.0`,
 * blocking a prerelease host that is not a definite mismatch.
 */
export function satisfiesRange(version: string, range: string): boolean {
	if (valid(version) === null) return true;
	if (validRange(range) === null) return true;
	return satisfies(version, range, { includePrerelease: true });
}

/**
 * Compare a release's `requires` against the host environment and return the
 * env keys whose host version does not satisfy the required range.
 *
 * Entries the host doesn't advertise (no known version for that key) are
 * skipped — we can't evaluate a constraint against an environment we don't
 * know we're running in. The `requires` argument is the raw lexicon-`unknown`
 * value; it is guarded internally.
 */
export function checkEnvCompatibility(requires: unknown, host: HostEnv): EnvMismatch[] {
	const parsed = parseRequires(requires);
	const mismatches: EnvMismatch[] = [];
	for (const [key, range] of Object.entries(parsed)) {
		const hostVersion = host[key];
		if (hostVersion === undefined) continue;
		if (!satisfiesRange(hostVersion, range)) {
			mismatches.push({ key, required: range, host: hostVersion });
		}
	}
	return mismatches;
}

/** An `env:*` constraint that could not be enforced against the host. */
export interface SkippedEnvConstraint {
	/** The `env:*` key whose constraint was skipped. */
	key: string;
	/** The required range string from the release record. */
	required: string;
	/**
	 * `"unknown"`: the host advertises no version for this env.
	 * `"unparseable"`: the host version exists but isn't valid semver.
	 */
	reason: "unknown" | "unparseable";
}

/**
 * Find the `env:*` constraints in `requires` that {@link checkEnvCompatibility}
 * silently skips because the host can't evaluate them: the host advertises no
 * version for that env, or advertises one that isn't parseable semver. These
 * are the cases where a hard gate degrades to a no-op, so the server can log
 * them rather than bypass silently.
 *
 * DID-keyed constraints are excluded — those are forward-compat package deps,
 * not host environments, and their absence from the host map is expected.
 */
export function findSkippedEnvConstraints(
	requires: unknown,
	host: HostEnv,
): SkippedEnvConstraint[] {
	const parsed = parseRequires(requires);
	const skipped: SkippedEnvConstraint[] = [];
	for (const [key, range] of Object.entries(parsed)) {
		if (!ENV_KEY_RE.test(key)) continue;
		const hostVersion = host[key];
		if (hostVersion === undefined) {
			skipped.push({ key, required: range, reason: "unknown" });
		} else if (valid(hostVersion) === null) {
			skipped.push({ key, required: range, reason: "unparseable" });
		}
	}
	return skipped;
}
