import type { BlockFieldDefinition } from "./api/schema.js";

export interface LayoutField {
	slug: string;
	type: string;
	required?: boolean;
}

export interface BlockSummaryFormat {
	locale: string;
	/** Appends the count of titles left out of `list`, such as "+3". */
	withMore: (list: string, count: number) => string;
}

const LINK_SUFFIXES = ["url", "link", "href"] as const;
const LINK_SLUG = /_(?:url|link|href)$/;
const BUTTON_TEXT_SLUG = /^(.+)_(?:label|text)$/;
const SECTION_ID_SLUG = "anchor_id";
const SUMMARY_LIST_LENGTH = 3;

export function isLinkField(field: LayoutField): boolean {
	return field.type === "url" || (field.type === "string" && LINK_SLUG.test(field.slug));
}

/** Pairs `{base}_label`, `{base}_text` or `{base}` with a `{base}_url`, `{base}_link` or `{base}_href` sibling. */
export function isButtonTextField(field: LayoutField, siblings: readonly LayoutField[]): boolean {
	if (isLinkField(field)) return false;
	const links = new Set(siblings.filter(isLinkField).map((sibling) => sibling.slug));
	const bases = [field.slug];
	const textBase = BUTTON_TEXT_SLUG.exec(field.slug)?.[1];
	if (textBase) bases.push(textBase);
	return bases.some((base) => LINK_SUFFIXES.some((suffix) => links.has(`${base}_${suffix}`)));
}

export function itemTitleField<T extends LayoutField>(subFields: readonly T[]): T | undefined {
	return (
		subFields.find(
			(field) =>
				field.type === "string" && !isLinkField(field) && !isButtonTextField(field, subFields),
		) ?? subFields.find((field) => field.type === "text")
	);
}

export function repeaterSubFields(field: BlockFieldDefinition): LayoutField[] {
	const subFields = field.validation?.subFields;
	if (!Array.isArray(subFields)) return [];
	return subFields.filter(
		(subField): subField is LayoutField =>
			isRecord(subField) && typeof subField.slug === "string" && typeof subField.type === "string",
	);
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
