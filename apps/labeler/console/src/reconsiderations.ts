/**
 * Presentation helper for reconsideration actor provenance. Humans carry an
 * email, service tokens a common name; both fall back to the raw Access subject
 * id so a row always renders someone.
 */
export function reconsiderationActorName(actor: {
	email: string | null;
	commonName: string | null;
	id: string;
}): string {
	return actor.email ?? actor.commonName ?? actor.id;
}
