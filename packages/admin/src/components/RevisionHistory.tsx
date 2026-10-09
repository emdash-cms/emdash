import { Badge, Button, Collapsible, Loader, Text, Toast } from "@cloudflare/kumo";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { ArrowCounterClockwise, CaretDown, Plus, Minus, PencilSimple } from "@phosphor-icons/react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import * as React from "react";

import {
	fetchRevision,
	fetchRevisions,
	restoreRevision,
	type ContentItem,
	type Revision,
	type UserListItem,
} from "../lib/api";
import {
	diffPortableText,
	diffWords,
	isPortableText,
	type WordSegment,
} from "../lib/revision-diff";
import { cn, formatRelativeTime, parseTimestamp } from "../lib/utils";
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
 * `older` is the revision compared against (the one before, or the live one), `newer` is the revision being viewed.
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
	/** Called when a revision is successfully restored with the returned item. */
	onRestored?: (item: ContentItem) => void;
	/** Reserve the inline end of the disclosure header for an external control. */
	reserveHeaderEnd?: boolean;
	/** The entry's live revision, offered as a second point of comparison and badged "Live". */
	liveRevisionId?: string | null;
	/** Field labels by slug, so a diff names the field the way the editor does. */
	fieldLabels?: Record<string, string>;
	/** Users, to name who saved each revision. */
	users?: UserListItem[];
}

/**
 * Format a date as a full timestamp
 */
function formatFullDate(dateString: string): string {
	return parseTimestamp(dateString).toLocaleString(undefined, {
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
export function RevisionHistory({
	collection,
	entryId,
	onRestored,
	reserveHeaderEnd = false,
	liveRevisionId,
	fieldLabels,
	users,
}: RevisionHistoryProps) {
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
		onSuccess: (restoredItem) => {
			// Invalidate content and revisions queries
			void queryClient.invalidateQueries({
				queryKey: ["content", collection, entryId],
			});
			void queryClient.invalidateQueries({
				queryKey: ["revisions", collection, entryId],
			});
			setSelectedRevision(null);
			setRestoreTarget(null);
			onRestored?.(restoredItem);
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
	const liveLoaded = liveRevisionId ? revisions.find((r) => r.id === liveRevisionId) : undefined;
	// The live revision can be older than the loaded page; fetch it on its own so "Compared with live" still works.
	const { data: liveFetched } = useQuery({
		queryKey: ["revision", liveRevisionId],
		queryFn: () => fetchRevision(liveRevisionId!),
		enabled: isExpanded && !!liveRevisionId && !!data && !liveLoaded,
	});
	const liveRevision = liveLoaded ?? liveFetched;
	const authorName = (id: string | null) => {
		const user = id ? users?.find((u) => u.id === id) : undefined;
		return user ? user.name || user.email : undefined;
	};

	return (
		<>
			<Collapsible.Root open={isExpanded} onOpenChange={setIsExpanded}>
				{/* Header - always visible */}
				<Collapsible.Trigger
					render={
						<Button
							type="button"
							variant="ghost"
							className="relative justify-between"
							style={{
								width: reserveHeaderEnd ? "calc(100% - 1.5rem)" : "calc(100% + 1.5rem)",
								insetInlineStart: "-0.75rem",
							}}
						/>
					}
				>
					<span className="flex items-center gap-1.5">
						<Text as="span" DANGEROUS_className="font-semibold">
							{t`Revisions`}
						</Text>
						{total > 0 && (
							<span className="text-xs font-normal leading-4 text-kumo-subtle">({total})</span>
						)}
					</span>
					<CaretDown
						className={cn(
							"h-4 w-4 text-kumo-subtle transition-transform duration-150 ease-out motion-reduce:transition-none",
							isExpanded && "rotate-180",
						)}
					/>
				</Collapsible.Trigger>

				{/* Content - shown when expanded */}
				<Collapsible.Panel
					className="overflow-hidden duration-150 ease-out [&[hidden]:not([hidden='until-found'])]:hidden motion-reduce:transition-none"
					style={({ transitionStatus }) => ({
						height:
							transitionStatus === "starting" || transitionStatus === "ending"
								? 0
								: "var(--collapsible-panel-height)",
						transitionProperty: "height",
					})}
				>
					<div>
						{isLoading ? (
							<div className="flex items-center justify-center py-6">
								<Loader />
							</div>
						) : error ? (
							<div className="py-4 text-center text-xs leading-4 text-kumo-danger">
								{t`Failed to load revisions`}
							</div>
						) : revisions.length === 0 ? (
							<div className="py-4 text-center text-xs leading-4 text-kumo-subtle">
								{t`No revisions yet`}
							</div>
						) : (
							<div className="space-y-1 pt-2">
								{revisions.map((revision, index) => (
									<RevisionItem
										key={revision.id}
										revision={revision}
										compareRevision={revisions[index + 1]}
										liveRevision={liveRevision}
										authorName={authorName(revision.authorId)}
										fieldLabels={fieldLabels}
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
				</Collapsible.Panel>
			</Collapsible.Root>

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
	/** The revision saved before this one, to compare against (undefined for the oldest loaded) */
	compareRevision?: Revision;
	/** The live revision */
	liveRevision?: Revision;
	/** Who saved this revision, when known */
	authorName?: string;
	fieldLabels?: Record<string, string>;
	isLatest: boolean;
	isRestoring: boolean;
	isSelected: boolean;
	onRestore: () => void;
	onSelect: () => void;
}

function RevisionItem({
	revision,
	compareRevision,
	liveRevision,
	authorName,
	fieldLabels,
	isLatest,
	isRestoring,
	isSelected,
	onRestore,
	onSelect,
}: RevisionItemProps) {
	const { t, i18n } = useLingui();
	const [compareWith, setCompareWith] = React.useState<"previous" | "live">("previous");
	const isLive = liveRevision?.id === revision.id;
	const canCompareLive = !!liveRevision && !isLive;
	return (
		<div
			className={`rounded-lg border p-3 transition-colors ${
				isSelected ? "border-kumo-brand bg-kumo-brand/5" : "hover:bg-kumo-tint/50"
			}`}
		>
			<div className="flex items-start justify-between gap-2">
				<button type="button" onClick={onSelect} className="flex-1 text-start">
					<div className="flex items-center gap-2">
						<span className="text-base font-medium">
							{formatRelativeTime(revision.createdAt, i18n.locale)}
						</span>
						{isLatest && <Badge variant="outline">{t`Current`}</Badge>}
						{isLive && <Badge variant="outline">{t`Live`}</Badge>}
					</div>
					<div className="text-xs text-kumo-subtle mt-0.5">
						{formatFullDate(revision.createdAt)}
						{authorName ? ` · ${authorName}` : ""}
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
					{canCompareLive && (
						<div className="mb-2 flex gap-1 text-xs" role="group" aria-label={t`Compare with`}>
							{(
								[
									["previous", t`Changes in this save`],
									["live", t`Compared with live`],
								] as const
							).map(([value, label]) => (
								<button
									key={value}
									type="button"
									aria-pressed={compareWith === value}
									onClick={() => setCompareWith(value)}
									className={cn(
										"rounded-md border px-2 py-1",
										compareWith === value
											? "border-kumo-brand bg-kumo-brand/10 font-medium"
											: "border-kumo-line hover:bg-kumo-tint",
									)}
								>
									{label}
								</button>
							))}
						</div>
					)}
					{liveRevision && canCompareLive && compareWith === "live" ? (
						<RevisionDiffView
							older={liveRevision.data}
							newer={revision.data}
							against="live"
							fieldLabels={fieldLabels}
						/>
					) : compareRevision ? (
						<RevisionDiffView
							older={compareRevision.data}
							newer={revision.data}
							against="previous"
							fieldLabels={fieldLabels}
						/>
					) : (
						<>
							<div className="text-xs font-medium text-kumo-subtle mb-2">{t`Content snapshot:`}</div>
							<pre className="text-xs bg-kumo-tint p-2 rounded-md overflow-auto max-h-48">
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
	/** What `older` is: the revision saved before this one, or the live revision */
	against: "previous" | "live";
	fieldLabels?: Record<string, string>;
}

function RevisionDiffView({ older, newer, against, fieldLabels }: RevisionDiffViewProps) {
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
					{against === "live"
						? plural(changedCount, {
								one: "# change from the live version",
								other: "# changes from the live version",
							})
						: plural(changedCount, {
								one: "# change in this save",
								other: "# changes in this save",
							})}
				</div>
				{unchangedCount > 0 && (
					<button
						type="button"
						onClick={() => setShowUnchanged(!showUnchanged)}
						className="text-xs text-kumo-link hover:underline"
					>
						{showUnchanged
							? plural(unchangedCount, { one: "Hide # unchanged", other: "Hide # unchanged" })
							: plural(unchangedCount, { one: "Show # unchanged", other: "Show # unchanged" })}
					</button>
				)}
			</div>

			{changedCount === 0 && (
				<div className="text-xs text-kumo-subtle">
					{t`No field changed. SEO, bylines and taxonomies are not part of a revision, so a save that changed only those looks like this.`}
				</div>
			)}

			<div className="space-y-1.5">
				{visibleDiffs.map((diff) => (
					<DiffFieldRow key={diff.field} diff={diff} label={fieldLabels?.[diff.field]} />
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

function WordDiff({ segments }: { segments: WordSegment[] }) {
	return (
		<p className="whitespace-pre-wrap break-words leading-5">
			{segments.map(([op, text], i) =>
				op === "=" ? (
					text
				) : op === "+" ? (
					<ins key={i} className="rounded-sm bg-green-200 no-underline dark:bg-green-900/70">
						{text}
					</ins>
				) : (
					<del key={i} className="rounded-sm bg-red-200 dark:bg-red-900/70">
						{text}
					</del>
				),
			)}
		</p>
	);
}

function PortableTextDiff({ oldValue, newValue }: { oldValue: unknown[]; newValue: unknown[] }) {
	const { t } = useLingui();
	const result = React.useMemo(() => diffPortableText(oldValue, newValue), [oldValue, newValue]);
	if (!result) {
		return <div className="text-kumo-subtle">{t`Too long to compare; show the full values.`}</div>;
	}
	if (result.changes.length === 0) {
		return <div className="text-kumo-subtle">{t`Only formatting or settings changed.`}</div>;
	}
	return (
		<div className="space-y-2">
			{result.changes.map((change, i) => (
				<div
					key={i}
					className={cn(
						"border-s-2 ps-2",
						change.kind === "added"
							? "border-green-500"
							: change.kind === "removed"
								? "border-red-500"
								: "border-amber-500",
					)}
				>
					<WordDiff
						segments={
							change.kind === "changed"
								? change.segments
								: [[change.kind === "added" ? "+" : "-", change.text]]
						}
					/>
				</div>
			))}
			<div className="text-kumo-subtle">
				{plural(result.unchanged, { one: "# block unchanged", other: "# blocks unchanged" })}
			</div>
		</div>
	);
}

function DiffFieldRow({ diff, label }: { diff: FieldDiff; label?: string }) {
	const { t } = useLingui();
	const style = DIFF_STYLES[diff.kind];
	const [showFull, setShowFull] = React.useState(false);
	const readable =
		diff.kind !== "changed"
			? null
			: isPortableText(diff.oldValue) || isPortableText(diff.newValue)
				? "portableText"
				: typeof diff.oldValue === "string" && typeof diff.newValue === "string"
					? "text"
					: null;

	return (
		<div className={`rounded-lg border px-3 py-2 text-xs ${style.bg}`}>
			<div className="flex items-center gap-1.5 mb-1">
				{style.icon}
				<span className="font-medium" title={diff.field}>
					{label || diff.field}
				</span>
			</div>

			{readable && (
				<div className="mt-1.5 space-y-1.5">
					{readable === "portableText" ? (
						<PortableTextDiff
							oldValue={Array.isArray(diff.oldValue) ? diff.oldValue : []}
							newValue={Array.isArray(diff.newValue) ? diff.newValue : []}
						/>
					) : (
						<WordDiff segments={diffWords(String(diff.oldValue), String(diff.newValue))} />
					)}
					<button
						type="button"
						onClick={() => setShowFull(!showFull)}
						className="text-kumo-link hover:underline"
					>
						{showFull ? t`Hide full values` : t`Show full values`}
					</button>
				</div>
			)}

			{diff.kind === "changed" && (!readable || showFull) && (
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
