import type {
	BlockNoun,
	ImageBlock,
	MarkAnnotation,
	NormalizedBlock,
	SegmentMarks,
	TextBlock,
	TextRun,
} from "./types.js";

export type UnknownRecord = Record<string, unknown>;

const HEADING_STYLE = /^h[1-6]$/u;

const OPAQUE_NOUNS: ReadonlyMap<string, BlockNoun> = new Map([
	["block", "paragraph"],
	["table", "table"],
	["gallery", "gallery"],
	["video", "video"],
	["iframe", "embed"],
	["htmlBlock", "html"],
	["break", "divider"],
]);

export const EMPTY_MARKS: SegmentMarks = { decorators: [], annotations: [] };

export function isRecord(value: unknown): value is UnknownRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** JSON with object keys sorted, so equal values always serialize the same way. */
export function canonicalJson(value: unknown): string {
	return toCanonicalJson(value, false);
}

/** Canonical JSON that leaves out `_key` at every depth, so regenerated keys don't count as changes. */
export function canonicalJsonWithoutKeys(value: unknown): string {
	return toCanonicalJson(value, true);
}

function toCanonicalJson(value: unknown, omitKeys: boolean): string {
	if (Array.isArray(value)) {
		return `[${value.map((item: unknown) => toCanonicalJson(item ?? null, omitKeys)).join(",")}]`;
	}
	if (isRecord(value)) {
		const entries: string[] = [];
		for (const name of Object.keys(value).toSorted()) {
			const item = value[name];
			if (item === undefined || (omitKeys && name === "_key")) continue;
			entries.push(`${JSON.stringify(name)}:${toCanonicalJson(item, omitKeys)}`);
		}
		return `{${entries.join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}

function stripKeysDeep(value: unknown): unknown {
	if (Array.isArray(value)) return value.map((item: unknown) => stripKeysDeep(item));
	if (!isRecord(value)) return value;
	const stripped: UnknownRecord = {};
	for (const [name, item] of Object.entries(value)) {
		if (name !== "_key") stripped[name] = stripKeysDeep(item);
	}
	return stripped;
}

const marksKeys = new WeakMap<SegmentMarks, string>();

function marksKey(marks: SegmentMarks): string {
	let key = marksKeys.get(marks);
	if (key === undefined) {
		key = canonicalJson([marks.decorators, marks.annotations]);
		marksKeys.set(marks, key);
	}
	return key;
}

export function sameMarks(a: SegmentMarks, b: SegmentMarks): boolean {
	return a === b || marksKey(a) === marksKey(b);
}

const normalizedArrays = new WeakMap<readonly unknown[], readonly NormalizedBlock[]>();

/** Normalizes a Portable Text array once per array object. */
export function normalizeBlocks(blocks: readonly unknown[]): readonly NormalizedBlock[] {
	let normalized = normalizedArrays.get(blocks);
	if (!normalized) {
		normalized = blocks.map((block) => normalizeBlock(block));
		normalizedArrays.set(blocks, normalized);
	}
	return normalized;
}

function normalizeBlock(raw: unknown): NormalizedBlock {
	if (!isRecord(raw)) return { kind: "opaque", key: null, type: "unknown", raw };
	const key = nonEmptyString(raw._key);
	const type = nonEmptyString(raw._type) ?? "unknown";
	if (type === "block") {
		const text = normalizeTextBlock(raw, key);
		if (text) return text;
	}
	if (type === "image") return normalizeImage(raw, key);
	if (type === "code") {
		return {
			kind: "code",
			key,
			type,
			raw,
			language: nonEmptyString(raw.language),
			code: typeof raw.code === "string" ? raw.code : "",
		};
	}
	return { kind: "opaque", key, type, raw };
}

interface ResolvedAnnotation {
	annotation: MarkAnnotation;
	key: string;
}

/** Stored spans as runs with their marks resolved, or null when a child isn't a span. */
export function spanRuns(children: unknown, rawMarkDefs: unknown): TextRun[] | null {
	if (!Array.isArray(children)) return null;

	const markDefs = new Map<string, ResolvedAnnotation>();
	if (Array.isArray(rawMarkDefs)) {
		for (const markDef of rawMarkDefs) {
			if (!isRecord(markDef)) continue;
			const markKey = nonEmptyString(markDef._key);
			const markType = nonEmptyString(markDef._type);
			if (!markKey || !markType) continue;
			const annotation: MarkAnnotation = { ...stripKeys(markDef), _type: markType };
			markDefs.set(markKey, { annotation, key: canonicalJson(annotation) });
		}
	}

	const runs: TextRun[] = [];
	for (const child of children) {
		if (!isRecord(child) || typeof child.text !== "string") return null;
		if (!child.text) continue;
		const marks = resolveMarks(child.marks, markDefs);
		const last = runs.at(-1);
		if (last && sameMarks(last.marks, marks)) {
			runs[runs.length - 1] = { text: last.text + child.text, marks: last.marks };
		} else {
			runs.push({ text: child.text, marks });
		}
	}
	return runs;
}

function normalizeTextBlock(raw: UnknownRecord, key: string | null): TextBlock | null {
	const runs = spanRuns(raw.children, raw.markDefs);
	if (!runs) return null;

	const listItem = nonEmptyString(raw.listItem);
	return {
		kind: "text",
		key,
		type: "block",
		raw,
		style: nonEmptyString(raw.style) ?? "normal",
		listItem,
		level: listItem ? positiveInteger(raw.level) : null,
		listStart: listItem === "number" ? positiveInteger(raw.listStart) : null,
		textAlign: textAlignment(raw.textAlign),
		runs,
		text: runs.map((run) => run.text).join(""),
	};
}

function stripKeys(record: UnknownRecord): UnknownRecord {
	const stripped = stripKeysDeep(record);
	return isRecord(stripped) ? stripped : {};
}

function resolveMarks(
	marks: unknown,
	markDefs: ReadonlyMap<string, ResolvedAnnotation>,
): SegmentMarks {
	if (!Array.isArray(marks)) return EMPTY_MARKS;
	const decorators = new Set<string>();
	const annotations = new Map<string, MarkAnnotation>();
	for (const mark of marks) {
		if (typeof mark !== "string" || !mark) continue;
		const resolved = markDefs.get(mark);
		if (resolved) annotations.set(resolved.key, resolved.annotation);
		else decorators.add(mark);
	}
	if (decorators.size === 0 && annotations.size === 0) return EMPTY_MARKS;
	return {
		decorators: [...decorators].toSorted(),
		annotations: [...annotations]
			.toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
			.map(([, annotation]) => annotation),
	};
}

function normalizeImage(raw: UnknownRecord, key: string | null): ImageBlock {
	const asset = isRecord(raw.asset) ? raw.asset : {};
	const reference =
		nonEmptyString(asset._ref) ??
		nonEmptyString(asset.id) ??
		nonEmptyString(asset.url) ??
		nonEmptyString(asset.src);
	const provider = nonEmptyString(asset.provider) ?? "local";
	const alt =
		typeof raw.alt === "string" ? raw.alt : typeof asset.alt === "string" ? asset.alt : "";
	// The editor shows `title` as the caption only when the block has no `caption` of its own.
	const caption = Object.hasOwn(raw, "caption")
		? typeof raw.caption === "string"
			? raw.caption
			: ""
		: typeof raw.title === "string"
			? raw.title
			: "";
	return {
		kind: "image",
		key,
		type: "image",
		raw,
		asset: reference ? `${provider}:${reference}` : "",
		alt,
		caption,
	};
}

/** Image settings outside the asset, alt text and caption: alignment, link and display size. */
export function imageLayoutKey(block: ImageBlock): string {
	const raw = isRecord(block.raw) ? block.raw : {};
	return canonicalJson([
		nonEmptyString(raw.alignment),
		imageLink(raw.link),
		finiteNumber(raw.displayWidth),
		finiteNumber(raw.displayHeight),
	]);
}

function imageLink(link: unknown): [string, boolean] | null {
	if (typeof link === "string") return link.trim() ? [link.trim(), false] : null;
	if (!isRecord(link) || typeof link.href !== "string" || !link.href.trim()) return null;
	return [link.href.trim(), link.blank === true];
}

const signatures = new WeakMap<NormalizedBlock, string>();

/** A string that is equal for two blocks exactly when the diff treats them as unchanged. */
export function blockSignature(block: NormalizedBlock): string {
	let signature = signatures.get(block);
	if (signature === undefined) {
		signature = computeSignature(block);
		signatures.set(block, signature);
	}
	return signature;
}

function computeSignature(block: NormalizedBlock): string {
	switch (block.kind) {
		case "text":
			return canonicalJson([
				"text",
				block.style,
				block.listItem,
				block.level,
				block.listStart,
				block.textAlign,
				block.runs.map((run) => [run.text, run.marks.decorators, run.marks.annotations]),
			]);
		case "image":
			return canonicalJson(["image", block.asset, block.alt, block.caption, imageLayoutKey(block)]);
		case "code":
			return canonicalJson(["code", block.language, block.code]);
		case "opaque":
			return canonicalJson(["opaque", block.type, canonicalJsonWithoutKeys(block.raw)]);
	}
}

export function blockNoun(block: NormalizedBlock): BlockNoun {
	switch (block.kind) {
		case "text":
			if (block.listItem) return "listItem";
			if (HEADING_STYLE.test(block.style)) return "heading";
			return block.style === "blockquote" ? "quote" : "paragraph";
		case "image":
			return "image";
		case "code":
			return "code";
		case "opaque":
			return OPAQUE_NOUNS.get(block.type) ?? "custom";
	}
}

function nonEmptyString(value: unknown): string | null {
	return typeof value === "string" && value ? value : null;
}

function positiveInteger(value: unknown): number {
	return typeof value === "number" && Number.isInteger(value) && value >= 1 ? value : 1;
}

function finiteNumber(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function textAlignment(value: unknown): TextBlock["textAlign"] {
	switch (value) {
		case "center":
		case "right":
		case "justify":
			return value;
		default:
			return null;
	}
}
