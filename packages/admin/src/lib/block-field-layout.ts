import type { BlockFieldDefinition } from "./api/schema.js";

export interface LayoutField {
	slug: string;
	type: string;
	required?: boolean;
}

export interface PlanField extends LayoutField {
	label: string;
}

export type BlockFieldPart<T extends PlanField = PlanField> =
	| { kind: "field"; field: T; heading?: true }
	| { kind: "columns"; fields: T[] }
	| { kind: "image"; field: T; caption?: T }
	| { kind: "button"; label: string; text: T; link: T };

export interface BlockFieldPlan<T extends PlanField = PlanField> {
	content: BlockFieldPart<T>[];
	settings: BlockFieldPart<T>[];
	advanced: T[];
}

export type ListPresentation = "lines" | "table" | "items";

export interface ListSubField extends PlanField {
	options?: string[];
}

export interface ListItemText {
	/** Empty when the item has no title field or its title is empty. */
	title: string;
	summary: string;
}

export interface BlockSummaryFormat {
	locale: string;
	/** Appends the count of titles left out of `list`, such as "+3". */
	withMore: (list: string, count: number) => string;
}

const LINK_SLUG = /^(.+)_(?:url|link|href)$/;
const SECTION_ID_SLUG = "anchor_id";
const CAPTION_SUFFIX = "_caption";
const SUMMARY_LIST_LENGTH = 3;
const MAX_COLUMNS = 3;
const MAX_TABLE_COLUMNS = 3;
const SETTING_TYPES = new Set([
	"boolean",
	"select",
	"multiSelect",
	"number",
	"integer",
	"datetime",
	"file",
]);
const TABLE_TYPES = new Set(["string", "url", "number", "integer", "select", "image"]);
const HEADLINE_WORDS = ["headline", "heading", "title", "statement"];
const NOT_HEADLINE_WORDS = ["label", "eyebrow", "kicker", "tag"];
const HINT_IN_PARENTHESES = /^(.*?)\s*\(([^()]*\s[^()]*)\)\s*$/;
const HINT_FOR_EXAMPLE = /^(.*?),\s*(for example\b.+)$/i;
const LABEL_WORD_SEPARATOR = /[^\p{L}\p{N}]+/u;
const TRAILING_TEXT_WORD = /\s+text$/i;
const WHITESPACE_RUN = /\s+/g;
const ITEM_SUMMARY_VALUES = 2;

export function isLinkField(field: LayoutField): boolean {
	return field.type === "url" || (field.type === "string" && LINK_SLUG.test(field.slug));
}

/**
 * Splits a trailing parenthetical that contains a space, or a trailing ", for example …",
 * off a label. Units and codes such as "(USD)" or "(16:9)" stay in the label.
 */
export function splitLabelHint(label: string): { label: string; hint?: string } {
	const match = HINT_IN_PARENTHESES.exec(label) ?? HINT_FOR_EXAMPLE.exec(label);
	const text = match?.[1]?.trim();
	const hint = match?.[2]?.trim();
	if (!text || !hint) return { label };
	return { label: text, hint: hint.charAt(0).toUpperCase() + hint.slice(1) };
}

interface ButtonPair<T> {
	text: T;
	link: T;
}

/**
 * Pairs each `{base}_url`, `{base}_link` or `{base}_href` link field with one `string` field
 * named `{base}_label`, `{base}_text` or `{base}`, preferred in that order.
 * The result is keyed by both slugs of each pair.
 */
function buttonPairs<T extends LayoutField>(
	fields: readonly T[],
	reserved: ReadonlySet<string> = new Set(),
): Map<string, ButtonPair<T>> {
	const bySlug = new Map(fields.map((field) => [field.slug, field]));
	const pairs = new Map<string, ButtonPair<T>>();
	for (const link of fields) {
		if (reserved.has(link.slug) || pairs.has(link.slug) || !isLinkField(link)) continue;
		const base = LINK_SLUG.exec(link.slug)?.[1];
		if (!base) continue;
		const text = [`${base}_label`, `${base}_text`, base]
			.map((slug) => bySlug.get(slug))
			.find(
				(candidate) =>
					candidate !== undefined &&
					candidate.type === "string" &&
					!isLinkField(candidate) &&
					!reserved.has(candidate.slug) &&
					!pairs.has(candidate.slug),
			);
		if (!text) continue;
		const pair = { text, link };
		pairs.set(text.slug, pair);
		pairs.set(link.slug, pair);
	}
	return pairs;
}

export function itemTitleField<T extends LayoutField>(subFields: readonly T[]): T | undefined {
	const pairs = buttonPairs(subFields);
	return (
		subFields.find(
			(field) => field.type === "string" && !isLinkField(field) && !pairs.has(field.slug),
		) ?? subFields.find((field) => field.type === "text")
	);
}

export function listPresentation(subFields: readonly LayoutField[]): ListPresentation {
	const [only] = subFields;
	if (subFields.length === 1 && only && (only.type === "string" || only.type === "url")) {
		return "lines";
	}
	if (
		subFields.length <= MAX_TABLE_COLUMNS &&
		subFields.every((field) => TABLE_TYPES.has(field.type)) &&
		subFields.filter((field) => field.type === "image").length <= 1
	) {
		return "table";
	}
	return "items";
}

function fieldWords(field: PlanField): Set<string> {
	const label = splitLabelHint(field.label).label.toLowerCase();
	return new Set(
		[...field.slug.toLowerCase().split("_"), ...label.split(LABEL_WORD_SEPARATOR)].filter(Boolean),
	);
}

function hasWord(field: PlanField, words: readonly string[]): boolean {
	const own = fieldWords(field);
	return words.some((word) => own.has(word));
}

function headlineField<T extends PlanField>(fields: readonly T[]): T | undefined {
	const texts = fields.filter((field) => field.type === "string" || field.type === "text");
	const candidates = texts.filter((field) => !hasWord(field, NOT_HEADLINE_WORDS));
	const [first] = candidates;
	return (
		candidates.find((field) => hasWord(field, HEADLINE_WORDS)) ??
		(first && first === texts[0] ? first : undefined)
	);
}

/**
 * Lays out an open block's fields, or a list item's sub-fields: content runs full width,
 * settings sit in label-and-value rows, and the section ID goes to Advanced.
 * Every field lands in exactly one part.
 */
export function planBlockFields<T extends PlanField>(
	fields: readonly T[],
	scope: "block" | "item",
): BlockFieldPlan<T> {
	const bySlug = new Map(fields.map((field) => [field.slug, field]));
	const captions = new Map<string, T>();
	const reserved = new Set<string>();
	if (scope === "block") {
		reserved.add(SECTION_ID_SLUG);
		for (const field of fields) {
			if (field.type !== "image") continue;
			const caption = bySlug.get(`${field.slug}${CAPTION_SUFFIX}`);
			if (caption?.type !== "string" || caption.slug === SECTION_ID_SLUG) continue;
			captions.set(field.slug, caption);
			reserved.add(caption.slug);
		}
	}
	const pairs = buttonPairs(fields, reserved);

	const placed = new Set(captions.values());
	const parts: BlockFieldPart<T>[] = [];
	const advanced: T[] = [];
	for (const field of fields) {
		if (placed.has(field)) continue;
		placed.add(field);
		if (scope === "block" && field.slug === SECTION_ID_SLUG) {
			advanced.push(field);
			continue;
		}
		if (field.type === "image") {
			parts.push({ kind: "image", field, caption: captions.get(field.slug) });
			continue;
		}
		const pair = pairs.get(field.slug);
		if (pair) {
			placed.add(pair.text);
			placed.add(pair.link);
			const label = splitLabelHint(pair.text.label).label.replace(TRAILING_TEXT_WORD, "");
			parts.push({ kind: "button", label, text: pair.text, link: pair.link });
			continue;
		}
		parts.push({ kind: "field", field });
	}

	const isSetting = (part: BlockFieldPart<T>) =>
		part.kind === "button" ||
		(part.kind === "image" && scope === "item") ||
		(part.kind === "field" && (SETTING_TYPES.has(part.field.type) || isLinkField(part.field)));
	const stack = parts.filter((part) => !isSetting(part));
	const heading =
		scope === "block"
			? headlineField(stack.flatMap((part) => (part.kind === "field" ? [part.field] : [])))
			: undefined;
	const columnField = (part: BlockFieldPart<T> | undefined) =>
		part?.kind === "field" && part.field.type === "string" && part.field !== heading
			? part.field
			: undefined;

	const content: BlockFieldPart<T>[] = [];
	for (let index = 0; index < stack.length;) {
		const run: T[] = [];
		for (let next = columnField(stack[index]); next && run.length < MAX_COLUMNS;) {
			run.push(next);
			next = columnField(stack[index + run.length]);
		}
		if (run.length >= 2) {
			content.push({ kind: "columns", fields: run });
			index += run.length;
			continue;
		}
		const part = stack[index++];
		if (!part) continue;
		content.push(
			part.kind === "field" && part.field === heading ? { ...part, heading: true } : part,
		);
	}
	return { content, settings: parts.filter(isSetting), advanced };
}

export function repeaterSubFields(field: Pick<BlockFieldDefinition, "validation">): ListSubField[] {
	const subFields = field.validation?.subFields;
	if (!Array.isArray(subFields)) return [];
	return subFields.flatMap((subField): ListSubField[] => {
		if (!isRecord(subField)) return [];
		const { slug, type, label, required, options } = subField;
		if (typeof slug !== "string" || typeof type !== "string") return [];
		return [
			{
				slug,
				type,
				label: typeof label === "string" && label ? label : slug,
				...(required === true ? { required } : {}),
				...(Array.isArray(options)
					? { options: options.filter((option): option is string => typeof option === "string") }
					: {}),
			},
		];
	});
}

/**
 * What a closed list item shows: its title, then up to two of its other plain `string`
 * values, or else the start of its first other `text` value.
 */
export function listItemText(
	item: Record<string, unknown>,
	subFields: readonly LayoutField[],
): ListItemText {
	const titleField = itemTitleField(subFields);
	const pairs = buttonPairs(subFields);
	const values = (type: string) =>
		subFields
			.filter(
				(field) =>
					field !== titleField &&
					field.type === type &&
					!isLinkField(field) &&
					!pairs.has(field.slug),
			)
			.map((field) => oneLine(item[field.slug]))
			.filter(Boolean);
	const strings = values("string");
	return {
		title: titleField ? oneLine(item[titleField.slug]) : "",
		summary:
			strings.length > 0
				? strings.slice(0, ITEM_SUMMARY_VALUES).join(" · ")
				: (values("text")[0] ?? ""),
	};
}

function oneLine(value: unknown): string {
	return typeof value === "string" ? value.trim().replace(WHITESPACE_RUN, " ") : "";
}

export function blockSummary(
	block: Record<string, unknown>,
	blockLabel: string,
	fields: readonly BlockFieldDefinition[],
	format: BlockSummaryFormat,
): string | null {
	const label = blockLabel.trim().toLocaleLowerCase();
	const texts = fields.filter(
		(field) =>
			(field.type === "string" || field.type === "text") &&
			!isLinkField(field) &&
			field.slug !== SECTION_ID_SLUG,
	);
	const requiredFirst = [
		...texts.filter((field) => field.required),
		...texts.filter((field) => !field.required),
	];
	for (const field of requiredFirst) {
		const text = filledText(block[field.slug]);
		if (text && text.toLocaleLowerCase() !== label) return text;
	}

	for (const field of fields) {
		if (field.type !== "portableText") continue;
		const text = firstTextBlock(block[field.slug]);
		if (text) return text;
	}

	const list = fields.find((field) => field.type === "repeater");
	if (!list) return null;
	const titleField = itemTitleField(repeaterSubFields(list));
	const items = block[list.slug];
	if (!titleField || !Array.isArray(items)) return null;
	const titles = items
		.map((item) => (isRecord(item) ? filledText(item[titleField.slug]) : null))
		.filter((title): title is string => title !== null);
	if (titles.length === 0) return null;
	const joined = new Intl.ListFormat(format.locale, { type: "unit", style: "short" }).format(
		titles.slice(0, SUMMARY_LIST_LENGTH),
	);
	const more = titles.length - SUMMARY_LIST_LENGTH;
	return more > 0 ? format.withMore(joined, more) : joined;
}

function filledText(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const text = value.trim();
	return text ? text : null;
}

function firstTextBlock(value: unknown): string | null {
	if (!Array.isArray(value)) return null;
	for (const node of value) {
		if (!isRecord(node) || node._type !== "block" || !Array.isArray(node.children)) continue;
		const text = filledText(
			node.children
				.map((child) => (isRecord(child) && typeof child.text === "string" ? child.text : ""))
				.join(""),
		);
		if (text) return text;
	}
	return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
