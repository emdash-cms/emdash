/**
 * Relation list view — every link definition on the site.
 *
 * A relation is schema, like a collection: it names two collections and the
 * roles each plays. Reference fields bind to one, from one end. A relation
 * with no bound field is still listed: unbinding the last field leaves one
 * behind, and this page is the only way to reach it again.
 */

import { Button } from "@cloudflare/kumo";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { ArrowRight, Pencil, Plus, Trash } from "@phosphor-icons/react";
import * as React from "react";

import type { SchemaCollection } from "../lib/api";
import type {
	CreateRelationInput,
	RelationWithUsage,
	UpdateRelationInput,
} from "../lib/api/relations.js";
import { ArrowPrev } from "./ArrowIcons.js";
import { RelationDeleteDialog } from "./RelationDeleteDialog.js";
import { RelationDialog } from "./RelationDialog.js";
import { RouterLinkButton } from "./RouterLinkButton.js";

export interface RelationListProps {
	relations: RelationWithUsage[];
	collections: SchemaCollection[];
	isLoading?: boolean;
	error?: string;
	onCreateRelation: (input: CreateRelationInput) => Promise<unknown>;
	onUpdateRelation: (id: string, input: UpdateRelationInput) => Promise<unknown>;
	/** Resolves once the relation is gone; a rejection keeps the dialog up. */
	onDeleteRelation: (id: string) => Promise<unknown>;
	isDeleting?: boolean;
	deleteError?: unknown;
}

export function RelationList({
	relations,
	collections,
	isLoading,
	error,
	onCreateRelation,
	onUpdateRelation,
	onDeleteRelation,
	isDeleting,
	deleteError,
}: RelationListProps) {
	const { t } = useLingui();
	const [createOpen, setCreateOpen] = React.useState(false);
	const [editing, setEditing] = React.useState<RelationWithUsage | null>(null);
	const [deleting, setDeleting] = React.useState<RelationWithUsage | null>(null);

	return (
		<div className="space-y-4">
			<div className="flex items-center justify-between gap-4">
				<div className="flex items-center gap-4 min-w-0">
					<RouterLinkButton
						to="/content-types"
						aria-label={t`Back to Content Types`}
						variant="ghost"
						shape="square"
						icon={<ArrowPrev />}
					/>
					<div className="min-w-0">
						<h1 className="text-2xl font-semibold leading-tight">{t`Relations`}</h1>
						<p className="mt-1 text-sm leading-5 text-pretty text-kumo-subtle">
							{t`Define how content types link to each other`}
						</p>
					</div>
				</div>
				<Button icon={<Plus />} onClick={() => setCreateOpen(true)}>
					{t`New Relation`}
				</Button>
			</div>

			{error && (
				<div className="rounded-md border border-kumo-danger/50 bg-kumo-danger-tint p-4 text-sm">
					{error}
				</div>
			)}

			<div className="rounded-md border bg-kumo-base overflow-x-auto">
				<table className="w-full">
					<thead>
						<tr className="border-b bg-kumo-tint/50">
							<th scope="col" className="px-4 py-3 text-start text-sm font-medium">
								{t`Slug`}
							</th>
							<th scope="col" className="px-4 py-3 text-start text-sm font-medium">
								{t`Connects`}
							</th>
							<th scope="col" className="px-4 py-3 text-start text-sm font-medium">
								{t`Fields`}
							</th>
							<th scope="col" className="px-4 py-3 text-start text-sm font-medium">
								{t`Links`}
							</th>
							<th scope="col" className="px-4 py-3 text-end text-sm font-medium">
								{t`Actions`}
							</th>
						</tr>
					</thead>
					<tbody className="divide-y divide-kumo-line">
						{isLoading ? (
							<tr>
								<td colSpan={5} className="px-4 py-8 text-center text-kumo-subtle">
									{t`Loading relations...`}
								</td>
							</tr>
						) : relations.length === 0 ? (
							<tr>
								<td colSpan={5} className="px-4 py-8 text-center text-kumo-subtle">
									{t`No relations yet.`}
								</td>
							</tr>
						) : (
							relations.map((relation) => (
								<RelationRow
									key={relation.id}
									relation={relation}
									onEdit={() => setEditing(relation)}
									onDelete={() => setDeleting(relation)}
								/>
							))
						)}
					</tbody>
				</table>
			</div>

			<RelationDialog
				open={createOpen}
				onOpenChange={setCreateOpen}
				collections={collections}
				onSubmit={onCreateRelation}
			/>

			{editing && (
				<RelationDialog
					key={editing.id}
					open
					onOpenChange={(open) => !open && setEditing(null)}
					collections={collections}
					relation={editing}
					onSubmit={(input) => onUpdateRelation(editing.id, input)}
				/>
			)}

			<RelationDeleteDialog
				relation={deleting}
				onClose={() => setDeleting(null)}
				onConfirm={(relation) => {
					// Closed only once the delete lands. A rejected one leaves the
					// dialog up to show `deleteError` and be tried again.
					void onDeleteRelation(relation.id)
						.then(() => setDeleting(null))
						.catch(() => {});
				}}
				isDeleting={isDeleting}
				error={deleteError}
			/>
		</div>
	);
}

function RelationRow({
	relation,
	onEdit,
	onDelete,
}: {
	relation: RelationWithUsage;
	onEdit: () => void;
	onDelete: () => void;
}) {
	const { t } = useLingui();

	return (
		<tr className="hover:bg-kumo-tint/25">
			<td className="px-4 py-3">
				<code className="text-sm font-medium">{relation.slug}</code>
			</td>
			<td className="px-4 py-3">
				<div className="flex items-center gap-2 text-sm">
					<span>{relation.parentCollection}</span>
					<ArrowRight
						className="h-3.5 w-3.5 text-kumo-subtle rtl:-scale-x-100"
						aria-hidden="true"
					/>
					<span>{relation.childCollection}</span>
				</div>
			</td>
			<td className="px-4 py-3">
				{relation.boundFields.length === 0 ? (
					<span className="text-sm text-kumo-subtle">{t`No fields`}</span>
				) : (
					<ul className="space-y-1">
						{relation.boundFields.map((bound) => (
							<li key={`${bound.collectionSlug}.${bound.fieldSlug}`} className="text-sm">
								<code className="bg-kumo-tint px-1.5 py-0.5 rounded">
									{bound.collectionSlug}.{bound.fieldSlug}
								</code>
								<span className="ms-2 text-xs text-kumo-subtle">
									{bound.side === "parent"
										? t`picks ${relation.childLabel}`
										: t`picks ${relation.parentLabel}`}
								</span>
							</li>
						))}
					</ul>
				)}
			</td>
			<td className="px-4 py-3 text-sm text-kumo-subtle">
				{plural(relation.linkCount, { one: "# link", other: "# links" })}
			</td>
			<td className="px-4 py-3">
				<div className="flex items-center justify-end gap-1">
					<Button
						onClick={onEdit}
						aria-label={t`Edit ${relation.slug}`}
						variant="ghost"
						shape="square"
						icon={<Pencil />}
					/>
					<Button
						onClick={onDelete}
						aria-label={t`Delete ${relation.slug}`}
						variant="ghost"
						shape="square"
						icon={<Trash className="text-kumo-danger" />}
					/>
				</div>
			</td>
		</tr>
	);
}
