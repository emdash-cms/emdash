/**
 * Relation list view — every link definition on the site.
 *
 * A relation is schema, like a collection: it names two collections and the
 * roles each plays. Reference fields bind to one, from one end. A relation
 * with no bound field is still listed: unbinding the last field leaves one
 * behind, and this page is the only way to reach it again.
 */

import { Button, DropdownMenu } from "@cloudflare/kumo";
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
import { cn } from "../lib/utils.js";
import { ArrowPrev } from "./ArrowIcons.js";
import {
	DataTable,
	DataTableMessage,
	RowActionsMenu,
	RowMeta,
	RowTitleButton,
	cellCodeClassName,
	secondaryColumn,
	tertiaryColumn,
} from "./DataTable.js";
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
			<div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
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

			<DataTable>
				<thead>
					<tr>
						<th scope="col">{t`Slug`}</th>
						<th scope="col" {...secondaryColumn}>
							{t`Connects`}
						</th>
						<th scope="col" {...tertiaryColumn}>
							{t`Fields`}
						</th>
						<th scope="col" {...secondaryColumn}>
							{t`Links`}
						</th>
						<th scope="col" className="w-0">
							<span className="sr-only">{t`Actions`}</span>
						</th>
					</tr>
				</thead>
				<tbody>
					{isLoading ? (
						<DataTableMessage colSpan={5}>{t`Loading relations...`}</DataTableMessage>
					) : relations.length === 0 ? (
						<DataTableMessage colSpan={5}>{t`No relations yet.`}</DataTableMessage>
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
			</DataTable>

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

	const connects = (
		<span className="inline-flex flex-wrap items-center gap-x-2 text-sm">
			<span className={cellCodeClassName}>{relation.parentCollection}</span>
			<ArrowRight className="h-3.5 w-3.5 text-kumo-subtle rtl:-scale-x-100" aria-hidden="true" />
			<span className={cellCodeClassName}>{relation.childCollection}</span>
		</span>
	);
	const links = plural(relation.linkCount, { one: "# link", other: "# links" });
	const fieldCount =
		relation.boundFields.length === 0
			? t`No fields`
			: plural(relation.boundFields.length, { one: "# field", other: "# fields" });

	return (
		<tr>
			<td>
				<RowTitleButton aria-label={t`Edit ${relation.slug}`} onClick={onEdit}>
					<code dir="ltr" className="text-sm wrap-anywhere">
						{relation.slug}
					</code>
				</RowTitleButton>
				<RowMeta>
					{connects}
					<span aria-hidden="true">·</span>
					<span className="text-sm">{links}</span>
				</RowMeta>
				<RowMeta priority="tertiary">
					<span className="text-sm">{fieldCount}</span>
				</RowMeta>
			</td>
			<td {...secondaryColumn}>{connects}</td>
			<td {...tertiaryColumn}>
				{relation.boundFields.length === 0 ? (
					<span className="text-sm text-kumo-subtle">{t`No fields`}</span>
				) : (
					<ul className="space-y-1 text-sm">
						{relation.boundFields.map((bound) => (
							<li key={`${bound.collectionSlug}.${bound.fieldSlug}`}>
								<code
									dir="ltr"
									className={cn(cellCodeClassName, "rounded bg-kumo-tint px-1.5 py-0.5")}
								>
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
			<td className="text-sm whitespace-nowrap text-kumo-subtle" {...secondaryColumn}>
				{links}
			</td>
			<td className="text-end">
				<RowActionsMenu label={t`Actions for ${relation.slug}`}>
					<DropdownMenu.Item
						icon={<Pencil className="me-2 size-4" aria-hidden="true" />}
						onClick={onEdit}
					>
						{t`Edit`}
					</DropdownMenu.Item>
					<DropdownMenu.Separator />
					<DropdownMenu.Item
						variant="danger"
						icon={<Trash className="me-2 size-4" aria-hidden="true" />}
						aria-label={t`Delete ${relation.slug}`}
						onClick={onDelete}
					>
						{t`Delete`}
					</DropdownMenu.Item>
				</RowActionsMenu>
			</td>
		</tr>
	);
}
