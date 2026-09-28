/**
 * What deleting a relationship takes with it.
 *
 * Every path that deletes a relationship — deleting a reference field with the
 * checkbox left on, deleting the relationship itself, deleting a content type
 * one end sits on — removes the same three things, so all three dialogs spell
 * them out the same way.
 *
 * Naming the side of each field matters most for the linked-end one: deleting
 * an inverse field on Authors otherwise silently removes the primary field on
 * Posts, which is not what the person clicking Delete has in mind.
 */

import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";

import type { RelationWithUsage } from "../lib/api/relations.js";

export interface RelationImpactProps {
	relations: RelationWithUsage[];
	/** Field already being deleted, left out of the list so it is not named twice. */
	excludeField?: { collectionSlug: string; fieldSlug: string };
	/** Drop to `false` where the dialog is already about one named relationship. */
	nameRelations?: boolean;
}

export function RelationImpact({
	relations,
	excludeField,
	nameRelations = true,
}: RelationImpactProps) {
	const { t } = useLingui();

	if (relations.length === 0) return null;

	return (
		<ul className="mt-3 space-y-3 text-sm">
			{relations.map((relation) => {
				const fields = relation.boundFields.filter(
					(bound) =>
						!excludeField ||
						bound.collectionSlug !== excludeField.collectionSlug ||
						bound.fieldSlug !== excludeField.fieldSlug,
				);
				return (
					<li key={relation.id}>
						{nameRelations && (
							<code className="bg-kumo-tint px-1.5 py-0.5 rounded me-2">{relation.slug}</code>
						)}
						<span className="text-kumo-subtle">
							{plural(relation.linkCount, { one: "# link", other: "# links" })}
						</span>
						{fields.length > 0 && (
							<ul className="mt-1 space-y-1 text-kumo-subtle">
								{fields.map((bound) => (
									<li key={`${bound.collectionSlug}.${bound.fieldSlug}`}>
										{bound.side === "parent"
											? t`the ${bound.fieldSlug} field on ${bound.collectionSlug}, which picks entries it links to`
											: t`the ${bound.fieldSlug} field on ${bound.collectionSlug}, which lists entries that link to it`}
									</li>
								))}
							</ul>
						)}
					</li>
				);
			})}
		</ul>
	);
}
