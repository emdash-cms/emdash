/**
 * Environment compatibility for release `requires` constraints.
 *
 * A release record's `requires` block is a map of `env:*` keys (host
 * environment requirements like `env:emdash`, `env:astro`) or package DIDs to
 * semver-range constraint strings. The lexicon types it as `unknown`; nothing
 * upstream guarantees its shape, so {@link parseRequires} guards it before any
 * consumer reads it.
 *
 * The range grammar supported here is the subset publishers actually write for
 * environment constraints: a space-separated AND set of comparators
 * (`>=4.16.0 <5.0.0`), caret (`^4.0.0`), tilde (`~4.16.0`), partial versions
 * (`>=4.16`), and the wildcard (`*` / `x`). OR (`||`) is not supported and is
 * reported as an invalid range.
 *
 * Pure, dependency-free, and isomorphic so the CLI (publish-time validation),
 * the server (install/update gate), and the admin (browser compat warning)
 * all share one implementation.
 */

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

/** A parsed semver version. Prerelease is compared lexically per semver §11. */
interface ParsedVersion {
	major: number;
	minor: number;
	patch: number;
	prerelease: string[];
}

/** `env:<name>` keys, where `<name>` is one or more non-colon characters. */
const ENV_KEY_RE = /^env:[^:]+$/;
/** Structural DID shape: `did:<method>:<id>` (forward-compat for package deps). */
const DID_KEY_RE = /^did:[a-z]+:.+$/;

/** A full or partial semver version, optionally prerelease-tagged. */
const VERSION_RE =
	/^(0|[1-9]\d*)(?:\.(0|[1-9]\d*|x|\*)(?:\.(0|[1-9]\d*|x|\*))?)?(?:-([0-9A-Za-z.-]+))?$/;

/** A complete `MAJOR.MINOR.PATCH` version, optionally prerelease-tagged. */
const FULL_VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?$/;

/** Whitespace separator between comparators in an AND-joined range. */
const WHITESPACE_RE = /\s+/;

/** A purely numeric prerelease identifier (compared numerically per semver §11). */
const NUMERIC_IDENTIFIER_RE = /^\d+$/;

type Operator = ">=" | ">" | "<=" | "<" | "=";

interface Comparator {
	op: Operator;
	version: ParsedVersion;
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

/** True when `range` is a syntactically valid version range we can evaluate. */
export function isValidVersionRange(range: string): boolean {
	return parseRange(range) !== null;
}

/**
 * True when `version` satisfies `range`.
 *
 * Fails open (returns `true`) when either input is unparseable: an unparseable
 * host version cannot be proven incompatible, and an unparseable range is
 * garbage we decline to enforce. Both cases are non-blocking by design — the
 * gate only refuses on a definite mismatch.
 */
export function satisfiesRange(version: string, range: string): boolean {
	const v = parseVersion(version);
	if (v === null) return true;
	const comparators = parseRange(range);
	if (comparators === null) return true;
	return comparators.every((c) => satisfiesComparator(v, c));
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

function satisfiesComparator(v: ParsedVersion, c: Comparator): boolean {
	const cmp = compareVersions(v, c.version);
	switch (c.op) {
		case ">=":
			return cmp >= 0;
		case ">":
			return cmp > 0;
		case "<=":
			return cmp <= 0;
		case "<":
			return cmp < 0;
		case "=":
			return cmp === 0;
	}
}

/**
 * Parse a range into the AND set of comparators it expands to, or `null` when
 * the range is syntactically invalid. The wildcard `*` parses to an empty set
 * (matches everything).
 */
function parseRange(range: string): Comparator[] | null {
	const trimmed = range.trim();
	if (trimmed === "") return null;
	if (trimmed === "*") return [];
	if (trimmed.includes("||")) return null;

	const tokens = trimmed.split(WHITESPACE_RE);
	const comparators: Comparator[] = [];
	for (const token of tokens) {
		const expanded = parseComparatorToken(token);
		if (expanded === null) return null;
		comparators.push(...expanded);
	}
	return comparators;
}

function parseComparatorToken(token: string): Comparator[] | null {
	if (token.startsWith("^")) return parseCaret(token.slice(1));
	if (token.startsWith("~")) return parseTilde(token.slice(1));

	let op: Operator = "=";
	let rest = token;
	if (token.startsWith(">=")) {
		op = ">=";
		rest = token.slice(2);
	} else if (token.startsWith("<=")) {
		op = "<=";
		rest = token.slice(2);
	} else if (token.startsWith(">")) {
		op = ">";
		rest = token.slice(1);
	} else if (token.startsWith("<")) {
		op = "<";
		rest = token.slice(1);
	} else if (token.startsWith("=")) {
		op = "=";
		rest = token.slice(1);
	}

	if (rest === "*" || rest === "x") {
		// Bare wildcard with a comparator (e.g. `>=*`) is degenerate; treat the
		// version-only wildcard as "any" and any comparator as unconstrained.
		return [];
	}

	const partial = parsePartialVersion(rest);
	if (partial === null) return null;

	// An `=` against a partial version (`=4.16`, `4.x`) becomes a bounded range
	// covering the missing segments rather than an exact match.
	if (op === "=" && partial.wildcard) {
		return wildcardToRange(partial);
	}
	return [{ op, version: partial.version }];
}

interface PartialVersion {
	version: ParsedVersion;
	/** True when the source omitted minor/patch or used `x`/`*` for them. */
	wildcard: boolean;
	/** Index of the first wildcarded/omitted segment (1 = minor, 2 = patch). */
	wildcardAt: number;
}

function parsePartialVersion(raw: string): PartialVersion | null {
	if (!VERSION_RE.test(raw)) return null;
	const [main, prerelease] = raw.split("-", 2);
	const segments = main!.split(".");
	let wildcardAt = segments.length;
	const nums: number[] = [];
	for (let i = 0; i < 3; i++) {
		const seg = segments[i];
		if (seg === undefined || seg === "x" || seg === "*") {
			if (wildcardAt === segments.length || i < wildcardAt) wildcardAt = Math.min(wildcardAt, i);
			nums.push(0);
		} else {
			nums.push(Number(seg));
		}
	}
	const wildcard = wildcardAt < 3;
	return {
		version: {
			major: nums[0]!,
			minor: nums[1]!,
			patch: nums[2]!,
			prerelease: prerelease ? prerelease.split(".") : [],
		},
		wildcard,
		wildcardAt,
	};
}

/** Expand a wildcarded `=` version (`4.x`, `4.16`) to a `>= lower < upper` pair. */
function wildcardToRange(partial: PartialVersion): Comparator[] {
	const { version, wildcardAt } = partial;
	const lower: ParsedVersion = { ...version, prerelease: [] };
	const upper: ParsedVersion =
		wildcardAt <= 1
			? { major: version.major + 1, minor: 0, patch: 0, prerelease: [] }
			: { major: version.major, minor: version.minor + 1, patch: 0, prerelease: [] };
	return [
		{ op: ">=", version: lower },
		{ op: "<", version: upper },
	];
}

function parseCaret(raw: string): Comparator[] | null {
	const partial = parsePartialVersion(raw);
	if (partial === null) return null;
	const { version } = partial;
	const lower = version;
	let upper: ParsedVersion;
	if (version.major > 0) {
		upper = { major: version.major + 1, minor: 0, patch: 0, prerelease: [] };
	} else if (version.minor > 0) {
		upper = { major: 0, minor: version.minor + 1, patch: 0, prerelease: [] };
	} else {
		upper = { major: 0, minor: 0, patch: version.patch + 1, prerelease: [] };
	}
	return [
		{ op: ">=", version: lower },
		{ op: "<", version: upper },
	];
}

function parseTilde(raw: string): Comparator[] | null {
	const partial = parsePartialVersion(raw);
	if (partial === null) return null;
	const { version, wildcardAt } = partial;
	const lower = version;
	// `~1` (major-only) allows the whole 1.x range; `~1.2` / `~1.2.3` allow
	// patch-level changes within the stated minor.
	const upper: ParsedVersion =
		wildcardAt <= 1
			? { major: version.major + 1, minor: 0, patch: 0, prerelease: [] }
			: { major: version.major, minor: version.minor + 1, patch: 0, prerelease: [] };
	return [
		{ op: ">=", version: lower },
		{ op: "<", version: upper },
	];
}

function parseVersion(raw: string): ParsedVersion | null {
	const trimmed = raw.trim();
	const match = FULL_VERSION_RE.exec(trimmed);
	if (!match) return null;
	return {
		major: Number(match[1]),
		minor: Number(match[2]),
		patch: Number(match[3]),
		prerelease: match[4] ? match[4].split(".") : [],
	};
}

function compareVersions(a: ParsedVersion, b: ParsedVersion): number {
	if (a.major !== b.major) return a.major - b.major;
	if (a.minor !== b.minor) return a.minor - b.minor;
	if (a.patch !== b.patch) return a.patch - b.patch;
	return comparePrerelease(a.prerelease, b.prerelease);
}

/** Semver §11: a version with a prerelease has lower precedence than one without. */
function comparePrerelease(a: string[], b: string[]): number {
	if (a.length === 0 && b.length === 0) return 0;
	if (a.length === 0) return 1;
	if (b.length === 0) return -1;
	const len = Math.max(a.length, b.length);
	for (let i = 0; i < len; i++) {
		const ai = a[i];
		const bi = b[i];
		if (ai === undefined) return -1;
		if (bi === undefined) return 1;
		const an = NUMERIC_IDENTIFIER_RE.test(ai);
		const bn = NUMERIC_IDENTIFIER_RE.test(bi);
		if (an && bn) {
			const diff = Number(ai) - Number(bi);
			if (diff !== 0) return diff;
		} else if (an) {
			return -1;
		} else if (bn) {
			return 1;
		} else if (ai !== bi) {
			return ai < bi ? -1 : 1;
		}
	}
	return 0;
}
