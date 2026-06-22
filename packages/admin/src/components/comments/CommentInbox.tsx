/**
 * Comment moderation inbox.
 *
 * Status tabs (Pending, Approved, Spam, Trash), search, collection filter,
 * table with row actions, bulk selection, and detail slide-over.
 */

import { Badge, Button, Checkbox, Input, Select, Tabs } from "@cloudflare/kumo";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { MagnifyingGlass, Check, Trash, Warning, ChatCircle } from "@phosphor-icons/react";
import * as React from "react";

import type {
	AdminComment,
	CommentCounts,
	CommentStatus,
	BulkAction,
} from "../../lib/api/comments.js";
import { cn } from "../../lib/utils.js";
import { CaretNext, CaretPrev } from "../ArrowIcons.js";
import { ConfirmDialog } from "../ConfirmDialog.js";
import { CommentDetail } from "./CommentDetail.js";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface CommentInboxProps {
	comments: AdminComment[];
	counts: CommentCounts;
	isLoading: boolean;
	nextCursor?: string;
	collections: Record<string, { label: string }>;
	activeStatus: CommentStatus;
	onStatusChange: (status: CommentStatus) => void;
	collectionFilter: string;
	onCollectionFilterChange: (collection: string) => void;
	searchQuery: string;
	onSearchChange: (query: string) => void;
	onCommentStatusChange: (id: string, status: CommentStatus) => Promise<unknown>;
	onCommentDelete: (id: string) => Promise<unknown>;
	onBulkAction: (ids: string[], action: BulkAction) => Promise<unknown>;
	onLoadMore: () => void;
	isAdmin: boolean;
	isStatusPending: boolean;
	deleteError: unknown;
	onDeleteErrorReset: () => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

const PAGE_SIZE = 20;

export function CommentInbox({
	comments,
	counts,
	isLoading,
	nextCursor,
	collections,
	activeStatus,
	onStatusChange,
	collectionFilter,
	onCollectionFilterChange,
	searchQuery,
	onSearchChange,
	onCommentStatusChange,
	onCommentDelete,
	onBulkAction,
	onLoadMore,
	isAdmin,
	isStatusPending,
	deleteError,
	onDeleteErrorReset,
}: CommentInboxProps) {
	const { t } = useLingui();

	// Selection state
	const [selected, setSelected] = React.useState<Set<string>>(new Set());
	const [detailComment, setDetailComment] = React.useState<AdminComment | null>(null);
	const [deleteId, setDeleteId] = React.useState<string | null>(null);

	// Pagination (client-side within loaded data)
	const [page, setPage] = React.useState(0);

	// Reset selection and page when status tab or filters change
	React.useEffect(() => {
		setSelected(new Set());
		setPage(0);
	}, [activeStatus, collectionFilter, searchQuery]);

	const clearSelection = React.useCallback(() => setSelected(new Set()), []);

	const totalPages = Math.max(1, Math.ceil(comments.length / PAGE_SIZE));
	const paginatedComments = comments.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

	// Bulk select
	const allOnPageSelected =
		paginatedComments.length > 0 && paginatedComments.every((c) => selected.has(c.id));

	const toggleAll = () => {
		setSelected((prev) => {
			const next = new Set(prev);
			if (allOnPageSelected) {
				for (const c of paginatedComments) next.delete(c.id);
			} else {
				for (const c of paginatedComments) next.add(c.id);
			}
			return next;
		});
	};

	const toggleOne = (id: string) => {
		setSelected((prev) => {
			const next = new Set(prev);
			if (next.has(id)) {
				next.delete(id);
			} else {
				next.add(id);
			}
			return next;
		});
	};

	const handleBulk = (action: BulkAction) => {
		if (selected.size === 0) return;
		void onBulkAction([...selected], action).then(clearSelection);
	};

	// Collection filter items
	const collectionItems: Record<string, string> = { "": t`All collections` };
	for (const [slug, config] of Object.entries(collections)) {
		collectionItems[slug] = config.label;
	}

	const total = counts.pending + counts.approved + counts.spam + counts.trash;

	return (
		<div className="space-y-4">
			{/* Header */}
			<div className="flex items-center justify-between">
				<div className="flex items-center gap-3">
					<ChatCircle className="h-6 w-6" />
					<h1 className="text-2xl font-bold">{t`Comments`}</h1>
					{total > 0 && (
						<span className="text-sm text-kumo-subtle">
							{plural(total, { one: "# total", other: "# total" })}
						</span>
					)}
				</div>
			</div>

			{/* Filters row */}
			<div className="flex items-center gap-3 flex-wrap">
				{/* Search */}
				<div className="relative max-w-xs flex-1 min-w-[200px]">
					<MagnifyingGlass className="absolute start-3 top-1/2 -translate-y-1/2 h-4 w-4 text-kumo-subtle" />
					<Input
						type="search"
						placeholder={t`Search comments...`}
						aria-label={t`Search comments`}
						value={searchQuery}
						onChange={(e) => onSearchChange(e.target.value)}
						className="ps-9"
					/>
				</div>

				{/* Collection filter */}
				{Object.keys(collections).length > 1 && (
					<div className="w-48">
						<Select
							value={collectionFilter}
							onValueChange={(v) => onCollectionFilterChange(v ?? "")}
							items={collectionItems}
							aria-label={t`Filter by collection`}
						/>
					</div>
				)}
			</div>

			{/* Tabs */}
			<Tabs
				variant="underline"
				value={activeStatus}
				onValueChange={(v) => {
					if (v === "pending" || v === "approved" || v === "spam" || v === "trash") {
						onStatusChange(v);
					}
				}}
				tabs={[
					{
						value: "pending",
						label: (
							<span className="flex items-center gap-2">
								{t`Pending`}
								{counts.pending > 0 && <Badge variant="secondary">{counts.pending}</Badge>}
							</span>
						),
					},
					{ value: "approved", label: t`Approved` },
					{
						value: "spam",
						label: (
							<span className="flex items-center gap-2">
								{t`Spam`}
								{counts.spam > 0 && <Badge variant="secondary">{counts.spam}</Badge>}
							</span>
						),
					},
					{
						value: "trash",
						label: (
							<span className="flex items-center gap-2">
								{t`Trash`}
								{counts.trash > 0 && <Badge variant="secondary">{counts.trash}</Badge>}
							</span>
						),
					},
				]}
			/>

			{/* Bulk action bar */}
			{selected.size > 0 && (
				<div className="flex items-center gap-3 rounded-lg border bg-kumo-tint/50 px-4 py-2">
					<span className="text-sm font-medium">
						{plural(selected.size, { one: "# selected", other: "# selected" })}
					</span>
					<div className="flex gap-2 ms-auto">
						{activeStatus !== "approved" && (
							<Button
								size="sm"
								icon={<Check className="h-3.5 w-3.5" />}
								onClick={() => handleBulk("approve")}
							>
								{t`Approve`}
							</Button>
						)}
						{activeStatus !== "spam" && (
							<Button
								size="sm"
								variant="outline"
								icon={<Warning className="h-3.5 w-3.5" />}
								onClick={() => handleBulk("spam")}
							>
								{t`Spam`}
							</Button>
						)}
						{activeStatus !== "trash" && (
							<Button
								size="sm"
								variant="outline"
								icon={<Trash className="h-3.5 w-3.5" />}
								onClick={() => handleBulk("trash")}
							>
								{t`Trash`}
							</Button>
						)}
						{isAdmin && (
							<Button
								size="sm"
								variant="destructive"
								icon={<Trash className="h-3.5 w-3.5" />}
								onClick={() => handleBulk("delete")}
							>
								{t`Delete`}
							</Button>
						)}
					</div>
				</div>
			)}

			{/* Table */}
			<div className="rounded-md border bg-kumo-base overflow-x-auto">
				<table className="w-full">
					<thead>
						<tr className="border-b bg-kumo-tint/50">
							<th scope="col" className="w-10 px-3 py-3">
								<Checkbox
									checked={allOnPageSelected}
									onCheckedChange={toggleAll}
									aria-label={t`Select all`}
								/>
							</th>
							<th scope="col" className="px-4 py-3 text-start text-sm font-medium">
								{t`Author`}
							</th>
							<th scope="col" className="px-4 py-3 text-start text-sm font-medium">
								{t`Comment`}
							</th>
							<th scope="col" className="px-4 py-3 text-start text-sm font-medium">
								{t`Content`}
							</th>
							<th scope="col" className="px-4 py-3 text-start text-sm font-medium">
								{t`Date`}
							</th>
							<th scope="col" className="px-4 py-3 text-end text-sm font-medium">
								{t`Actions`}
							</th>
						</tr>
					</thead>
					<tbody className="divide-y divide-kumo-line">
						{isLoading && comments.length === 0 ? (
							<tr>
								<td colSpan={6} className="px-4 py-8 text-center text-kumo-subtle">
									{t`Loading comments...`}
								</td>
							</tr>
						) : paginatedComments.length === 0 ? (
							<tr>
								<td colSpan={6} className="px-4 py-8 text-center text-kumo-subtle">
									<EmptyState status={activeStatus} hasSearch={!!searchQuery} />
								</td>
							</tr>
						) : (
							paginatedComments.map((comment) => (
								<CommentRow
									key={comment.id}
									comment={comment}
									isSelected={selected.has(comment.id)}
									onToggle={() => toggleOne(comment.id)}
									onRowClick={() => setDetailComment(comment)}
									onStatusChange={(id, status) => {
										void onCommentStatusChange(id, status).then(clearSelection);
									}}
									onDelete={(id) => {
										setDeleteId(id);
										onDeleteErrorReset();
									}}
									isAdmin={isAdmin}
									isStatusPending={isStatusPending}
								/>
							))
						)}
					</tbody>
				</table>
			</div>

			{/* Pagination */}
			{(totalPages > 1 || nextCursor) && (
				<div className="flex items-center justify-between">
					<span className="text-sm text-kumo-subtle">
						{plural(comments.length, { one: "# comment", other: "# comments" })}
					</span>
					<div className="flex items-center gap-2">
						<Button
							variant="outline"
							shape="square"
							disabled={page === 0}
							onClick={() => setPage(page - 1)}
							aria-label={t`Previous page`}
						>
							<CaretPrev className="h-4 w-4" />
						</Button>
						<span className="text-sm">
							{page + 1} / {totalPages}
						</span>
						<Button
							variant="outline"
							shape="square"
							disabled={page >= totalPages - 1 && !nextCursor}
							onClick={() => {
								if (page >= totalPages - 1 && nextCursor) {
									onLoadMore();
									setPage(page + 1);
								} else {
									setPage(page + 1);
								}
							}}
							aria-label={t`Next page`}
						>
							<CaretNext className="h-4 w-4" />
						</Button>
					</div>
				</div>
			)}

			{/* Detail slide-over */}
			{detailComment && (
				<CommentDetail
					comment={detailComment}
					onClose={() => setDetailComment(null)}
					onStatusChange={(id, status) => {
						void onCommentStatusChange(id, status).then(clearSelection);
						setDetailComment(null);
					}}
					onDelete={(id) => {
						setDeleteId(id);
						onDeleteErrorReset();
						setDetailComment(null);
					}}
					isAdmin={isAdmin}
					isStatusPending={isStatusPending}
				/>
			)}

			{/* Delete confirmation */}
			<ConfirmDialog
				open={!!deleteId}
				onClose={() => {
					setDeleteId(null);
					onDeleteErrorReset();
				}}
				title={t`Delete Comment?`}
				description={t`This will permanently delete this comment. This action cannot be undone.`}
				confirmLabel={t`Delete`}
				pendingLabel={t`Deleting...`}
				isPending={isStatusPending}
				error={deleteError}
				onConfirm={() => {
					if (deleteId) {
						void onCommentDelete(deleteId).then(() => setDeleteId(null));
					}
				}}
			/>
		</div>
	);
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

interface CommentRowProps {
	comment: AdminComment;
	isSelected: boolean;
	onToggle: () => void;
	onRowClick: () => void;
	onStatusChange: (id: string, status: CommentStatus) => void;
	onDelete: (id: string) => void;
	isAdmin: boolean;
	isStatusPending: boolean;
}

function CommentRow({
	comment,
	isSelected,
	onToggle,
	onRowClick,
	onStatusChange,
	onDelete,
	isAdmin,
	isStatusPending,
}: CommentRowProps) {
	const { t } = useLingui();
	const date = new Date(comment.createdAt);
	const excerpt = comment.body.length > 120 ? comment.body.slice(0, 120) + "..." : comment.body;

	return (
		<tr className={cn("hover:bg-kumo-tint/25", isSelected && "bg-kumo-tint/40")}>
			<td className="w-10 px-3 py-3">
				<Checkbox
					checked={isSelected}
					onCheckedChange={onToggle}
					aria-label={t`Select comment by ${comment.authorName}`}
				/>
			</td>
			<td className="px-4 py-3">
				<button type="button" onClick={onRowClick} className="text-start">
					<div className="font-medium text-sm">{comment.authorName}</div>
					<div className="text-xs text-kumo-subtle">{comment.authorEmail}</div>
				</button>
			</td>
			<td className="px-4 py-3 max-w-xs">
				<button
					type="button"
					onClick={onRowClick}
					className="text-start text-sm text-kumo-subtle hover:text-kumo-default line-clamp-2"
				>
					{excerpt}
				</button>
			</td>
			<td className="px-4 py-3">
				<div className="text-xs">
					<span className="font-medium">{comment.collection}</span>
				</div>
			</td>
			<td className="px-4 py-3 text-sm text-kumo-subtle whitespace-nowrap">
				{date.toLocaleDateString()}
			</td>
			<td className="px-4 py-3 text-end">
				<div className="flex items-center justify-end gap-1">
					{comment.status !== "approved" && (
						<Button
							variant="ghost"
							shape="square"
							size="sm"
							aria-label={t`Approve`}
							onClick={() => onStatusChange(comment.id, "approved")}
							disabled={isStatusPending}
						>
							<Check className="h-4 w-4 text-green-600" />
						</Button>
					)}
					{comment.status !== "spam" && (
						<Button
							variant="ghost"
							shape="square"
							size="sm"
							aria-label={t`Mark as spam`}
							onClick={() => onStatusChange(comment.id, "spam")}
							disabled={isStatusPending}
						>
							<Warning className="h-4 w-4 text-orange-500" />
						</Button>
					)}
					{comment.status !== "trash" && (
						<Button
							variant="ghost"
							shape="square"
							size="sm"
							aria-label={t`Trash`}
							onClick={() => onStatusChange(comment.id, "trash")}
							disabled={isStatusPending}
						>
							<Trash className="h-4 w-4 text-kumo-subtle" />
						</Button>
					)}
					{isAdmin && (
						<Button
							variant="ghost"
							shape="square"
							size="sm"
							aria-label={t`Delete permanently`}
							onClick={() => onDelete(comment.id)}
							disabled={isStatusPending}
						>
							<Trash className="h-4 w-4 text-kumo-danger" />
						</Button>
					)}
				</div>
			</td>
		</tr>
	);
}

function EmptyState({ status, hasSearch }: { status: CommentStatus; hasSearch: boolean }) {
	const { t } = useLingui();

	if (hasSearch) {
		return <p>{t`No comments match your search.`}</p>;
	}

	const messages: Record<CommentStatus, string> = {
		pending: t`No comments awaiting moderation.`,
		approved: t`No approved comments yet.`,
		spam: t`No spam comments.`,
		trash: t`Trash is empty.`,
	};

	return <p>{messages[status]}</p>;
}
