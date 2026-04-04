import { Badge, Button, buttonVariants } from "@cloudflare/kumo";
import { Plus, Pencil, Trash } from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import * as React from "react";

import type { TaxonomyDef } from "../lib/api/taxonomies.js";
import { ConfirmDialog } from "./ConfirmDialog";

export interface TaxonomyTypeListProps {
	taxonomies: TaxonomyDef[];
	isLoading?: boolean;
	onDelete?: (name: string) => void;
	deleteError?: unknown;
	isDeleting?: boolean;
}

/**
 * Taxonomy Type list view — shows all taxonomy definitions with CRUD actions.
 */
export function TaxonomyTypeList({
	taxonomies,
	isLoading,
	onDelete,
	deleteError,
	isDeleting,
}: TaxonomyTypeListProps) {
	const [deleteTarget, setDeleteTarget] = React.useState<TaxonomyDef | null>(null);

	return (
		<div className="space-y-4">
			{/* Header */}
			<div className="flex items-center justify-between">
				<div>
					<h1 className="text-2xl font-bold">Taxonomy Types</h1>
					<p className="text-kumo-subtle text-sm">
						Define how content is classified and organized
					</p>
				</div>
				<Link to="/taxonomy-types/new" className={buttonVariants()}>
					<Plus className="mr-2 h-4 w-4" aria-hidden="true" />
					New Taxonomy
				</Link>
			</div>

			{/* Table */}
			<div className="rounded-md border overflow-x-auto">
				<table className="w-full">
					<thead>
						<tr className="border-b bg-kumo-tint/50">
							<th scope="col" className="px-4 py-3 text-left text-sm font-medium">
								Name
							</th>
							<th scope="col" className="px-4 py-3 text-left text-sm font-medium">
								Slug
							</th>
							<th scope="col" className="px-4 py-3 text-left text-sm font-medium">
								Type
							</th>
							<th scope="col" className="px-4 py-3 text-left text-sm font-medium">
								Collections
							</th>
							<th scope="col" className="px-4 py-3 text-right text-sm font-medium">
								Actions
							</th>
						</tr>
					</thead>
					<tbody>
						{isLoading ? (
							<tr>
								<td colSpan={5} className="px-4 py-8 text-center text-kumo-subtle">
									Loading taxonomies...
								</td>
							</tr>
						) : taxonomies.length === 0 ? (
							<tr>
								<td colSpan={5} className="px-4 py-8 text-center text-kumo-subtle">
									No taxonomy types yet.{" "}
									<Link to="/taxonomy-types/new" className="text-kumo-brand underline">
										Create your first one
									</Link>
								</td>
							</tr>
						) : (
							taxonomies.map((taxonomy) => (
								<TaxonomyTypeRow
									key={taxonomy.id}
									taxonomy={taxonomy}
									onRequestDelete={setDeleteTarget}
								/>
							))
						)}
					</tbody>
				</table>
			</div>

			<ConfirmDialog
				open={!!deleteTarget}
				onClose={() => setDeleteTarget(null)}
				title="Delete Taxonomy?"
				description={
					deleteTarget
						? `Are you sure you want to delete "${deleteTarget.label}"? This will also delete all terms in this taxonomy.`
						: ""
				}
				confirmLabel="Delete"
				pendingLabel="Deleting..."
				isPending={isDeleting ?? false}
				error={deleteError ?? null}
				onConfirm={() => {
					if (deleteTarget) {
						onDelete?.(deleteTarget.name);
					}
				}}
			/>
		</div>
	);
}

interface TaxonomyTypeRowProps {
	taxonomy: TaxonomyDef;
	onRequestDelete?: (taxonomy: TaxonomyDef) => void;
}

function TaxonomyTypeRow({ taxonomy, onRequestDelete }: TaxonomyTypeRowProps) {
	return (
		<tr className="border-b hover:bg-kumo-tint/25">
			<td className="px-4 py-3">
				<Link
					to="/taxonomy-types/$name"
					params={{ name: taxonomy.name }}
					className="font-medium hover:text-kumo-brand"
				>
					{taxonomy.label}
				</Link>
			</td>
			<td className="px-4 py-3">
				<code className="text-sm bg-kumo-tint px-1.5 py-0.5 rounded">{taxonomy.name}</code>
			</td>
			<td className="px-4 py-3">
				<Badge variant="secondary">
					{taxonomy.hierarchical ? "Hierarchical" : "Flat"}
				</Badge>
			</td>
			<td className="px-4 py-3">
				{taxonomy.collections.length > 0 ? (
					<div className="flex flex-wrap gap-1">
						{taxonomy.collections.map((col) => (
							<Badge key={col} variant="secondary">
								{col}
							</Badge>
						))}
					</div>
				) : (
					<span className="text-kumo-subtle text-sm">All collections</span>
				)}
			</td>
			<td className="px-4 py-3 text-right">
				<div className="flex items-center justify-end space-x-1">
					<Link
						to="/taxonomy-types/$name"
						params={{ name: taxonomy.name }}
						aria-label={`Edit ${taxonomy.label}`}
						className={buttonVariants({ variant: "ghost", shape: "square" })}
					>
						<Pencil className="h-4 w-4" aria-hidden="true" />
					</Link>
					<Button
						variant="ghost"
						shape="square"
						aria-label={`Delete ${taxonomy.label}`}
						onClick={() => onRequestDelete?.(taxonomy)}
					>
						<Trash className="h-4 w-4 text-kumo-danger" aria-hidden="true" />
					</Button>
				</div>
			</td>
		</tr>
	);
}
