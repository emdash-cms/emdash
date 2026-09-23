export interface StagedTaxonomyAssignment {
	before: string[];
	after: string[];
}

export function stagedTaxonomyAssignments(
	data: Record<string, unknown>,
): Record<string, StagedTaxonomyAssignment> {
	const value = data._taxonomyDrafts;
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};

	const assignments = new Map<string, StagedTaxonomyAssignment>();
	for (const [name, assignment] of Object.entries(value)) {
		if (!assignment || typeof assignment !== "object" || Array.isArray(assignment)) continue;
		if (
			!Array.isArray(assignment.before) ||
			!assignment.before.every((group: unknown) => typeof group === "string") ||
			!Array.isArray(assignment.after) ||
			!assignment.after.every((group: unknown) => typeof group === "string")
		) {
			continue;
		}
		assignments.set(name, { before: assignment.before, after: assignment.after });
	}
	return Object.fromEntries(assignments);
}
