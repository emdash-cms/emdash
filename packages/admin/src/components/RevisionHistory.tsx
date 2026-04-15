import { Badge, Button, Loader, Toast } from "@cloudflare/kumo";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import {
	ClockCounterClockwise,
	ArrowCounterClockwise,
	CaretDown,
	CaretUp,
	Plus,
	Minus,
	PencilSimple,
} from "@phosphor-icons/react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import * as React from "react";

import { fetchRevisions, restoreRevision, type Revision } from "../lib/api";
import { formatRelativeTime } from "../lib/utils";
import { ConfirmDialog } from "./ConfirmDialog";

// =============================================================================
// Diff utilities
// =============================================================================

type DiffKind = "added" | "removed" | "changed" | "unchanged";

interface FieldDiff {
	field: string;
	kind: DiffKind;
	oldValue?: unknown;
	newValue?: unknown;
}

/**
 * Compute field-level diff between two revision data snapshots.
 * `older` is the revision being viewed, `newer` is the next revision after it.
 */
function computeFieldDiff(
	older: Record<string, unknown>,
	newer: Record<string, unknown>,
): FieldDiff[] {
	const allKeys = new Set([...Object.keys(older), ...Object.keys(newer)]);
	const diffs: FieldDiff[] = [];

	for (const key of allKeys) {
		const inOlder = key in older;
		const inNewer = key in newer;

		if (inOlder && !inNewer) {
			diffs.push({ field: key, kind: "removed", oldValue: older[key] });
		} else if (!inOlder && inNewer) {
			diffs.push({ field: key, kind: "added", newValue: newer[key] });
		} else {
			const oldJson = JSON.stringify(older[key]);
			const newJson = JSON.stringify(newer[key]);
			if (oldJson !== newJson) {
				diffs.push({ field: key, kind: "changed", oldValue: older[key], newValue: newer[key] });
			} else {
				diffs.push({ field: key, kind: "unchanged", oldValue: older[key], newValue: newer[key] });
			}
		}
	}

	// Sort: changes first, then added, removed, unchanged
	const kindOrder: Record<DiffKind, number> = { changed: 0, added: 1, removed: 2, unchanged: 3 };
	diffs.sort((a, b) => kindOrder[a.kind] - kindOrder[b.kind]);

	return diffs;
}

/** Format a value for display in the diff view */
function formatDiffValue(value: unknown): string {
	if (value === null || value === undefined) return "—";
	if (typeof value === "string") return value;
	return JSON.stringify(value, null, 2);
}

interface RevisionHistoryProps {
	collection: string;
	entryId: string;
	/** Called when a revision is successfully restored */
	onRestored?: () => void;
}

/**
 * Format a date as a full timestamp
 */
function formatFullDate(dateString: string): string {
	return new Date(dateString).toLocaleString(undefined, {
		weekday: "short",
		year: "numeric",
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	});
}

/**
 * RevisionHistory component - displays revision history for a content item
 * with ability to restore previous versions.
 */
export function RevisionHistory({ collection, entryId, onRestored }: RevisionHistoryProps) {
	const { t } = useLingui();
	const [isExpanded, setIsExpanded] = React.useState(false);
	const [selectedRevision, setSelectedRevision] = React.useState<Revision | null>(null);
	const [restoreTarget, setRestoreTarget] = React.useState<Revision | null>(null);
	const queryClient = useQueryClient();
	const toastManager = Toast.useToastManager();

	const { data, isLoading, error } = useQuery({
		queryKey: ["revisions", collection, entryId],
		queryFn: () => fetchRevisions(collection, entryId, { limit: 20 }),
		enabled: isExpanded, // Only fetch when expanded
	});

	const restoreMutation = useMutation({
		mutationFn: (revisionId: string) => restoreRevision(revisionId),
		onSuccess: () => {
			// Invalidate content and revisions queries
			void queryClient.invalidateQueries({
				queryKey: ["content", collection, entryId],
			});
			void queryClient.invalidateQueries({
				queryKey: ["revisions", collection, entryId],
			});
			setSelectedRevision(null);
			setRestoreTarget(null);
			onRestored?.();
			toastManager.add({
				title: t`Revision restored`,
				description: t`Content has been updated to the selected revision.`,
			});
		},
		onError: (err: Error) => {
			toastManager.add({
				title: t`Restore failed`,
				description: err.message,
				type: "error",
			});
		},
	});

	const handleRestore = (revision: Revision) => {
		setRestoreTarget(revision);
	};

	const revisions = data?.items ?? [];
	const total = data?.total ?? 0;

	return (
		<>
			<div className="rounded-lg border bg-kumo-base">
				{/* Header - always visible */}
				<button
					type="button"
					onClick={() => setIsExpanded(!isExpanded)}
					className="flex w-full items-center justify-between p-4 text-start hover:bg-kumo-tint/50 transition-colors"
				>
					<div className="flex items-center gap-2">
						<ClockCounterClockwise className="h-4 w-4 text-kumo-subtle" />
						<span className="font-semibold">{t`Revisions`}</span>
						{total > 0 && <span className="text-xs text-kumo-subtle">({total})</span>}
					</div>
					{isExpanded ? (
						<CaretUp className="h-4 w-4 text-kumo-subtle" />
					) : (
						<CaretDown className="h-4 w-4 text-kumo-subtle" />
					)}
				</button>

				{/* Content - shown when expanded */}
				{isExpanded && (
					<div className="border-t px-4 pb-4">
						{isLoading ? (
							<div className="flex items-center justify-center py-6">
								<Loader />
							</div>
						) : error ? (
							<div className="py-4 text-center text-sm text-kumo-danger">
								{t`Failed to load revisions`}
							</div>
						) : revisions.length === 0 ? (
							<div className="py-4 text-center text-sm text-kumo-subtle">{t`No revisions yet`}</div>
						) : (
							<div className="space-y-1 pt-2">
								{revisions.map((revision, index) => (
									<RevisionItem
										key={revision.id}
										revision={revision}
										compareRevision={index > 0 ? revisions[index - 1] : undefined}
										isLatest={index === 0}
										isRestoring={
											restoreMutation.isPending && restoreMutation.variables === revision.id
										}
										onRestore={() => handleRestore(revision)}
										onSelect={() =>
											setSelectedRevision(selectedRevision?.id === revision.id ? null : revision)
										}
										isSelected={selectedRevision?.id === revision.id}
									/>
								))}
							</div>
						)}
					</div>
				)}
			</div>

			<ConfirmDialog
				open={!!restoreTarget}
				onClose={() => {
					setRestoreTarget(null);
					restoreMutation.reset();
				}}
				title={t`Restore Revision?`}
				description={
					restoreTarget
						? t`Restore this version from ${formatFullDate(restoreTarget.createdAt)}? This will update the current content to this revision's data.`
						: ""
				}
				confirmLabel={t`Restore`}
				pendingLabel={t`Restoring...`}
				variant="primary"
				isPending={restoreMutation.isPending}
				error={restoreMutation.error}
				onConfirm={() => {
					if (restoreTarget) restoreMutation.mutate(restoreTarget.id);
				}}
			/>
		</>
	);
}

interface RevisionItemProps {
	revision: Revision;
	/** The next newer revision to compare against (undefined for the latest) */
	compareRevision?: Revision;
	isLatest: boolean;
	isRestoring: boolean;
	isSelected: boolean;
	onRestore: () => void;
	onSelect: () => void;
}

function RevisionItem({
	revision,
	compareRevision,
	isLatest,
	isRestoring,
	isSelected,
	onRestore,
	onSelect,
}: RevisionItemProps) {
	const { t } = useLingui();
	return (
		<div
			className={`rounded-md border p-3 transition-colors ${
				isSelected ? "border-kumo-brand bg-kumo-brand/5" : "hover:bg-kumo-tint/50"
			}`}
		>
			<div className="flex items-start justify-between gap-2">
				<button type="button" onClick={onSelect} className="flex-1 text-start">
					<div className="flex items-center gap-2">
						<span className="text-sm font-medium">{formatRelativeTime(revision.createdAt)}</span>
						{isLatest && <Badge variant="outline">{t`Current`}</Badge>}
					</div>
					<div className="text-xs text-kumo-subtle mt-0.5">
						{formatFullDate(revision.createdAt)}
					</div>
				</button>

				{!isLatest && (
					<Button
						variant="ghost"
						size="sm"
						onClick={(e) => {
							e.stopPropagation();
							onRestore();
						}}
						disabled={isRestoring}
						className="shrink-0"
						title={t`Restore this version`}
						aria-label={t`Restore this version`}
					>
						{isRestoring ? <Loader size="sm" /> : <ArrowCounterClockwise className="h-4 w-4" />}
					</Button>
				)}
			</div>

			{/* Diff view or snapshot - shown when selected */}
			{isSelected && (
				<div className="mt-3 pt-3 border-t">
					{compareRevision ? (
						<RevisionDiffView older={revision.data} newer={compareRevision.data} />
					) : (
						<>
							<div className="text-xs font-medium text-kumo-subtle mb-2">{t`Content snapshot:`}</div>
							<pre className="text-xs bg-kumo-tint p-2 rounded overflow-auto max-h-48">
								{JSON.stringify(revision.data, null, 2)}
							</pre>
						</>
					)}
				</div>
			)}
		</div>
	);
}

// =============================================================================
// Diff view component
// =============================================================================

interface RevisionDiffViewProps {
	older: Record<string, unknown>;
	newer: Record<string, unknown>;
}

function RevisionDiffView({ older, newer }: RevisionDiffViewProps) {
	const { t } = useLingui();
	const [showUnchanged, setShowUnchanged] = React.useState(false);
	const diffs = React.useMemo(() => computeFieldDiff(older, newer), [older, newer]);

	const changedCount = diffs.filter((d) => d.kind !== "unchanged").length;
	const unchangedCount = diffs.length - changedCount;

	if (diffs.length === 0) {
		return (
			<div className="text-xs text-kumo-subtle text-center py-2">{t`No fields to compare`}</div>
		);
	}

	const visibleDiffs = showUnchanged ? diffs : diffs.filter((d) => d.kind !== "unchanged");

	return (
		<div className="space-y-2">
			<div className="flex items-center justify-between">
				<div className="text-xs font-medium text-kumo-subtle">
					{plural(changedCount, {
						one: "# change from next revision",
						other: "# changes from next revision",
					})}
				</div>
				{unchangedCount > 0 && (
					<button
						type="button"
						onClick={() => setShowUnchanged(!showUnchanged)}
						className="text-xs text-kumo-brand hover:underline"
					>
						{showUnchanged
							? plural(unchangedCount, { one: "Hide # unchanged", other: "Hide # unchanged" })
							: plural(unchangedCount, { one: "Show # unchanged", other: "Show # unchanged" })}
					</button>
				)}
			</div>

			<div className="space-y-1.5">
				{visibleDiffs.map((diff) => (
					<DiffFieldRow key={diff.field} diff={diff} />
				))}
			</div>
		</div>
	);
}

const DIFF_STYLES: Record<DiffKind, { bg: string; icon: React.ReactNode; label: string }> = {
	added: {
		bg: "bg-green-50 dark:bg-green-950/30 border-green-200 dark:border-green-800",
		icon: <Plus className="h-3 w-3 text-green-600 dark:text-green-400" aria-hidden="true" />,
		label: "Added",
	},
	removed: {
		bg: "bg-red-50 dark:bg-red-950/30 border-red-200 dark:border-red-800",
		icon: <Minus className="h-3 w-3 text-red-600 dark:text-red-400" aria-hidden="true" />,
		label: "Removed",
	},
	changed: {
		bg: "bg-amber-50 dark:bg-amber-950/30 border-amber-200 dark:border-amber-800",
		icon: (
			<PencilSimple className="h-3 w-3 text-amber-600 dark:text-amber-400" aria-hidden="true" />
		),
		label: "Changed",
	},
	unchanged: {
		bg: "bg-kumo-tint/50 border-kumo-line",
		icon: null,
		label: "Unchanged",
	},
};

function DiffFieldRow({ diff }: { diff: FieldDiff }) {
	const style = DIFF_STYLES[diff.kind];

	return (
		<div className={`rounded border px-3 py-2 text-xs ${style.bg}`}>
			<div className="flex items-center gap-1.5 mb-1">
				{style.icon}
				<span className="font-medium">{diff.field}</span>
			</div>

			{diff.kind === "changed" && (
				<div className="space-y-1 mt-1.5">
					<div className="flex gap-2">
						<span className="text-red-600 dark:text-red-400 shrink-0">−</span>
						<pre className="whitespace-pre-wrap break-all font-mono">
							{formatDiffValue(diff.oldValue)}
						</pre>
					</div>
					<div className="flex gap-2">
						<span className="text-green-600 dark:text-green-400 shrink-0">+</span>
						<pre className="whitespace-pre-wrap break-all font-mono">
							{formatDiffValue(diff.newValue)}
						</pre>
					</div>
				</div>
			)}

			{diff.kind === "added" && (
				<pre className="whitespace-pre-wrap break-all font-mono mt-1">
					{formatDiffValue(diff.newValue)}
				</pre>
			)}

			{diff.kind === "removed" && (
				<pre className="whitespace-pre-wrap break-all font-mono mt-1">
					{formatDiffValue(diff.oldValue)}
				</pre>
			)}

			{diff.kind === "unchanged" && (
				<pre className="whitespace-pre-wrap break-all font-mono mt-1 text-kumo-subtle">
					{formatDiffValue(diff.oldValue)}
				</pre>
			)}
		</div>
	);
}
