export type ModerationLabelValue =
	| "assessment-error"
	| "assessment-overridden"
	| "assessment-passed"
	| "assessment-pending"
	| "artifact-integrity-failure"
	| "broken-release"
	| "credential-harvesting"
	| "critical-vulnerability"
	| "data-exfiltration"
	| "impersonation"
	| "invalid-bundle"
	| "low-quality"
	| "malware"
	| "misleading-metadata"
	| "obfuscated-code"
	| "package-disputed"
	| "privacy-risk"
	| "publisher-compromised"
	| "security-yanked"
	| "supply-chain-compromise"
	| "suspicious-code"
	| "undeclared-access"
	| "!takedown";

/** The ATProto label fields used to reduce a signed label stream. */
export interface ModerationLabel {
	ver: 1;
	src: string;
	uri: string;
	val: ModerationLabelValue | (string & {});
	cts: string;
	cid?: string;
	neg?: boolean;
	exp?: string;
}

export interface AcceptedLabelerPolicy {
	did: string;
	redact: boolean;
}

export interface ReleaseSubjectContext {
	publisherDid: string;
	package: {
		uri: string;
		cid: string;
	};
	release: {
		uri: string;
		cid: string;
	};
}

export interface EvaluateReleaseModerationInput {
	acceptedLabelers: AcceptedLabelerPolicy[];
	context: ReleaseSubjectContext;
	evaluatedAt: Date | string;
	labels: ModerationLabel[];
}

export type ReleaseEligibility = "eligible" | "pending" | "error" | "blocked";

export interface ReleaseModeration {
	eligibility: ReleaseEligibility;
	reasonCodes: string[];
	blockingLabels: string[];
	stateLabels: string[];
	warningLabels: string[];
	suppressedLabels: string[];
	applicableLabels: ModerationLabel[];
	redacted: boolean;
}

const AUTOMATED_BLOCKS = new Set<string>([
	"malware",
	"data-exfiltration",
	"credential-harvesting",
	"supply-chain-compromise",
	"critical-vulnerability",
	"artifact-integrity-failure",
	"invalid-bundle",
	"undeclared-access",
	"impersonation",
]);

const WARNINGS = new Set<string>([
	"suspicious-code",
	"obfuscated-code",
	"privacy-risk",
	"misleading-metadata",
	"low-quality",
	"broken-release",
	"package-disputed",
]);

const RELEASE_VALUES = new Set<string>([
	"assessment-error",
	"assessment-overridden",
	"assessment-passed",
	"assessment-pending",
	"security-yanked",
	"!takedown",
	...AUTOMATED_BLOCKS,
	...WARNINGS,
]);

interface ParsedInstant {
	seconds: bigint;
	fraction: string;
}

interface LabelReduction {
	active: ModerationLabel[];
	collisions: ModerationLabel[][];
}

const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/;

function daysFromCivil(year: bigint, month: bigint, day: bigint): bigint {
	const adjustedYear = year - (month <= 2n ? 1n : 0n);
	const era = (adjustedYear >= 0n ? adjustedYear : adjustedYear - 399n) / 400n;
	const yearOfEra = adjustedYear - era * 400n;
	const shiftedMonth = month + (month > 2n ? -3n : 9n);
	const dayOfYear = (153n * shiftedMonth + 2n) / 5n + day - 1n;
	const dayOfEra = yearOfEra * 365n + yearOfEra / 4n - yearOfEra / 100n + dayOfYear;
	return era * 146_097n + dayOfEra - 719_468n;
}

function isLeapYear(year: number): boolean {
	return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function parseInstant(value: Date | string, field: string): ParsedInstant {
	if (value instanceof Date) {
		if (Number.isNaN(value.getTime()))
			throw new TypeError(`${field} must be a valid RFC 3339 timestamp`);
		return {
			seconds: BigInt(Math.floor(value.getTime() / 1000)),
			fraction: `${value.getMilliseconds()}`.padStart(3, "0"),
		};
	}
	const match = RFC3339.exec(value);
	if (!match) throw new TypeError(`${field} must be a valid RFC 3339 timestamp`);
	const [, yearText, monthText, dayText, hourText, minuteText, secondText, fraction = "", zone] =
		match;
	const year = Number(yearText);
	const month = Number(monthText);
	const day = Number(dayText);
	const hour = Number(hourText);
	const minute = Number(minuteText);
	const second = Number(secondText);
	const zoneText = zone!;
	const daysInMonth = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
	if (
		year === 0 ||
		month < 1 ||
		month > 12 ||
		day < 1 ||
		day > daysInMonth[month - 1]! ||
		hour > 23 ||
		minute > 59 ||
		second > 59
	) {
		throw new TypeError(`${field} must be a valid RFC 3339 timestamp`);
	}
	let offsetSeconds = 0n;
	if (zoneText !== "Z") {
		const offsetHour = Number(zoneText.slice(1, 3));
		const offsetMinute = Number(zoneText.slice(4, 6));
		if (
			(offsetHour === 0 && offsetMinute === 0 && zoneText[0] === "-") ||
			offsetHour > 23 ||
			offsetMinute > 59
		)
			throw new TypeError(`${field} must be a valid RFC 3339 timestamp`);
		offsetSeconds =
			BigInt(offsetHour * 3600 + offsetMinute * 60) * (zoneText[0] === "+" ? 1n : -1n);
	}
	return {
		seconds:
			daysFromCivil(BigInt(year), BigInt(month), BigInt(day)) * 86_400n +
			BigInt(hour * 3600 + minute * 60 + second) -
			offsetSeconds,
		fraction,
	};
}

function compareInstants(left: ParsedInstant, right: ParsedInstant): number {
	if (left.seconds !== right.seconds) return left.seconds < right.seconds ? -1 : 1;
	const length = Math.max(left.fraction.length, right.fraction.length);
	for (let index = 0; index < length; index++) {
		const leftDigit = left.fraction[index] ?? "0";
		const rightDigit = right.fraction[index] ?? "0";
		if (leftDigit !== rightDigit) return leftDigit < rightDigit ? -1 : 1;
	}
	return 0;
}

function streamKey(label: ModerationLabel): string {
	return `${label.src}\u0000${label.uri}\u0000${label.val}`;
}

function isSameEvent(left: ModerationLabel, right: ModerationLabel): boolean {
	return (
		left.ver === right.ver &&
		left.src === right.src &&
		left.uri === right.uri &&
		left.cid === right.cid &&
		left.val === right.val &&
		(left.neg === true) === (right.neg === true) &&
		left.cts === right.cts &&
		left.exp === right.exp
	);
}

/**
 * Reduces each `(src, uri, val)` label stream to its current winner. CID is
 * deliberately excluded from the key so a CID-bearing negation replaces it.
 */
function reduceLabels(labels: ModerationLabel[], evaluatedAt: Date | string): LabelReduction {
	const now = parseInstant(evaluatedAt, "evaluatedAt");
	const streams = new Map<
		string,
		{ label: ModerationLabel; cts: ParsedInstant; exp?: ParsedInstant }[]
	>();

	for (const label of labels) {
		const entry = {
			label,
			cts: parseInstant(label.cts, "label.cts"),
			exp: label.exp === undefined ? undefined : parseInstant(label.exp, "label.exp"),
		};
		const key = streamKey(label);
		const entries = streams.get(key);
		if (entries) entries.push(entry);
		else streams.set(key, [entry]);
	}

	const active: ModerationLabel[] = [];
	const collisions: ModerationLabel[][] = [];
	for (const entries of streams.values()) {
		const first = entries[0];
		if (!first) continue;
		const winners = entries.filter((entry) =>
			entries.every((other) => compareInstants(entry.cts, other.cts) >= 0),
		);
		const winner = winners[0];
		if (!winner) continue;

		if (winners.some((entry) => !isSameEvent(winner.label, entry.label))) {
			collisions.push(winners.map((entry) => entry.label));
			continue;
		}
		if (
			winner.label.neg === true ||
			(winner.exp !== undefined && compareInstants(winner.exp, now) <= 0)
		) {
			continue;
		}
		active.push(winner.label);
	}

	return { active, collisions };
}

function appliesToContext(label: ModerationLabel, context: ReleaseSubjectContext): boolean {
	if (label.uri === context.release.uri) {
		if (!RELEASE_VALUES.has(label.val)) return false;
		if (label.cid !== undefined) return label.cid === context.release.cid;
		return label.val === "security-yanked" || label.val === "!takedown";
	}
	if (label.uri === context.package.uri) {
		if (label.val !== "!takedown" && label.val !== "package-disputed") return false;
		if (label.cid !== undefined) return label.cid === context.package.cid;
		return true;
	}
	return (
		label.uri === context.publisherDid &&
		label.cid === undefined &&
		(label.val === "!takedown" || label.val === "publisher-compromised")
	);
}

function collisionAppliesToContext(
	labels: ModerationLabel[],
	context: ReleaseSubjectContext,
): boolean {
	return labels.some((label) => appliesToContext(label, context));
}

function orderedValues(labels: ModerationLabel[]): string[] {
	const values: string[] = [];
	new Set(labels.map((label) => label.val)).forEach((value) => values.push(value));
	return values.toSorted();
}

/** Evaluates accepted, current label state for one exact package release. */
export function evaluateReleaseModeration(
	input: EvaluateReleaseModerationInput,
): ReleaseModeration {
	const policies = new Map<string, AcceptedLabelerPolicy>();
	for (const policy of input.acceptedLabelers) {
		const existing = policies.get(policy.did);
		policies.set(policy.did, {
			did: policy.did,
			redact: existing?.redact === true || policy.redact,
		});
	}
	const unacceptedLabelsIgnored = input.labels.some((label) => !policies.has(label.src));
	const reduction = reduceLabels(
		input.labels.filter((label) => policies.has(label.src)),
		input.evaluatedAt,
	);
	const applicableLabels = reduction.active
		.filter((label) => appliesToContext(label, input.context))
		.toSorted((left, right) => streamKey(left).localeCompare(streamKey(right)));
	const collisions = reduction.collisions.filter((labels) =>
		collisionAppliesToContext(labels, input.context),
	);

	const manualBlocks = applicableLabels.filter(
		(label) =>
			label.val === "!takedown" ||
			label.val === "security-yanked" ||
			label.val === "publisher-compromised",
	);
	const warnings = applicableLabels.filter((label) => WARNINGS.has(label.val));
	const suppressed: ModerationLabel[] = [];
	const unsuppressedStates: ModerationLabel[] = [];
	const unsuppressedBlocks: ModerationLabel[] = [];
	const passSources = new Set<string>();
	const overrideSources = new Set<string>();

	for (const [source] of policies) {
		const sourceLabels = applicableLabels.filter((label) => label.src === source);
		const hasPass = sourceLabels.some((label) => label.val === "assessment-passed");
		const hasOverride = sourceLabels.some((label) => label.val === "assessment-overridden");
		const override = hasPass && hasOverride;
		if (override) overrideSources.add(source);
		else if (hasPass) passSources.add(source);

		for (const label of sourceLabels) {
			if (label.val === "assessment-pending" || label.val === "assessment-error") {
				if (override) suppressed.push(label);
				else unsuppressedStates.push(label);
			} else if (AUTOMATED_BLOCKS.has(label.val)) {
				if (override) suppressed.push(label);
				else unsuppressedBlocks.push(label);
			}
		}
	}

	const reasonCodes: string[] = [];
	let eligibility: ReleaseEligibility;
	if (manualBlocks.length > 0) {
		eligibility = "blocked";
		reasonCodes.push("manual-block");
	} else if (collisions.length > 0) {
		eligibility = "error";
		reasonCodes.push("label-state-collision");
	} else if (unsuppressedStates.some((label) => label.val === "assessment-error")) {
		eligibility = "error";
		reasonCodes.push("assessment-error");
	} else if (unsuppressedStates.some((label) => label.val === "assessment-pending")) {
		eligibility = "pending";
		reasonCodes.push("assessment-pending");
	} else if (unsuppressedBlocks.length > 0) {
		eligibility = "blocked";
		reasonCodes.push("automated-block");
	} else if (passSources.size === 0 && overrideSources.size === 0) {
		eligibility = "blocked";
		reasonCodes.push("missing-assessment-pass");
	} else {
		eligibility = "eligible";
		reasonCodes.push(
			overrideSources.size > 0 ? "eligible-manual-override" : "eligible-assessment-pass",
		);
		if (warnings.length > 0) reasonCodes.push("warning-labels");
	}
	if (unacceptedLabelsIgnored) reasonCodes.push("unaccepted-labels-ignored");

	return {
		eligibility,
		reasonCodes,
		blockingLabels: orderedValues([...manualBlocks, ...unsuppressedBlocks]),
		stateLabels: orderedValues(unsuppressedStates),
		warningLabels: orderedValues(warnings),
		suppressedLabels: orderedValues(suppressed),
		applicableLabels,
		redacted: applicableLabels.some(
			(label) => label.val === "!takedown" && policies.get(label.src)?.redact === true,
		),
	};
}
