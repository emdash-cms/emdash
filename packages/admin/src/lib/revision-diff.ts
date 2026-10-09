/**
 * Readable diffs for the revisions panel.
 *
 * A Portable Text value is compared block by block on each block's plain text, not on `_key`: a write through the
 * Markdown path of the API or MCP re-keys every block, and a key match would then report the whole body as changed.
 * Runs of removed and added blocks between unchanged ones are paired up as edits and diffed word by word.
 */

export type WordOp = "=" | "-" | "+";
export type WordSegment = [WordOp, string];

export type BodyChange =
	| { kind: "changed"; segments: WordSegment[] }
	| { kind: "added"; text: string }
	| { kind: "removed"; text: string };

/** Above this many comparisons (rows x columns) an LCS table is not built; callers fall back to the full values. */
/** A paired block keeping less than this share of its text reads better as old then new than as interleaved words. */
const MIN_KEPT_SHARE = 0.25;
const MAX_LCS_CELLS = 4_000_000;
const HEADING_STYLE = /^h[1-6]$/;
const WHITESPACE_RUN = /(\s+)/;

interface PortableTextMarkDef {
	_key?: unknown;
	_type?: unknown;
	href?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/** True when the value looks like a Portable Text array (at least one object with a `_type`). */
export function isPortableText(value: unknown): value is unknown[] {
	return Array.isArray(value) && value.some((block) => isRecord(block) && "_type" in block);
}

/**
 * One line of readable text for a block: a text block's words with each link's address after its text, list items
 * and headings marked, an image as its alt text and caption, any other block type by name.
 */
export function blockText(block: unknown): string {
	if (!isRecord(block)) return typeof block === "string" ? block : "";
	const type = typeof block._type === "string" ? block._type : "";
	if (type === "block") {
		const defs = new Map<unknown, PortableTextMarkDef>();
		if (Array.isArray(block.markDefs)) {
			for (const def of block.markDefs) {
				if (isRecord(def)) defs.set(def._key, def);
			}
		}
		const children: unknown[] = Array.isArray(block.children) ? block.children : [];
		const text = children
			.map((child) => {
				if (!isRecord(child)) return "";
				const words = typeof child.text === "string" ? child.text : "";
				const marks: unknown[] = Array.isArray(child.marks) ? child.marks : [];
				const link = marks.map((mark) => defs.get(mark)).find((def) => def?._type === "link");
				return link && typeof link.href === "string" ? `${words} [${link.href}]` : words;
			})
			.join("");
		const style = typeof block.style === "string" ? block.style : "";
		const prefix =
			block.listItem === "number"
				? "1. "
				: block.listItem
					? "• "
					: HEADING_STYLE.test(style)
						? `${"#".repeat(Number(style.slice(1)))} `
						: "";
		return prefix + text;
	}
	if (type === "image") {
		const alt = typeof block.alt === "string" ? block.alt : "";
		const caption = typeof block.caption === "string" && block.caption ? ` | ${block.caption}` : "";
		return `[image: ${alt}${caption}]`;
	}
	return `[${type || "block"}]`;
}

/** Longest-common-subsequence alignment of two string lists, or null when the inputs are too large to align. */
export function alignSequences(a: string[], b: string[]): WordSegment[] | null {
	const n = a.length;
	const m = b.length;
	if (n * m > MAX_LCS_CELLS) return null;
	const table = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
	for (let i = n - 1; i >= 0; i--) {
		for (let j = m - 1; j >= 0; j--) {
			table[i]![j] =
				a[i] === b[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
		}
	}
	const out: WordSegment[] = [];
	let i = 0;
	let j = 0;
	while (i < n && j < m) {
		if (a[i] === b[j]) {
			out.push(["=", a[i]!]);
			i++;
			j++;
		} else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
			out.push(["-", a[i++]!]);
		} else {
			out.push(["+", b[j++]!]);
		}
	}
	while (i < n) out.push(["-", a[i++]!]);
	while (j < m) out.push(["+", b[j++]!]);
	return out;
}

function wordTokens(text: string): string[] {
	return text.split(WHITESPACE_RUN).filter((token) => token !== "");
}

/** Word-level diff of two strings; whitespace is kept, and runs of the same operation are merged. */
export function diffWords(oldText: string, newText: string): WordSegment[] {
	const ops = alignSequences(wordTokens(oldText), wordTokens(newText));
	if (!ops)
		return [
			["-", oldText],
			["+", newText],
		];
	const merged: WordSegment[] = [];
	for (const [op, token] of ops) {
		const last = merged.at(-1);
		if (last && last[0] === op) last[1] += token;
		else merged.push([op, token]);
	}
	return merged;
}

/**
 * The blocks that differ between two Portable Text values, in order, and how many are unchanged. Null when the bodies
 * are too long to align, in which case the caller shows the full values.
 */
export function diffPortableText(
	oldValue: unknown[],
	newValue: unknown[],
): { changes: BodyChange[]; unchanged: number } | null {
	const ops = alignSequences(oldValue.map(blockText), newValue.map(blockText));
	if (!ops) return null;
	const changes: BodyChange[] = [];
	let unchanged = 0;
	let removed: string[] = [];
	let added: string[] = [];
	const flush = () => {
		const paired = Math.min(removed.length, added.length);
		for (let i = 0; i < paired; i++) {
			const before = removed[i]!;
			const after = added[i]!;
			const segments = diffWords(before, after);
			const kept = segments.reduce((n, [op, text]) => (op === "=" ? n + text.length : n), 0);
			if (kept < MIN_KEPT_SHARE * Math.max(before.length, after.length)) {
				changes.push({ kind: "removed", text: before }, { kind: "added", text: after });
			} else {
				changes.push({ kind: "changed", segments });
			}
		}
		for (const text of removed.slice(paired)) changes.push({ kind: "removed", text });
		for (const text of added.slice(paired)) changes.push({ kind: "added", text });
		removed = [];
		added = [];
	};
	for (const [op, text] of ops) {
		if (op === "=") {
			flush();
			unchanged++;
		} else if (op === "-") {
			removed.push(text);
		} else {
			added.push(text);
		}
	}
	flush();
	return { changes, unchanged };
}
