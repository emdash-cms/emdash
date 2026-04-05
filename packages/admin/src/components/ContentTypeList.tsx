import { Badge, Button, buttonVariants } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import { Plus, Pencil, Trash, Database, FileText, Warning, Check } from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import * as React from "react";

import type { SchemaCollection, OrphanedTable } from "../lib/api";
import { cn } from "../lib/utils";
import { ConfirmDialog } from "./ConfirmDialog";

export interface ContentTypeListProps {
	collections: SchemaCollection[];
	orphanedTables?: OrphanedTable[];
	isLoading?: boolean;
	onDelete?: (slug: string) => void;
	onRegisterOrphan?: (slug: string) => void;
}

/**
 * Content Type list view - shows all collections in the schema registry
 */
export function ContentTypeList({
	collections,
	orphanedTables,
	isLoading,
	onDelete,
	onRegisterOrphan,
}: ContentTypeListProps) {
	const { t } = useLingui();
	const [deleteTarget, setDeleteTarget] = React.useState<SchemaCollection | null>(null);
	const hasOrphans = orphanedTables && orphanedTables.length > 0;

	return (
		<div className="space-y-4">
			{/* Header */}
			<div className="flex items-center justify-between">
				<div>
					<h1 className="text-2xl font-bold">{t`Content Types`}</h1>
					<p className="text-kumo-subtle text-sm">{t`Define the structure of your content`}</p>
				</div>
				<Link to="/content-types/new" className={buttonVariants()}>
					<Plus className="mr-2 h-4 w-4" aria-hidden="true" />
					{t`New Content Type`}
				</Link>
			</div>

			{/* Orphaned Tables Warning */}
			{hasOrphans && (
				<div className="rounded-md border border-amber-200 bg-amber-50 dark:border-amber-900 dark:bg-amber-950 p-4">
					<div className="flex items-start gap-3">
						<Warning className="h-5 w-5 text-amber-600 dark:text-amber-400 mt-0.5" />
						<div className="flex-1">
							<h3 className="font-medium text-amber-800 dark:text-amber-200">
								{t`Unregistered Content Tables Found`}
							</h3>
							<p className="text-sm text-amber-700 dark:text-amber-300 mt-1">
								{t`The following tables contain content but aren't registered as collections. Register them to manage this content in the admin.`}
							</p>
							<div className="mt-3 space-y-2">
								{orphanedTables.map((orphan) => (
									<div
										key={orphan.slug}
										className="flex items-center justify-between bg-white dark:bg-amber-900/50 rounded-md px-3 py-2"
									>
										<div>
											<code className="text-sm font-medium">{orphan.slug}</code>
											<span className="text-xs text-kumo-subtle ml-2">
												({orphan.rowCount} items)
											</span>
										</div>
										<Button
											size="sm"
											variant="outline"
											icon={<Check />}
											onClick={() => onRegisterOrphan?.(orphan.slug)}
										>
											{t`Register`}
										</Button>
									</div>
								))}
							</div>
						</div>
					</div>
				</div>
			)}

			{/* Table */}
			<div className="rounded-md border overflow-x-auto">
				<table className="w-full">
					<thead>
						<tr className="border-b bg-kumo-tint/50">
							<th scope="col" className="px-4 py-3 text-left text-sm font-medium">
								{t`Name`}
							</th>
							<th scope="col" className="px-4 py-3 text-left text-sm font-medium">
								{t`Slug`}
							</th>
							<th scope="col" className="px-4 py-3 text-left text-sm font-medium">
								{t`Source`}
							</th>
							<th scope="col" className="px-4 py-3 text-left text-sm font-medium">
								{t`Features`}
							</th>
							<th scope="col" className="px-4 py-3 text-right text-sm font-medium">
								{t`Actions`}
							</th>
						</tr>
					</thead>
					<tbody>
						{isLoading ? (
							<tr>
								<td colSpan={5} className="px-4 py-8 text-center text-kumo-subtle">
									{t`Loading collections...`}
								</td>
							</tr>
						) : collections.length === 0 && !hasOrphans ? (
							<tr>
								<td colSpan={5} className="px-4 py-8 text-center text-kumo-subtle">
									{t`No content types yet.`}{" "}
									<Link to="/content-types/new" className="text-kumo-brand underline">
										{t`Create your first one`}
									</Link>
								</td>
							</tr>
						) : (
							collections.map((collection) => (
								<ContentTypeRow
									key={collection.id}
									collection={collection}
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
				title={t`Delete Content Type?`}
				description={
					deleteTarget
						? t`Are you sure you want to delete "${deleteTarget.label}"? This will also delete all content in this collection.`
						: ""
				}
				confirmLabel={t`Delete`}
				pendingLabel={t`Deleting...`}
				isPending={false}
				error={null}
				onConfirm={() => {
					if (deleteTarget) {
						onDelete?.(deleteTarget.slug);
						setDeleteTarget(null);
					}
				}}
			/>
		</div>
	);
}

interface ContentTypeRowProps {
	collection: SchemaCollection;
	onRequestDelete?: (collection: SchemaCollection) => void;
}

function ContentTypeRow({ collection, onRequestDelete }: ContentTypeRowProps) {
	const { t } = useLingui();
	const isFromCode = collection.source === "code";

	return (
		<tr className="border-b hover:bg-kumo-tint/25">
			<td className="px-4 py-3">
				<div className="flex items-center space-x-3">
					<div
						className={cn(
							"flex h-8 w-8 items-center justify-center rounded-lg",
							isFromCode
								? "bg-purple-100 text-purple-600 dark:bg-purple-900 dark:text-purple-300"
								: "bg-blue-100 text-blue-600 dark:bg-blue-900 dark:text-blue-300",
						)}
					>
						{isFromCode ? <FileText className="h-4 w-4" /> : <Database className="h-4 w-4" />}
					</div>
					<div>
						<Link
							to="/content-types/$slug"
							params={{ slug: collection.slug }}
							className="font-medium hover:text-kumo-brand"
						>
							{collection.label}
						</Link>
						{collection.description && (
							<p className="text-xs text-kumo-subtle">{collection.description}</p>
						)}
					</div>
				</div>
			</td>
			<td className="px-4 py-3">
				<code className="text-sm bg-kumo-tint px-1.5 py-0.5 rounded">{collection.slug}</code>
			</td>
			<td className="px-4 py-3">
				<SourceBadge source={collection.source} />
			</td>
			<td className="px-4 py-3">
				<div className="flex flex-wrap gap-1">
					{collection.supports.map((feature) => (
						<Badge key={feature} variant="secondary">
							{feature}
						</Badge>
					))}
				</div>
			</td>
			<td className="px-4 py-3 text-right">
				<div className="flex items-center justify-end space-x-1">
					<Link
						to="/content-types/$slug"
						params={{ slug: collection.slug }}
						aria-label={t`Edit ${collection.label}`}
						className={buttonVariants({ variant: "ghost", shape: "square" })}
					>
						<Pencil className="h-4 w-4" aria-hidden="true" />
					</Link>
					{!isFromCode && (
						<Button
							variant="ghost"
							shape="square"
							aria-label={t`Delete ${collection.label}`}
							onClick={() => onRequestDelete?.(collection)}
						>
							<Trash className="h-4 w-4 text-kumo-danger" aria-hidden="true" />
						</Button>
					)}
				</div>
			</td>
		</tr>
	);
}

function SourceBadge({ source }: { source?: string }) {
	const { t } = useLingui();
	if (source === "code") {
		return <Badge variant="secondary">{t`Code`}</Badge>;
	}
	return <Badge variant="secondary">{t`Dashboard`}</Badge>;
}
