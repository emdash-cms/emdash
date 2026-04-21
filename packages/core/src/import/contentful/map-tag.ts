/**
 * Contentful blogTag → EmDash taxonomy term.
 */

export interface ContentfulTagTerm {
	label: string;
	slug: string;
}

export function mapTag(entry: { fields: Record<string, unknown> }): ContentfulTagTerm {
	return {
		label: (entry.fields.name as string) ?? "",
		slug: (entry.fields.slug as string) ?? "",
	};
}
