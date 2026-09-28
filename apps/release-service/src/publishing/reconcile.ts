import { safeParse } from "@atcute/lexicons";
import { NSID, PackageRelease } from "@emdash-cms/registry-lexicons";

import type { AuthoritativeRecord } from "../verification/pds.js";

export type ReconciliationResult =
	| { outcome: "absent" }
	| { outcome: "exact"; uri: string; cid: string }
	| { outcome: "conflict" };

function canonicalize(value: unknown): unknown {
	if (value === null || typeof value === "string" || typeof value === "boolean") return value;
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new TypeError("Non-finite JSON number");
		return Object.is(value, -0) ? 0 : value;
	}
	if (Array.isArray(value)) return value.map(canonicalize);
	if (typeof value !== "object") throw new TypeError("Non-JSON value");
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null)
		throw new TypeError("Non-plain JSON object");
	const result: Record<string, unknown> = Object.create(null);
	for (const [key, item] of Object.entries(value).toSorted(([left], [right]) =>
		left < right ? -1 : left > right ? 1 : 0,
	)) {
		if (item === undefined) throw new TypeError("Undefined JSON value");
		result[key] = canonicalize(item);
	}
	return result;
}

function canonicalJson(value: unknown): string {
	return JSON.stringify(canonicalize(value));
}

export function canonicalReleaseJson(value: PackageRelease.Main): string {
	return canonicalJson(value);
}

export function parseCanonicalReleaseJson(value: string): PackageRelease.Main | null {
	try {
		const parsed = safeParse(PackageRelease.mainSchema, JSON.parse(value), { strict: true });
		return parsed.ok && canonicalJson(parsed.value) === value ? parsed.value : null;
	} catch {
		return null;
	}
}

export function reconcileReleaseRecord(
	publisherDid: string,
	packageSlug: string,
	version: string,
	expected: PackageRelease.Main,
	authoritative: AuthoritativeRecord | null,
): ReconciliationResult {
	if (!authoritative) return { outcome: "absent" };
	const expectedUri = `at://${publisherDid}/${NSID.packageRelease}/${packageSlug}:${version}`;
	if (authoritative.uri !== expectedUri) return { outcome: "conflict" };
	const parsed = safeParse(PackageRelease.mainSchema, authoritative.value);
	if (!parsed.ok) return { outcome: "conflict" };
	try {
		return canonicalJson(parsed.value) === canonicalJson(expected)
			? { outcome: "exact", uri: authoritative.uri, cid: authoritative.cid }
			: { outcome: "conflict" };
	} catch {
		return { outcome: "conflict" };
	}
}
