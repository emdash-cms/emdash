/**
 * Comment moderation inbox.
 *
 * Status tabs (Pending, Approved, Spam, Trash), search, collection filter,
 * table with row actions, bulk selection, and detail slide-over.
 */

import { Badge, Button, Checkbox, DropdownMenu, Select } from "@cloudflare/kumo";
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
import { formatDate } from "../../lib/utils.js";
import { ADMIN_NAV_ICONS } from "../admin-navigation-icons.js";
import { CaretNext, CaretPrev } from "../ArrowIcons.js";
import { ConfirmDialog } from "../ConfirmDialog.js";
import {
	DataTable,
	DataTableBulkBar,
	DataTableMessage,
	RowActionsMenu,
	RowMeta,
	RowTitleButton,
	cellCodeClassName,
	tertiaryColumn,
} from "../DataTable.js";
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
	const [bulkDeleteOpen, setBulkDeleteOpen] = React.useState(false);
	// The comments the dialog asks to delete. Not read from the selection, which
	// clears while the dialog is still on screen.
	const [bulkDeleteIds, setBulkDeleteIds] = React.useState<string[]>([]);
	// Set only while a bulk action runs. `isStatusPending` also covers a single row's
	// action, which isn't working on the selection.
	const [bulkRunning, setBulkRunning] = React.useState(false);

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
	const showLoading = isLoading && comments.length === 0;

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

	const runBulk = (ids: string[], action: BulkAction) => {
		setBulkRunning(true);
		return onBulkAction(ids, action)
			.then(clearSelection)
			.finally(() => setBulkRunning(false));
	};

	const handleBulk = (action: BulkAction) => {
		if (selected.size === 0) return;
		void runBulk([...selected], action);
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
				<DataTableBulkBar selectedCount={selected.size} busy={bulkRunning} onClear={clearSelection}>
					{activeStatus !== "approved" && (
						<Button
							size="sm"
							variant="secondary"
							icon={<Check aria-hidden="true" />}
							disabled={isStatusPending}
							onClick={() => handleBulk("approve")}
						>
							{t`Approve`}
						</Button>
					)}
					{activeStatus !== "spam" && (
						<Button
							size="sm"
							variant="secondary"
							icon={<Warning aria-hidden="true" />}
							disabled={isStatusPending}
							onClick={() => handleBulk("spam")}
						>
							{t`Spam`}
						</Button>
					)}
					{activeStatus !== "trash" && (
						<Button
							size="sm"
							variant="secondary"
							icon={<Trash aria-hidden="true" />}
							disabled={isStatusPending}
							onClick={() => handleBulk("trash")}
						>
							{t`Trash`}
						</Button>
					)}
					{isAdmin && (
						<Button
							size="sm"
							variant="destructive"
							icon={<Trash aria-hidden="true" />}
							disabled={isStatusPending}
							onClick={() => {
								setBulkDeleteIds([...selected]);
								setBulkDeleteOpen(true);
							}}
						>
							{t`Delete`}
						</Button>
					)}
				</DataTableBulkBar>
			)}

			{/* Table */}
			{!showLoading && paginatedComments.length === 0 ? (
				<EmptyState status={activeStatus} hasFilters={Boolean(searchQuery || collectionFilter)} />
			) : (
				<DataTable>
					<thead>
						<tr>
							<th scope="col" className="w-10">
								<Checkbox
									checked={allOnPageSelected}
									onCheckedChange={toggleAll}
									aria-label={t`Select all on this page`}
								/>
							</th>
							<th scope="col">{t`Comment`}</th>
							<th scope="col" {...tertiaryColumn}>
								{t`Content`}
							</th>
							<th scope="col" {...tertiaryColumn}>
								{t`Date`}
							</th>
							<th scope="col" className="w-0">
								<span className="sr-only">{t`Actions`}</span>
							</th>
						</tr>
					</thead>
					<tbody>
						{showLoading ? (
							<DataTableMessage colSpan={5}>{t`Loading comments...`}</DataTableMessage>
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
				</DataTable>
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

			<ConfirmDialog
				open={bulkDeleteOpen}
				onClose={() => setBulkDeleteOpen(false)}
				title={t`Delete Permanently?`}
				description={plural(bulkDeleteIds.length, {
					one: "Permanently delete # comment? This cannot be undone.",
					other: "Permanently delete # comments? This cannot be undone.",
				})}
				confirmLabel={t`Delete`}
				pendingLabel={t`Deleting...`}
				isPending={isStatusPending}
				preventCloseWhilePending
				error={null}
				onConfirm={() => {
					void runBulk(bulkDeleteIds, "delete").then(() => setBulkDeleteOpen(false));
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
	const { t, i18n } = useLingui();
	const author = comment.authorName;
	const excerpt = comment.body.length > 120 ? comment.body.slice(0, 120) + "..." : comment.body;
	const formattedDate = <bdi>{formatDate(new Date(comment.createdAt), i18n.locale)}</bdi>;
	const collection = <span className={cellCodeClassName}>{comment.collection}</span>;

	return (
		<tr data-selected={isSelected || undefined}>
			<td>
				<Checkbox
					checked={isSelected}
					onCheckedChange={onToggle}
					aria-label={t`Select comment by ${comment.authorName}`}
				/>
			</td>
			<td>
				<div className="flex flex-wrap items-baseline gap-x-2">
					<RowTitleButton dir="auto" className="wrap-anywhere" onClick={onRowClick}>
						{author}
					</RowTitleButton>
					<span className="text-sm text-kumo-subtle wrap-anywhere @max-md:hidden">
						<bdi dir="ltr">{comment.authorEmail}</bdi>
					</span>
				</div>
				<button
					type="button"
					dir="auto"
					onClick={onRowClick}
					className="mt-0.5 line-clamp-2 cursor-pointer text-start text-kumo-subtle wrap-anywhere hover:text-kumo-default"
				>
					{excerpt}
				</button>
				<RowMeta priority="tertiary">
					{collection}
					{formattedDate}
				</RowMeta>
			</td>
			<td {...tertiaryColumn}>{collection}</td>
			<td className="whitespace-nowrap text-kumo-subtle" {...tertiaryColumn}>
				{formattedDate}
			</td>
			<td>
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
							<Check className="h-4 w-4 text-kumo-success" aria-hidden="true" />
						</Button>
					)}
					<RowActionsMenu label={t`Actions for comment by ${author}`}>
						{comment.status !== "spam" && (
							<DropdownMenu.Item
								icon={<Warning className="me-2 size-4" aria-hidden="true" />}
								disabled={isStatusPending}
								onClick={() => onStatusChange(comment.id, "spam")}
							>
								{t`Mark as spam`}
							</DropdownMenu.Item>
						)}
						{comment.status !== "trash" && (
							<DropdownMenu.Item
								icon={<Trash className="me-2 size-4" aria-hidden="true" />}
								disabled={isStatusPending}
								onClick={() => onStatusChange(comment.id, "trash")}
							>
								{t`Trash`}
							</DropdownMenu.Item>
						)}
						{isAdmin && (
							<>
								<DropdownMenu.Separator />
								<DropdownMenu.Item
									variant="danger"
									icon={<Trash className="me-2 size-4" aria-hidden="true" />}
									disabled={isStatusPending}
									onClick={() => onDelete(comment.id)}
								>
									{t`Delete permanently`}
								</DropdownMenu.Item>
							</>
						)}
					</RowActionsMenu>
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
