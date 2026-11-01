/**
 * Create a relation, or rename the roles of one, without leaving the page.
 *
 * Both the relations list and a content type's own relations panel open this
 * dialog, so a relation is defined the same way wherever it is reached from.
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
import { guardUnsavedInput } from "../lib/dialog-form.js";
import { RelationFormPanel } from "./RelationFormPanel.js";

export interface RelationDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	collections: SchemaCollection[];
	/** The relation being edited; absent creates one. */
	relation?: RelationWithUsage;
	/** Prefills the linking end of a new relation. */
	defaultParentCollection?: string;
	/** Resolves once the relation is saved; rejects with the server's message. */
	onSubmit: (input: CreateRelationInput & UpdateRelationInput) => Promise<unknown>;
	/** Label of the button that leaves without saving. Defaults to Cancel. */
	dismissLabel?: string;
}

export function RelationDialog({
	open,
	onOpenChange,
	collections,
	relation,
	defaultParentCollection,
	onSubmit,
	dismissLabel,
}: RelationDialogProps) {
	const { t } = useLingui();
	const [saving, setSaving] = React.useState(false);
	const [dirty, setDirty] = React.useState(false);
	// Each opening starts a new form from the props it opens with. The panel
	// renders the popup, so it is replaced as the dialog opens, never while it
	// closes: replacing it mid-transition keeps the dialog from unmounting.
	const [visit, setVisit] = React.useState(0);
	const [wasOpen, setWasOpen] = React.useState(open);
	if (open !== wasOpen) {
		setWasOpen(open);
		if (open) setVisit(visit + 1);
	}

	return (
		<LayerDialog.Root
			open={open}
			{...guardUnsavedInput(dirty, onOpenChange)}
			dismissDisabled={saving}
		>
			<RelationFormPanel
				key={visit}
				collections={collections}
				relation={relation}
				defaultParentCollection={defaultParentCollection}
				onSubmit={async (input) => {
					await onSubmit(input);
					onOpenChange(false);
				}}
				dismissLabel={dismissLabel ?? t`Cancel`}
				onSavingChange={setSaving}
				onDirtyChange={setDirty}
			/>
		</LayerDialog.Root>
	);
}
