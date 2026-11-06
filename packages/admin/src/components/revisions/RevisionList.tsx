import { Badge, Button } from "@cloudflare/kumo";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { ArrowCounterClockwise } from "@phosphor-icons/react";
import * as React from "react";

import type { RevisionListItem, RevisionListResponse } from "../../lib/api";
import { restoredSources } from "../../lib/revision-diff/index.js";
import type { ChangeItem } from "../../lib/revision-diff/types.js";
import { cn, isolate } from "../../lib/utils.js";
import { changeLabel } from "./change-labels.js";
import {
	localDayKey,
	revisionAuthorColor,
	revisionAuthorColors,
	revisionDate,
	useRevisionFormat,
	type AuthorColor,
} from "./revision-format.js";
import { REVISION_LIST_LIMIT_ALL, visibleRevisionCount } from "./revision-query.js";
import { useRevisionViewContext, type RevisionViewContextValue } from "./revision-view-context.js";

const VISIBLE_CHANGES = 5;

const ROW_CLASS =
	"grid w-full grid-cols-[1rem_minmax(0,1fr)] gap-x-2 rounded-[0.625rem] p-2 text-start";
/** The timeline runs through the middle of the dot column: the row's padding plus half of it. */
const TIMELINE_CLASS = "absolute start-[15.25px] w-[1.5px] bg-kumo-line";

const SCROLLING_OVERFLOW_REGEX = /auto|scroll|overlay/;

/** The nearest element around `element` that scrolls vertically. */
function scrollContainer(element: HTMLElement): HTMLElement | null {
	for (let node = element.parentElement; node; node = node.parentElement) {
		if (SCROLLING_OVERFLOW_REGEX.test(getComputedStyle(node).overflowY)) return node;
	}
	return null;
}

function rowElement(root: HTMLElement | null, revisionId: string): HTMLElement | null {
	return (
		root?.querySelector<HTMLElement>(
			`[data-revision-row][data-revision-id="${CSS.escape(revisionId)}"]`,
		) ?? null
	);
}

interface DayGroup {
	key: string;
	/** Unique even when the list isn't strictly in date order and a day comes up twice. */
	id: string;
	label: string;
	items: RevisionListItem[];
}

interface RevisionListProps {
	list: RevisionListResponse;
	/** The list is waiting for older versions and still shows the shorter one. */
	loadingOlder: boolean;
}

/** Versions grouped by day, with what changed under the one shown in the canvas. */
export function RevisionList({ list, loadingOlder }: RevisionListProps) {
	const { t } = useLingui();
	const view = useRevisionViewContext();
	const format = useRevisionFormat();
	const headingIdPrefix = React.useId();
	const rootRef = React.useRef<HTMLDivElement>(null);
	const focusRowAfterLoad = React.useRef<number | null>(null);
	const pickedRowRef = React.useRef<{ revisionId: string; top: number } | null>(null);

	const visibleCount = visibleRevisionCount(list);
	const colors = React.useMemo(() => revisionAuthorColors(list.items), [list.items]);
	const fields = view?.fields;
	const sources = React.useMemo(
		() => (fields ? restoredSources(list.items, fields) : new Map<string, string>()),
		[list.items, fields],
	);
	const savedWhen = (revisionId: string) => {
		const revision = list.items.find((item) => item.id === revisionId);
		return revision ? format.when(revisionDate(revision.createdAt)) : null;
	};

	const groups: DayGroup[] = [];
	const dayCounts = new Map<string, number>();
	for (const item of list.items.slice(0, visibleCount)) {
		const date = revisionDate(item.createdAt);
		const key = localDayKey(date);
		const group = groups.at(-1);
		if (group?.key === key) {
			group.items.push(item);
			continue;
		}
		const count = dayCounts.get(key) ?? 0;
		dayCounts.set(key, count + 1);
		groups.push({
			key,
			id: count ? `${key}:${count}` : key,
			label: format.day(date),
			items: [item],
		});
	}

	React.useEffect(() => {
		const index = focusRowAfterLoad.current;
		if (index === null || loadingOlder) return;
		focusRowAfterLoad.current = null;
		const rows = [...(rootRef.current?.querySelectorAll<HTMLElement>("[data-revision-row]") ?? [])];
		(rows[index] ?? rows.at(-1))?.focus();
	}, [loadingOlder, visibleCount]);

	// The changes listed under the version picked before close as the new one opens. When they
	// sat above it, the picked row would move up under the pointer, so the list scrolls to hold it.
	const viewingId = view?.viewingId ?? null;
	React.useLayoutEffect(() => {
		const picked = pickedRowRef.current;
		pickedRowRef.current = null;
		if (!picked || picked.revisionId !== viewingId) return;
		const row = rowElement(rootRef.current, picked.revisionId);
		const scroller = row && scrollContainer(row);
		if (!row || !scroller) return;
		scroller.scrollTop += row.getBoundingClientRect().top - picked.top;
	}, [viewingId]);

	const rowToFocus = view?.rowToFocus ?? null;
	const clearRowToFocus = view?.clearRowToFocus;
	React.useEffect(() => {
		if (!rowToFocus) return;
		const row = rowElement(rootRef.current, rowToFocus.revisionId);
		if (!row) return;
		// The restore dialog hands focus back as it closes, after this commit.
		const frame = requestAnimationFrame(() => {
			clearRowToFocus?.();
			const active = document.activeElement;
			if (!active || active === document.body || active === rowToFocus.opener) row.focus();
		});
		return () => cancelAnimationFrame(frame);
	}, [rowToFocus, clearRowToFocus, list.items]);

	const canShowOlder =
		view !== null &&
		list.total > visibleCount &&
		(view.listLimit !== REVISION_LIST_LIMIT_ALL || loadingOlder);

	return (
		<div ref={rootRef} className="pt-2">
			{groups.map((group) => {
				const headingId = `${headingIdPrefix}-${group.id}`;
				return (
					<React.Fragment key={group.id}>
						<h4
							id={headingId}
							className="px-3 pt-3.5 pb-1 text-xs leading-4 font-medium text-kumo-subtle first:pt-0"
						>
							{group.label}
						</h4>
						<ul aria-labelledby={headingId} className="grid grid-cols-1 gap-0.5">
							{group.items.map((item, index) => (
								<VersionRow
									key={item.id}
									item={item}
									firstOfDay={index === 0}
									lastOfDay={index === group.items.length - 1}
									view={view}
									color={revisionAuthorColor(colors, item)}
									restoredFrom={sources.get(item.id) ?? null}
									savedWhen={savedWhen}
									onPick={(row) => {
										pickedRowRef.current = {
											revisionId: item.id,
											top: row.getBoundingClientRect().top,
										};
									}}
								/>
							))}
						</ul>
					</React.Fragment>
				);
			})}
			{canShowOlder && (
				<Button
					type="button"
					variant="ghost"
					size="sm"
					className="ms-0.5 mt-2"
					loading={loadingOlder}
					onClick={() => {
						focusRowAfterLoad.current = visibleCount;
						view.showOlderVersions();
					}}
				>
					{t`Show older versions`}
				</Button>
			)}
		</div>
	);
}

interface VersionRowProps {
	item: RevisionListItem;
	firstOfDay: boolean;
	lastOfDay: boolean;
	view: RevisionViewContextValue | null;
	color: AuthorColor;
	/** The version this one copies, when it is a restored copy. */
	restoredFrom: string | null;
	/** When a listed version was saved, or null when it isn't loaded. */
	savedWhen: (revisionId: string) => string | null;
	/** Runs before the row's version opens. */
	onPick: (row: HTMLElement) => void;
}

function VersionRow({
	item,
	firstOfDay,
	lastOfDay,
	view,
	color,
	restoredFrom,
	savedWhen,
	onPick,
}: VersionRowProps) {
	const { t } = useLingui();
	const format = useRevisionFormat();
	const date = revisionDate(item.createdAt);
	const when = format.when(date);
	const author = format.author(item.author);
	const isCurrent = view?.currentRevisionId === item.id;
	const isPublished = view?.liveRevisionId === item.id;
	const isSelected = view?.viewingId === item.id;

	const label =
		isCurrent && isPublished
			? t`${when}, Current version, Published, ${author}`
			: isCurrent
				? t`${when}, Current version, ${author}`
				: isPublished
					? t`${when}, Published, ${author}`
					: t`${when}, ${author}`;
	const restoredWhen = restoredFrom ? savedWhen(restoredFrom) : null;
	const restoredDate = restoredWhen ? isolate(restoredWhen) : null;
	const restored = restoredDate ? t`Restored from ${restoredDate}` : null;

	const content = (
		<>
			<span className="sr-only">{restored ? t`${label}, ${restored}` : label}</span>
			<span aria-hidden="true" className="flex h-5 items-center justify-center">
				<span
					data-author-color={color}
					className={cn(
						"shrink-0 rounded-full",
						isCurrent
							? "size-2.5 border-2 border-(--emdash-author)"
							: "size-2 bg-(--emdash-author)",
						isSelected &&
							"outline-2 outline-offset-2 outline-[color-mix(in_oklab,var(--emdash-author)_45%,transparent)]",
					)}
				/>
			</span>
			<span aria-hidden="true" className="grid min-w-0">
				<span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5">
					<time dateTime={date.toISOString()} className="text-base font-medium tabular-nums">
						<bdi>{format.time(date)}</bdi>
					</time>
					{isCurrent && <Badge variant="secondary">{t`Current version`}</Badge>}
					{isPublished && <Badge variant="success">{t`Published`}</Badge>}
				</span>
				<bdi className="max-w-full justify-self-start truncate text-base text-kumo-subtle">
					{author}
				</bdi>
				{restored && (
					<span className="mt-0.5 flex min-w-0 items-center gap-1 text-xs leading-4 text-kumo-subtle">
						<ArrowCounterClockwise className="size-3 shrink-0" />
						<span className="truncate">{restored}</span>
					</span>
				)}
			</span>
		</>
	);

	return (
		<li className={cn("relative rounded-[0.625rem]", isSelected && "bg-kumo-tint")}>
			{/* The day's timeline, broken around each version's dot. */}
			{!firstOfDay && <span aria-hidden="true" className={cn(TIMELINE_CLASS, "top-0 h-2.5")} />}
			{!lastOfDay && (
				<span aria-hidden="true" className={cn(TIMELINE_CLASS, "top-[26px] -bottom-0.5")} />
			)}
			{view ? (
				<button
					type="button"
					data-revision-row=""
					data-revision-id={item.id}
					aria-current={isSelected || undefined}
					onClick={(event) => {
						if (isSelected) return;
						onPick(event.currentTarget);
						view.view(item.id, { opener: event.currentTarget });
					}}
					className={cn(
						ROW_CLASS,
						"outline-none focus-visible:ring-2 focus-visible:ring-kumo-brand focus-visible:ring-inset",
						!isSelected && "cursor-pointer hover:bg-kumo-tint/60",
					)}
				>
					{content}
				</button>
			) : (
				<div className={ROW_CLASS}>{content}</div>
			)}
			{view && isSelected && view.viewingDiff && (
				<ChangeList
					// The row already says which version this one restored.
					changes={view.viewingDiff.changes.filter(
						(change) => !(restored && change.kind === "restored"),
					)}
					savedWhen={savedWhen}
					goToChange={view.goToChange}
				/>
			)}
		</li>
	);
}

interface ChangeListProps {
	changes: readonly ChangeItem[];
	savedWhen: (revisionId: string) => string | null;
	goToChange: (targetId: string) => void;
}

function ChangeList({ changes, savedWhen, goToChange }: ChangeListProps) {
	const { t, i18n } = useLingui();
	const [showAll, setShowAll] = React.useState(false);
	const firstRevealed = React.useRef<HTMLElement | null>(null);
	const focusRevealed = React.useRef(false);

	React.useEffect(() => {
		if (!showAll || !focusRevealed.current) return;
		focusRevealed.current = false;
		firstRevealed.current?.focus();
	}, [showAll]);

	const shown = showAll ? changes : changes.slice(0, VISIBLE_CHANGES);
	const hiddenCount = changes.length - shown.length;
	if (changes.length === 0) return null;

	return (
		<ul aria-label={t`Changes in this version`} className="ms-6 me-2 mb-2 grid grid-cols-1">
			{shown.map((change, index) => {
				const text = changeLabel(i18n, change, { restoredWhen: savedWhen });
				const ref =
					index === VISIBLE_CHANGES
						? (element: HTMLElement | null) => {
								firstRevealed.current = element;
							}
						: undefined;
				const target = "target" in change ? change.target : null;
				return target ? (
					<li key={index}>
						<button
							ref={ref}
							type="button"
							onClick={() => goToChange(target)}
							className="block w-full cursor-pointer truncate rounded-md px-2 py-1 text-start text-base outline-none hover:bg-kumo-base focus-visible:ring-2 focus-visible:ring-kumo-brand pointer-coarse:py-2"
						>
							{text}
						</button>
					</li>
				) : (
					<li
						key={index}
						ref={ref}
						tabIndex={ref ? -1 : undefined}
						className="truncate rounded-md px-2 py-1 text-base text-kumo-subtle outline-none focus-visible:ring-2 focus-visible:ring-kumo-brand"
					>
						{text}
					</li>
				);
			})}
			{hiddenCount > 0 && (
				<li className="mt-0.5">
					<Button
						type="button"
						variant="ghost"
						size="sm"
						onClick={() => {
							focusRevealed.current = true;
							setShowAll(true);
						}}
					>
						{plural(hiddenCount, { one: "Show # more", other: "Show # more" })}
					</Button>
				</li>
			)}
		</ul>
	);
}
