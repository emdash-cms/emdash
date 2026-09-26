/**
 * Create a relation, or rename the roles of one, without leaving the page.
 *
 * Both the relations list and a content type's own relations panel open this
 * dialog, so a relation is defined the same way wherever it is reached from.
 */

import { Button, Dialog } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import { X } from "@phosphor-icons/react";

import type { SchemaCollection } from "../lib/api";
import type {
	CreateRelationInput,
	RelationWithUsage,
	UpdateRelationInput,
} from "../lib/api/relations.js";
import {
	RELATION_DIALOG_CLASS,
	RELATION_DIALOG_STYLE,
	RelationFormPanel,
} from "./RelationFormPanel.js";

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
}

export function RelationDialog({
	open,
	onOpenChange,
	collections,
	relation,
	defaultParentCollection,
	onSubmit,
}: RelationDialogProps) {
	const { t } = useLingui();

	return (
		<Dialog.Root open={open} onOpenChange={onOpenChange}>
			<Dialog size="lg" className={RELATION_DIALOG_CLASS} style={RELATION_DIALOG_STYLE}>
				{/* Reopening starts over: the panel holds the form, so a new one
				    drops whatever the last visit left in it. */}
				<RelationFormPanel
					key={open ? "open" : "closed"}
					collections={collections}
					relation={relation}
					defaultParentCollection={defaultParentCollection}
					onSubmit={async (input) => {
						await onSubmit(input);
						onOpenChange(false);
					}}
					cancelLabel={t`Cancel`}
					onCancel={() => onOpenChange(false)}
					headerAction={
						<Dialog.Close
							render={(props) => (
								<Button {...props} variant="ghost" shape="square" aria-label={t`Close`}>
									<X className="h-4 w-4" />
								</Button>
							)}
						/>
					}
				/>
			</Dialog>
		</Dialog.Root>
	);
}
