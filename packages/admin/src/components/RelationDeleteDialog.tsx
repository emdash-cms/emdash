/**
 * Deleting a relationship, from wherever it is listed.
 *
 * It does not refuse when fields are bound to it: it names them and removes
 * them, the same cascade the field-delete checkbox and a content-type delete
 * run. A relationship a field still points at is not a state anything else in
 * the admin knows how to show.
 */

import { useLingui } from "@lingui/react/macro";

import type { RelationWithUsage } from "../lib/api/relations.js";
import { ConfirmDialog } from "./ConfirmDialog";
import { RelationImpact } from "./RelationImpact.js";

export interface RelationDeleteDialogProps {
	/** The relationship being deleted; absent closes the dialog. */
	relation: RelationWithUsage | null;
	onClose: () => void;
	onConfirm: (relation: RelationWithUsage) => void;
	isDeleting?: boolean;
	error?: unknown;
}

export function RelationDeleteDialog({
	relation,
	onClose,
	onConfirm,
	isDeleting,
	error,
}: RelationDeleteDialogProps) {
	const { t } = useLingui();

	return (
		<ConfirmDialog
			open={!!relation}
			onClose={onClose}
			title={relation ? t`Delete "${relation.slug}"?` : ""}
			description={t`This removes the relationship, every link stored under it, and the reference fields that use it:`}
			confirmLabel={t`Delete`}
			pendingLabel={t`Deleting...`}
			isPending={!!isDeleting}
			error={error}
			onConfirm={() => relation && onConfirm(relation)}
		>
			{relation && <RelationImpact relations={[relation]} nameRelations={false} />}
		</ConfirmDialog>
	);
}
