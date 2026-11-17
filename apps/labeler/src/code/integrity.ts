import type {
	CodeFindingCategory,
	NormalizedModerationFinding,
} from "@emdash-cms/registry-moderation";

import type { BundleAnomaly, BundleAnomalyCode } from "./bundle.js";

export const PACKAGE_EVIDENCE_PREFIX = "release.package:";

/** Lines from a verified bundle file around a cited line, for operators to read. */
export interface EvidenceExcerpt {
	ref: string;
	startLine: number;
	lines: string[];
}

export interface FindingProvenance {
	/** The model or deterministic check that raised the finding. */
	source?: string;
	excerpts?: EvidenceExcerpt[];
}

export const PACKAGE_CHECK_SOURCE = "package-check";

export type CodeFinding = NormalizedModerationFinding<CodeFindingCategory> & FindingProvenance;

const MAX_EVIDENCE_PER_FINDING = 8;
const MAX_SUMMARY_LENGTH = 500;

const ANOMALY_SEVERITY: Record<BundleAnomalyCode, NonNullable<CodeFinding["severity"]>> = {
	"compressed-size-exceeded": "high",
	"decompressed-size-exceeded": "high",
	"invalid-gzip": "high",
	"malformed-archive": "high",
	"entry-count-exceeded": "high",
	"file-count-exceeded": "high",
	"file-size-exceeded": "high",
	symlink: "high",
	hardlink: "high",
	"unsupported-entry-type": "high",
	"path-traversal": "critical",
	"unsafe-path": "high",
	"duplicate-entry": "high",
	"unexpected-entry": "medium",
	"missing-required-entry": "medium",
	"invalid-text-encoding": "medium",
};

const ANOMALY_SUMMARY: Record<BundleAnomalyCode, string> = {
	"compressed-size-exceeded": "The compressed package exceeds the bundle size limit.",
	"decompressed-size-exceeded": "The decompressed package exceeds the bundle size limit.",
	"invalid-gzip": "The package is not valid gzip data.",
	"malformed-archive": "The package tar archive is malformed or truncated.",
	"entry-count-exceeded": "The package contains more archive entries than a bundle allows.",
	"file-count-exceeded": "The package contains more files than a bundle allows.",
	"file-size-exceeded": "A package file exceeds the bundle size limits.",
	symlink: "The package contains a symbolic link.",
	hardlink: "The package contains a hard link.",
	"unsupported-entry-type": "The package contains an archive entry type that bundles never use.",
	"path-traversal": "The package contains an absolute path or a path that escapes the bundle root.",
	"unsafe-path": "The package contains a malformed or unsafe entry path.",
	"duplicate-entry": "The package contains two entries with the same or ambiguous path.",
	"unexpected-entry": "The package contains an entry outside the bundle layout.",
	"missing-required-entry": "The package is missing a required bundle file.",
	"invalid-text-encoding": "A package text file is not valid UTF-8.",
};

/** One `package-integrity` finding per kind of archive anomaly. */
export function integrityFindings(anomalies: readonly BundleAnomaly[]): CodeFinding[] {
	const grouped = new Map<BundleAnomalyCode, BundleAnomaly[]>();
	for (const anomaly of anomalies) {
		grouped.set(anomaly.code, [...(grouped.get(anomaly.code) ?? []), anomaly]);
	}
	return Array.from(grouped, ([code, items]) => {
		const names = items.flatMap((item) => (item.name === undefined ? [] : [item.name]));
		const summary =
			names.length === 0
				? ANOMALY_SUMMARY[code]
				: `${ANOMALY_SUMMARY[code]} Entries: ${names
						.slice(0, 4)
						.map((name) => JSON.stringify(name))
						.join(", ")}`;
		return {
			category: "package-integrity",
			source: PACKAGE_CHECK_SOURCE,
			recommendation: "review",
			confidence: 1,
			severity: ANOMALY_SEVERITY[code],
			summary: `bundle.${code}: ${summary}`.slice(0, MAX_SUMMARY_LENGTH),
			evidenceRefs: [
				...new Set(
					items
						.slice(0, MAX_EVIDENCE_PER_FINDING)
						.map((item) => `${PACKAGE_EVIDENCE_PREFIX}entry[${item.entryIndex ?? "archive"}]`),
				),
			],
		};
	});
}
