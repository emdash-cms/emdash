/**
 * Relations a content type takes part in, listed under its fields.
 *
 * A relation is schema that lives outside the collection — the relations list
 * owns the full view — but the collection editor is where someone asks "what
 * does this link to?", so the ones it is an end of are answered here, and can
 * be created, renamed and deleted without leaving the content type.
 */

import { Button } from "@cloudflare/kumo";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { ArrowRight, LinkSimple, Pencil, Plus, Trash } from "@phosphor-icons/react";
import * as React from "react";

import type { SchemaCollection } from "../lib/api";
import type {
	CreateRelationInput,
	RelationWithUsage,
	UpdateRelationInput,
} from "../lib/api/relations.js";
import { RelationDeleteDialog } from "./RelationDeleteDialog.js";
import { RelationDialog } from "./RelationDialog.js";

export interface RelationsPanelProps {
	/** The content type being edited — the end these relations are read from. */
	collectionSlug: string;
	/** Every relation on the site; the panel keeps the ones this end is in. */
	relations: RelationWithUsage[];
	collections: SchemaCollection[];
	isLoading?: boolean;
	onCreateRelation?: (input: CreateRelationInput) => Promise<unknown>;
	onUpdateRelation?: (id: string, input: UpdateRelationInput) => Promise<unknown>;
	/** Resolves once the relation is gone; a rejection keeps the dialog up. */
	onDeleteRelation?: (id: string) => Promise<unknown>;
	isDeletingRelation?: boolean;
	deleteRelationError?: unknown;
}

export function RelationsPanel({
	collectionSlug,
	relations,
	collections,
	isLoading,
	onCreateRelation,
	onUpdateRelation,
	onDeleteRelation,
	isDeletingRelation,
	deleteRelationError,
}: RelationsPanelProps) {
	const { t } = useLingui();
	const [createOpen, setCreateOpen] = React.useState(false);
	const [editing, setEditing] = React.useState<RelationWithUsage | null>(null);
	const [deleting, setDeleting] = React.useState<RelationWithUsage | null>(null);

	const participating = relations.filter(
		(relation) =>
			relation.parentCollection === collectionSlug || relation.childCollection === collectionSlug,
	);

	return (
		<div className="rounded-lg border bg-kumo-base">
			<div className="flex items-center justify-between gap-4 p-4 border-b">
				<div>
					<h2 className="font-semibold">{t`Relations`}</h2>
					<p className="text-sm text-kumo-subtle">
						{isLoading
							? t`Loading relations...`
							: plural(participating.length, {
									one: "# relation this content type takes part in",
									other: "# relations this content type takes part in",
								})}
					</p>
				</div>
				{onCreateRelation && (
					<Button icon={<Plus />} onClick={() => setCreateOpen(true)}>
						{t`New Relation`}
					</Button>
				)}
			</div>

			{participating.length === 0 ? (
				<div className="p-8 text-center text-kumo-subtle">
					<LinkSimple className="mx-auto h-12 w-12 mb-4 opacity-50" />
					<p className="font-medium">{t`No relations yet`}</p>
					<p className="text-sm">
						{t`Create one to let entries here link to entries in another content type.`}
					</p>
				</div>
			) : (
				<div className="divide-y divide-kumo-line">
					{participating.map((relation) => (
						<RelationRow
							key={relation.id}
							relation={relation}
							collectionSlug={collectionSlug}
							onEdit={onUpdateRelation ? () => setEditing(relation) : undefined}
							onDelete={onDeleteRelation ? () => setDeleting(relation) : undefined}
						/>
					))}
				</div>
			)}

			{onCreateRelation && (
				<RelationDialog
					open={createOpen}
					onOpenChange={setCreateOpen}
					collections={collections}
					defaultParentCollection={collectionSlug}
					onSubmit={onCreateRelation}
				/>
			)}

			{onUpdateRelation && editing && (
				<RelationDialog
					key={editing.id}
					open
					onOpenChange={(open) => !open && setEditing(null)}
					collections={collections}
					relation={editing}
					onSubmit={(input) => onUpdateRelation(editing.id, input)}
				/>
			)}

			{onDeleteRelation && (
				<RelationDeleteDialog
					relation={deleting}
					onClose={() => setDeleting(null)}
					onConfirm={(relation) => {
						// Closed only once the delete lands, so a rejected one keeps
						// its error and its retry. Mirrors the relations list.
						void onDeleteRelation(relation.id)
							.then(() => setDeleting(null))
							.catch(() => {});
					}}
					isDeleting={isDeletingRelation}
					error={deleteRelationError}
				/>
			)}
		</div>
	);
}

function RelationRow({
	relation,
	collectionSlug,
	onEdit,
	onDelete,
}: {
	relation: RelationWithUsage;
	collectionSlug: string;
	onEdit?: () => void;
	onDelete?: () => void;
}) {
	const { t } = useLingui();

	const isParent = relation.parentCollection === collectionSlug;
	const isChild = relation.childCollection === collectionSlug;
	const ownFields = relation.boundFields.filter((bound) => bound.collectionSlug === collectionSlug);

	return (
		<div className="flex items-center gap-4 px-4 py-3 hover:bg-kumo-tint/25">
			<div className="min-w-0 flex-1">
				<div className="flex flex-wrap items-center gap-x-3 gap-y-1">
					<code className="text-sm font-medium">{relation.slug}</code>
					<span className="flex items-center gap-1.5 text-sm text-kumo-subtle">
						{relation.parentCollection}
						<ArrowRight className="h-3 w-3 rtl:-scale-x-100" aria-hidden="true" />
						{relation.childCollection}
					</span>
				</div>

				<p className="mt-1 text-sm text-kumo-subtle">
					{isParent && <span>{t`Links to ${relation.childLabel}`}</span>}
					{isParent && isChild && <span aria-hidden="true"> · </span>}
					{isChild && <span>{t`Linked from ${relation.parentLabel}`}</span>}
				</p>

				{ownFields.length === 0 ? (
					<p className="mt-1 text-xs text-kumo-subtle">{t`No field on this content type uses it yet`}</p>
				) : (
					<ul className="mt-1 flex flex-wrap gap-1.5">
						{ownFields.map((bound) => (
							<li key={bound.fieldSlug}>
								<code className="rounded bg-kumo-tint px-1.5 py-0.5 text-xs">
									{bound.fieldSlug}
								</code>
							</li>
						))}
					</ul>
				)}
			</div>

			<span className="whitespace-nowrap text-sm text-kumo-subtle">
				{plural(relation.linkCount, { one: "# link", other: "# links" })}
			</span>

			{onEdit && (
				<Button
					onClick={onEdit}
					aria-label={t`Edit ${relation.slug}`}
					variant="ghost"
					shape="square"
					icon={<Pencil />}
				/>
			)}
			{onDelete && (
				<Button
					onClick={onDelete}
					aria-label={t`Delete ${relation.slug}`}
					variant="ghost"
					shape="square"
					icon={<Trash className="text-kumo-danger" />}
				/>
			)}
		</div>
	);
}
