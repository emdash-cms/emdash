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
 * The dialog around it supplies the frame this expects: `p-0`, a column flex
 * box, and a height cap. See `RELATION_DIALOG_CLASS`.
 */

import { Button, Dialog } from "@cloudflare/kumo";
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

/** The frame the panel is built for. */
export const RELATION_DIALOG_CLASS = "flex max-h-[min(88dvh,46rem)] flex-col overflow-hidden p-0";
export const RELATION_DIALOG_STYLE: React.CSSProperties = { width: "min(94vw, 40rem)" };

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
	cancelLabel: string;
	onCancel: () => void;
	/** Rendered at the end of the header — the dialog's close button. */
	headerAction?: React.ReactNode;
}

export function RelationFormPanel({
	collections,
	relation,
	defaultParentCollection,
	onSubmit,
	cancelLabel,
	onCancel,
	headerAction,
}: RelationFormPanelProps) {
	const { t } = useLingui();
	const isNew = !relation;
	const form = useRelationForm({ relation, isNew, collections, defaultParentCollection });
	const [isSaving, setIsSaving] = React.useState(false);
	const [error, setError] = React.useState<string | null>(null);

	const handleSubmit = async (event: React.FormEvent) => {
		event.preventDefault();
		if (!form.canSave || isSaving) return;
		setIsSaving(true);
		setError(null);
		try {
			await onSubmit(form.toInput() as CreateRelationInput & UpdateRelationInput);
		} catch (err) {
			setError(getMutationError(err));
		} finally {
			setIsSaving(false);
		}
	};

	return (
		<>
			<div className="flex shrink-0 items-start justify-between gap-4 border-b border-kumo-line px-6 py-5">
				<div className="min-w-0">
					<Dialog.Title className="text-lg font-semibold leading-tight tracking-tight">
						{isNew ? t`New Relation` : t`Edit ${relation.slug}`}
					</Dialog.Title>
					<Dialog.Description className="mt-1 text-sm leading-5 text-kumo-subtle">
						{isNew
							? t`A relation defines how two content types link. Reference fields on either side then pick entries through it.`
							: t`The content types and the slug are fixed. What each side is called and how many entries it holds are not.`}
					</Dialog.Description>
				</div>
				{headerAction}
			</div>

			<form onSubmit={handleSubmit} className="flex min-h-0 flex-1 flex-col">
				<div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-6 py-5">
					<RelationFormFields form={form} collections={collections} isNew={isNew} />
				</div>

				<div className="shrink-0 border-t border-kumo-line px-6 py-4">
					<DialogError message={error} className="mb-3" />

					<div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
						<Button type="button" variant="outline" onClick={onCancel} disabled={isSaving}>
							{cancelLabel}
						</Button>
						<Button type="submit" disabled={!form.canSave || (!isNew && !form.isDirty) || isSaving}>
							{isNew
								? isSaving
									? t`Creating...`
									: t`Create Relation`
								: isSaving
									? t`Saving...`
									: t`Save Relation`}
						</Button>
					</div>
				</div>
			</form>
		</>
	);
}
