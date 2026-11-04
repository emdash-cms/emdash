/** The label the content editor shows for a field, falling back to its capitalized slug. */
export function getFieldLabel(slug: string, field?: { label?: string }): string {
	return field?.label || slug.charAt(0).toUpperCase() + slug.slice(1);
}
