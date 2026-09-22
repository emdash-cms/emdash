/**
 * Comment moderation inbox.
 *
 * Status tabs (Pending, Approved, Spam, Trash), search, collection filter,
 * table with row actions, bulk selection, and detail slide-over.
 */

import { Badge, Button, Checkbox, Select } from "@cloudflare/kumo";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import {
	Check,
	CheckCircle,
	ClockCountdown,
	ShieldWarning,
	Trash,
	Warning,
} from "@phosphor-icons/react";
import * as React from "react";

import type {
	AdminComment,
	CommentCounts,
	CommentStatus,
	BulkAction,
} from "../../lib/api/comments.js";
import { cn } from "../../lib/utils.js";
import { ADMIN_NAV_ICONS } from "../admin-navigation-icons.js";
import { CaretNext, CaretPrev } from "../ArrowIcons.js";
import { ConfirmDialog } from "../ConfirmDialog.js";
import { PageHeader } from "../PageHeader.js";
import { TableToolbarSearch } from "../TableToolbar.js";
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
const STATUS_TAB_CLASS_NAME = "flex-1 justify-center text-xs sm:flex-none sm:text-sm";
const STATUS_TAB_ICON_CLASS_NAME = "size-3.5 shrink-0 sm:size-4";
const STATUS_TAB_LABEL_CLASS_NAME = "flex items-center gap-1 sm:gap-1.5";
const STATUS_TAB_RENDER = (
	<button
		type="button"
		style={{ paddingInline: "clamp(0.1875rem, calc(10vw - 1.8125rem), 0.625rem)" }}
	/>
);

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

	const searchPlaceholder = t`Search comments...`;

	return (
		<div className="space-y-6">
			<PageHeader
				title={t`Comments`}
				description={t`Review and moderate comments across your content.`}
				value={activeStatus}
				onValueChange={(v) => {
					if (v === "pending" || v === "approved" || v === "spam" || v === "trash") {
						onStatusChange(v);
					}
				}}
				tools={
					<>
						<TableToolbarSearch
							size="base"
							placeholder={searchPlaceholder}
							aria-label={t`Search comments`}
							value={searchQuery}
							onChange={(e) => onSearchChange(e.target.value)}
						/>
						{Object.keys(collections).length > 1 && (
							<Select
								className="w-full sm:w-auto"
								value={collectionFilter}
								onValueChange={(v) => onCollectionFilterChange(v ?? "")}
								items={collectionItems}
								aria-label={t`Filter by collection`}
							/>
						)}
					</>
				}
				tabs={[
					{
						value: "pending",
						className: STATUS_TAB_CLASS_NAME,
						render: STATUS_TAB_RENDER,
						label: (
							<span className={STATUS_TAB_LABEL_CLASS_NAME}>
								<ClockCountdown
									className={STATUS_TAB_ICON_CLASS_NAME}
									weight={activeStatus === "pending" ? "fill" : "regular"}
									aria-hidden="true"
								/>
								{t`Pending`}
								{counts.pending > 0 && <Badge variant="secondary">{counts.pending}</Badge>}
							</span>
						),
					},
					{
						value: "approved",
						className: STATUS_TAB_CLASS_NAME,
						render: STATUS_TAB_RENDER,
						label: (
							<span className={STATUS_TAB_LABEL_CLASS_NAME}>
								<CheckCircle
									className={STATUS_TAB_ICON_CLASS_NAME}
									weight={activeStatus === "approved" ? "fill" : "regular"}
									aria-hidden="true"
								/>
								{t`Approved`}
							</span>
						),
					},
					{
						value: "spam",
						className: STATUS_TAB_CLASS_NAME,
						render: STATUS_TAB_RENDER,
						label: (
							<span className={STATUS_TAB_LABEL_CLASS_NAME}>
								<ShieldWarning
									className={STATUS_TAB_ICON_CLASS_NAME}
									weight={activeStatus === "spam" ? "fill" : "regular"}
									aria-hidden="true"
								/>
								{t`Spam`}
								{counts.spam > 0 && <Badge variant="secondary">{counts.spam}</Badge>}
							</span>
						),
					},
					{
						value: "trash",
						className: STATUS_TAB_CLASS_NAME,
						render: STATUS_TAB_RENDER,
						label: (
							<span className={STATUS_TAB_LABEL_CLASS_NAME}>
								<Trash
									className={STATUS_TAB_ICON_CLASS_NAME}
									weight={activeStatus === "trash" ? "fill" : "regular"}
									aria-hidden="true"
								/>
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
			{isLoading && comments.length === 0 ? (
				<div className="py-12 text-center text-kumo-subtle">{t`Loading comments...`}</div>
			) : paginatedComments.length === 0 ? (
				<EmptyState status={activeStatus} hasFilters={Boolean(searchQuery || collectionFilter)} />
			) : (
				<div className="overflow-x-auto rounded-lg border bg-kumo-base">
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
							{paginatedComments.map((comment) => (
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
							))}
						</tbody>
					</table>
				</div>
			)}

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
							<Check className="h-4 w-4 text-kumo-success" />
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
							<Warning className="h-4 w-4 text-kumo-warning" />
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

function EmptyState({ status, hasFilters }: { status: CommentStatus; hasFilters: boolean }) {
	const { t } = useLingui();

	const messages: Record<CommentStatus, string> = {
		pending: t`No comments awaiting moderation.`,
		approved: t`No approved comments yet.`,
		spam: t`No spam comments.`,
		trash: t`Trash is empty.`,
	};

	return (
		<div className="py-10 text-center text-kumo-subtle">
			<ADMIN_NAV_ICONS.comments size={40} className="mx-auto mb-3 opacity-30" />
			<p className="text-base font-medium">
				{hasFilters ? t`No comments match your filters.` : messages[status]}
			</p>
			<p className="mt-1 text-sm">
				{hasFilters
					? t`Try a different search or collection filter.`
					: t`Comments with this status will appear here.`}
			</p>
		</div>
	);
}
