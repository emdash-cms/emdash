/**
 * The relation form as a dialog's whole contents: a header that names what is
 * being defined, the form in a scroll area of its own, and the actions pinned
 * under it.
 *
 * A relation is defined from three places — the relations list, a content
 * type's relations panel, and the field dialog on its way to a reference field
 * — and each of them is a dialog. Sharing the chrome, not just the fields, is
 * what keeps the third from being a plainer version of the other two.
 *
 * Render it inside a `LayerDialog.Root`; see `RelationDialog`.
 */

import { LayerDialog } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import * as React from "react";

import type { SchemaCollection } from "../lib/api";
import type {
	CreateRelationInput,
	RelationWithUsage,
	UpdateRelationInput,
} from "../lib/api/relations.js";
import { DialogError, getMutationError } from "./DialogError";
import { RelationFormFields, useRelationForm } from "./RelationForm.js";

export interface RelationFormPanelProps {
	collections: SchemaCollection[];
	/** The relation being edited; absent defines a new one. */
	relation?: RelationWithUsage;
	/** Prefills the linking end of a new relation. */
	defaultParentCollection?: string;
	/** Resolves once the relation is saved; rejects with the server's message.
	 * What happens next — closing, or going back to the field — is the
	 * caller's. */
	onSubmit: (input: CreateRelationInput & UpdateRelationInput) => Promise<unknown>;
	/** The way out: Cancel from a dialog of its own, Back from inside another. */
	dismissLabel: string;
	/** Reports a save in flight, so the dialog can refuse to close under it. */
	onSavingChange: (saving: boolean) => void;
}

export function RelationFormPanel({
	collections,
	relation,
	defaultParentCollection,
	onSubmit,
	dismissLabel,
	onSavingChange,
}: RelationFormPanelProps) {
	const { t } = useLingui();
	const isNew = !relation;
	const form = useRelationForm({ relation, isNew, collections, defaultParentCollection });
	const formId = React.useId();
	const [isSaving, setIsSaving] = React.useState(false);
	const [error, setError] = React.useState<string | null>(null);

	const setSaving = (saving: boolean) => {
		setIsSaving(saving);
		onSavingChange(saving);
	};

	const handleSubmit = async (event: React.FormEvent) => {
		event.preventDefault();
		if (!form.canSave || isSaving) return;
		setSaving(true);
		setError(null);
		try {
			await onSubmit(form.toInput() as CreateRelationInput & UpdateRelationInput);
		} catch (err) {
			setError(getMutationError(err));
		} finally {
			setSaving(false);
		}
	};

	return (
		<LayerDialog.Content size="lg">
			<LayerDialog.Title>{isNew ? t`New Relation` : t`Edit ${relation.slug}`}</LayerDialog.Title>
			<LayerDialog.Description>
				{isNew
					? t`A relation defines how two content types link. Reference fields on either side then pick entries through it.`
					: t`The content types and the slug are fixed. What each side is called and how many entries it holds are not.`}
			</LayerDialog.Description>
			<LayerDialog.Body>
				<form id={formId} onSubmit={handleSubmit}>
					<RelationFormFields form={form} collections={collections} isNew={isNew} />
					<DialogError message={error} className="mt-4" />
				</form>
			</LayerDialog.Body>
			<LayerDialog.Actions dismissLabel={dismissLabel}>
				<LayerDialog.Action
					type="submit"
					form={formId}
					disabled={!form.canSave || (!isNew && !form.isDirty) || isSaving}
				>
					{isNew
						? isSaving
							? t`Creating...`
							: t`Create Relation`
						: isSaving
							? t`Saving...`
							: t`Save Relation`}
				</LayerDialog.Action>
			</LayerDialog.Actions>
		</LayerDialog.Content>
	);
}
