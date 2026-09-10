// Size budget for the staged PR diff. The review agent starts by reading the
// whole diff file, so an oversized diff (generated types, lockfiles, large
// catalogs) lands in the model context verbatim and kills the model call.
// Oversized per-file sections are elided down to their headers with a note;
// the agent reads those files from the checkout instead. Generated Worker
// types are always omitted from both paths by the review-context guards.

import {
	GENERATED_WORKER_TYPES_FILENAME,
	GENERATED_WORKER_TYPES_NOTICE,
} from "./review-context.js";

const DEFAULT_PER_FILE_BYTES = 48 * 1024;
const DEFAULT_TOTAL_BYTES = 384 * 1024;
const GENERATED_WORKER_TYPES_DIFF_PATH = new RegExp(
	`(?:^|/)${GENERATED_WORKER_TYPES_FILENAME.replaceAll(".", "\\.")}(?=["\\t ]|$)`,
);

export interface DiffBudget {
	readonly perFileBytes?: number;
	readonly totalBytes?: number;
}

interface Section {
	text: string;
	elided: boolean;
}

export function elideLargeDiffSections(diff: string, budget: DiffBudget = {}): string {
	const perFileBytes = budget.perFileBytes ?? DEFAULT_PER_FILE_BYTES;
	const totalBytes = budget.totalBytes ?? DEFAULT_TOTAL_BYTES;
	const sections = splitSections(diff);
	for (const section of sections) {
		if (isGeneratedWorkerTypesSection(section)) {
			elide(section, GENERATED_WORKER_TYPES_NOTICE.trim());
		}
	}
	if (
		sections.reduce((total, section) => total + section.text.length, 0) <=
		Math.min(perFileBytes, totalBytes)
	) {
		return sections.map((section) => section.text).join("");
	}
	for (const section of sections) {
		if (!section.elided && section.text.length > perFileBytes) elide(section);
	}
	// Still over the total budget: elide the largest remaining sections until
	// under it (or nothing left to elide).
	let total = sections.reduce((n, s) => n + s.text.length, 0);
	while (total > totalBytes) {
		const next = sections
			.filter((s) => !s.elided)
			.toSorted((a, b) => b.text.length - a.text.length)[0];
		if (!next) break;
		total -= next.text.length;
		elide(next);
		total += next.text.length;
	}
	return sections.map((s) => s.text).join("");
}

function isGeneratedWorkerTypesSection(section: Section): boolean {
	const lineEnd = section.text.indexOf("\n");
	const firstLine = lineEnd === -1 ? section.text : section.text.slice(0, lineEnd);
	return GENERATED_WORKER_TYPES_DIFF_PATH.test(firstLine);
}

function splitSections(diff: string): Section[] {
	const starts: number[] = [];
	const re = /^diff --git /gm;
	for (let m = re.exec(diff); m; m = re.exec(diff)) starts.push(m.index);
	if (starts.length === 0) return [{ text: diff, elided: false }];
	const sections: Section[] = [];
	if (starts[0] !== 0) sections.push({ text: diff.slice(0, starts[0]), elided: true });
	for (let i = 0; i < starts.length; i++) {
		const end = i + 1 < starts.length ? starts[i + 1] : diff.length;
		sections.push({ text: diff.slice(starts[i], end), elided: false });
	}
	return sections;
}

function elide(section: Section, notice?: string): void {
	// Mark unconditionally: a section this function cannot reduce must still
	// leave the total-budget loop's candidate pool, or the loop never shrinks.
	section.elided = true;
	const lines = section.text.split("\n");
	// Keep the file header: everything up to and including the `+++` line (or
	// the whole header for binary/rename-only sections with no hunks).
	let headerEnd = lines.findIndex((line) => line.startsWith("+++ "));
	if (headerEnd === -1) headerEnd = lines.findIndex((line) => line.startsWith("@@ ")) - 1;
	if (headerEnd < 0) return;
	const body = lines.length - (headerEnd + 1);
	section.text = [
		...lines.slice(0, headerEnd + 1),
		notice ??
			`(diff content elided: ${body} lines over the size budget -- read this file from the checkout instead)`,
		"",
	].join("\n");
}
