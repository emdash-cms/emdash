import { Badge, Button } from "@cloudflare/kumo";
import {
	DndContext,
	KeyboardSensor,
	PointerSensor,
	closestCenter,
	useSensor,
	useSensors,
} from "@dnd-kit/core";
import type { DragEndEvent } from "@dnd-kit/core";
import {
	SortableContext,
	sortableKeyboardCoordinates,
	useSortable,
	verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import {
	Plus,
	Pencil,
	Trash,
	Database,
	FileText,
	Warning,
	Check,
	DotsSixVertical,
} from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import * as React from "react";

import type { SchemaCollection, OrphanedTable } from "../lib/api";
import { cn } from "../lib/utils";
import { ConfirmDialog } from "./ConfirmDialog";
import { RouterLinkButton } from "./RouterLinkButton.js";

/**
 * Apply a drag-and-drop move to the collection order. Returns the input array
 * unchanged when the move is a no-op.
 */
export function moveCollection(slugs: string[], activeSlug: string, overSlug: string): string[] {
	const from = slugs.indexOf(activeSlug);
	const to = slugs.indexOf(overSlug);
	if (from === -1 || to === -1 || from === to) return slugs;

	const next = [...slugs];
	next.splice(to, 0, next.splice(from, 1)[0]!);
	return next;
}

export interface ContentTypeListProps {
	collections: SchemaCollection[];
	orphanedTables?: OrphanedTable[];
	isLoading?: boolean;
	onDelete?: (slug: string) => void;
	onRegisterOrphan?: (slug: string) => void;
	/** Persist a new sidebar order. Omit to render the list without reordering. */
	onReorder?: (slugs: string[]) => void;
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
	onReorder,
}: ContentTypeListProps) {
	const { t } = useLingui();
	const [deleteTarget, setDeleteTarget] = React.useState<SchemaCollection | null>(null);
	const hasOrphans = orphanedTables && orphanedTables.length > 0;

	// Optimistic order: the drop lands immediately, the server order takes
	// over once the mutation invalidates the query.
	const [order, setOrder] = React.useState<string[] | null>(null);
	const serverOrder = React.useMemo(() => collections.map((c) => c.slug), [collections]);
	const orderedSlugs = order ?? serverOrder;
	React.useEffect(() => {
		setOrder(null);
	}, [serverOrder]);

	const orderedCollections = React.useMemo(() => {
		const bySlug = new Map(collections.map((c) => [c.slug, c]));
		return orderedSlugs.map((slug) => bySlug.get(slug)).filter((c) => c !== undefined);
	}, [collections, orderedSlugs]);

	const canReorder = !!onReorder && collections.length > 1;

	const sensors = useSensors(
		useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
		useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
	);

	const columnCount = canReorder ? 6 : 5;

	const handleDragEnd = (event: DragEndEvent) => {
		const { active, over } = event;
		if (!over || active.id === over.id) return;

		const next = moveCollection(orderedSlugs, String(active.id), String(over.id));
		if (next === orderedSlugs) return;

		setOrder(next);
		onReorder?.(next);
	};

	return (
		<div className="space-y-4">
			{/* Header */}
			<div className="flex items-center justify-between">
				<div>
					<h1 className="text-2xl font-semibold leading-tight">{t`Content Types`}</h1>
					<p className="mt-1 text-sm leading-5 text-pretty text-kumo-subtle">
						{t`Define the structure of your content`}
					</p>
				</div>
				<RouterLinkButton to="/content-types/new" icon={<Plus />}>
					{t`New Content Type`}
				</RouterLinkButton>
			</div>

			{/* Orphaned Tables Warning */}
			{hasOrphans && (
				<div className="rounded-md border border-kumo-warning/50 bg-kumo-warning-tint p-4">
					<div className="flex items-start gap-3">
						<Warning className="h-5 w-5 text-kumo-warning mt-0.5" />
						<div className="flex-1">
							<h3 className="font-medium text-kumo-warning">
								{t`Unregistered Content Tables Found`}
							</h3>
							<p className="text-sm text-kumo-subtle mt-1">
								{t`The following tables contain content but aren't registered as collections. Register them to manage this content in the admin.`}
							</p>
							<div className="mt-3 space-y-2">
								{orphanedTables.map((orphan) => (
									<div
										key={orphan.slug}
										className="flex items-center justify-between bg-kumo-base rounded-md px-3 py-2"
									>
										<div>
											<code className="text-sm font-medium">{orphan.slug}</code>
											<span className="text-xs text-kumo-subtle ms-2">
												{plural(orphan.rowCount, { one: "(# item)", other: "(# items)" })}
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
			<DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
				<div className="rounded-md border bg-kumo-base overflow-x-auto">
					<table className="w-full">
						<thead>
							<tr className="border-b bg-kumo-tint/50">
								{canReorder && (
									<th scope="col" className="w-10 px-2 py-3">
										<span className="sr-only">{t`Reorder`}</span>
									</th>
								)}
								<th scope="col" className="px-4 py-3 text-start text-sm font-medium">
									{t`Name`}
								</th>
								<th scope="col" className="px-4 py-3 text-start text-sm font-medium">
									{t`Slug`}
								</th>
								<th scope="col" className="px-4 py-3 text-start text-sm font-medium">
									{t`Source`}
								</th>
								<th scope="col" className="px-4 py-3 text-start text-sm font-medium">
									{t`Features`}
								</th>
								<th scope="col" className="px-4 py-3 text-end text-sm font-medium">
									{t`Actions`}
								</th>
							</tr>
						</thead>
						<tbody className="divide-y divide-kumo-line">
							{isLoading ? (
								<tr>
									<td colSpan={columnCount} className="px-4 py-8 text-center text-kumo-subtle">
										{t`Loading collections...`}
									</td>
								</tr>
							) : collections.length === 0 && !hasOrphans ? (
								<tr>
									<td colSpan={columnCount} className="px-4 py-8 text-center text-kumo-subtle">
										{t`No content types yet.`}{" "}
										<Link to="/content-types/new" className="text-kumo-link underline">
											{t`Create your first one`}
										</Link>
									</td>
								</tr>
							) : (
								<SortableContext items={orderedSlugs} strategy={verticalListSortingStrategy}>
									{orderedCollections.map((collection) => (
										<ContentTypeRow
											key={collection.id}
											collection={collection}
											canReorder={canReorder}
											onRequestDelete={setDeleteTarget}
										/>
									))}
								</SortableContext>
							)}
						</tbody>
					</table>
				</div>
			</DndContext>

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
	canReorder?: boolean;
	onRequestDelete?: (collection: SchemaCollection) => void;
}

function ContentTypeRow({ collection, canReorder, onRequestDelete }: ContentTypeRowProps) {
	const { t } = useLingui();
	const isFromCode = collection.source === "code";
	const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
		id: collection.slug,
	});

	const style = {
		transform: CSS.Transform.toString(transform),
		transition,
	};

	return (
		<tr
			ref={setNodeRef}
			style={style}
			className={cn("hover:bg-kumo-tint/25", isDragging && "relative z-10 bg-kumo-base shadow-sm")}
		>
			{canReorder && (
				<td className="w-10 px-2 py-3">
					<button
						type="button"
						{...attributes}
						{...listeners}
						aria-label={t`Reorder ${collection.label}`}
						className="flex h-8 w-8 cursor-grab items-center justify-center rounded-md text-kumo-subtle hover:bg-kumo-tint focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-kumo-focus active:cursor-grabbing"
					>
						<DotsSixVertical className="h-4 w-4" aria-hidden="true" />
					</button>
				</td>
			)}
			<td className="px-4 py-3">
				<div className="flex items-center space-x-3">
					<div
						className={cn(
							"flex h-8 w-8 items-center justify-center rounded-lg",
							isFromCode ? "bg-kumo-badge-purple text-white" : "bg-kumo-badge-blue text-white",
						)}
					>
						{isFromCode ? <FileText className="h-4 w-4" /> : <Database className="h-4 w-4" />}
					</div>
					<div>
						<Link
							to="/content-types/$slug"
							params={{ slug: collection.slug }}
							className="font-medium hover:text-kumo-link"
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
			<td className="px-4 py-3 text-end">
				<div className="flex items-center justify-end space-x-1">
					<RouterLinkButton
						to="/content-types/$slug"
						params={{ slug: collection.slug }}
						aria-label={t`Edit ${collection.label}`}
						variant="ghost"
						shape="square"
						icon={<Pencil />}
					/>
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
