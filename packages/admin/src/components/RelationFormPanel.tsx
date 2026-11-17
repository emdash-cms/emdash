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
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import * as React from "react";

import type { SchemaCollection } from "../lib/api";
import { ApiResponseError } from "../lib/api/client.js";
import type {
	CreateRelationInput,
	RelationWithUsage,
	UpdateRelationInput,
} from "../lib/api/relations.js";
import { revealErrors, useTakenValue } from "../lib/dialog-form.js";
import { DialogError, getMutationError } from "./DialogError";
import {
	type RelationField,
	type RelationFormErrors,
	RelationFormFields,
	useRelationForm,
} from "./RelationForm.js";

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
	/** Reports whether the form holds changes a stray press must not discard. */
	onDirtyChange: (dirty: boolean) => void;
}

export function RelationFormPanel({
	collections,
	relation,
	defaultParentCollection,
	onSubmit,
	dismissLabel,
	onSavingChange,
	onDirtyChange,
}: RelationFormPanelProps) {
	const { t } = useLingui();
	const isNew = !relation;
	const form = useRelationForm({ relation, isNew, collections, defaultParentCollection });
	const formId = React.useId();
	const [isSaving, setIsSaving] = React.useState(false);
	const [error, setError] = React.useState<string | null>(null);
	const [submitted, setSubmitted] = React.useState(false);
	const takenSlug = useTakenValue(form.state.slug);

	React.useEffect(() => onDirtyChange(form.isDirty), [form.isDirty, onDirtyChange]);

	const problems = takenSlug.isTaken
		? {
				...form.problems,
				slug: msg`Another relation already uses this slug. Enter a different one.`,
			}
		: form.problems;
	const errors: RelationFormErrors = {};
	if (submitted) {
		for (const [field, message] of Object.entries(problems)) {
			errors[field as RelationField] = t(message);
		}
	}

	const setSaving = (saving: boolean) => {
		setIsSaving(saving);
		onSavingChange(saving);
	};

	const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		if (isSaving) return;
		const formElement = event.currentTarget;
		const showErrors = (update?: () => void) => {
			revealErrors(formElement, () => {
				setSubmitted(true);
				update?.();
			});
		};
		if (Object.keys(problems).length > 0) {
			showErrors();
			return;
		}
		const { slug } = form.state;
		setSaving(true);
		setError(null);
		try {
			await onSubmit(form.toInput() as CreateRelationInput & UpdateRelationInput);
		} catch (err) {
			if (
				isNew &&
				err instanceof ApiResponseError &&
				err.code === "CONFLICT" &&
				takenSlug.stillHolds(slug)
			) {
				showErrors(() => takenSlug.take(slug, err));
			} else {
				setError(getMutationError(err));
			}
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
				<form id={formId} noValidate onSubmit={handleSubmit}>
					<RelationFormFields form={form} collections={collections} isNew={isNew} errors={errors} />
					<DialogError message={error} className="mt-4" />
				</form>
			</LayerDialog.Body>
			<LayerDialog.Actions dismissLabel={dismissLabel}>
				<LayerDialog.Action
					type="submit"
					form={formId}
					disabled={(!isNew && !form.isDirty) || isSaving}
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
