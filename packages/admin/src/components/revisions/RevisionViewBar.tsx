import { Button, Switch, Tooltip } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import { ArrowCounterClockwise, X } from "@phosphor-icons/react";
import * as React from "react";

import type { ContentItem, RevisionListItem } from "../../lib/api";
import { cn } from "../../lib/utils.js";
import { CaretNext, CaretPrev } from "../ArrowIcons.js";
import { revisionDate, useRevisionFormat, type AuthorColor } from "./revision-format.js";
import { RevisionRestoreDialog } from "./RevisionRestoreDialog.js";
import type { RevisionStepDirection } from "./useRevisionView.js";

export interface RevisionViewBarProps {
	collection: string;
	entryId: string;
	revision: RevisionListItem;
	authorColor: AuthorColor;
	isCurrent: boolean;
	isPublished: boolean;
	/** The version holds the same content as the current one, so there is nothing to restore. */
	sameAsCurrent: boolean;
	/** The entry has a draft, which restoring replaces. */
	hasDraft: boolean;
	/** The entry is scheduled, so a restored version publishes on its own. */
	scheduled: boolean;
	/** The version has an older one to compare with. Without one, Show changes stays in place but disabled. */
	canShowChanges: boolean;
	showChanges: boolean;
	onShowChangesChange: (showChanges: boolean) => void;
	onExit: () => void;
	/** Adds older and newer arrows, for when the Revisions list isn't on screen. */
	showStepper: boolean;
	hasOlder: boolean;
	hasNewer: boolean;
	onStep: (direction: RevisionStepDirection) => void;
	readOnly: boolean;
	/** A save is in flight; restoring now could race it. */
	saveBusy: boolean;
	isDirty: boolean;
	restorePending: boolean;
	onRestoreStart: (restoredItem: ContentItem) => void;
	onRestoreFailed: () => void;
	onRestoreSettled: () => void;
	onRevisionRestored?: (item: ContentItem) => void | Promise<void>;
	titleRef: React.RefObject<HTMLHeadingElement | null>;
	dockRef: React.RefObject<HTMLDivElement | null>;
}

/** The bar at the bottom of the canvas while a saved version is shown in place of the editor. */
export function RevisionViewBar({
	collection,
	entryId,
	revision,
	authorColor,
	isCurrent,
	isPublished,
	sameAsCurrent,
	hasDraft,
	scheduled,
	canShowChanges,
	showChanges,
	onShowChangesChange,
	onExit,
	showStepper,
	hasOlder,
	hasNewer,
	onStep,
	readOnly,
	saveBusy,
	isDirty,
	restorePending,
	onRestoreStart,
	onRestoreFailed,
	onRestoreSettled,
	onRevisionRestored,
	titleRef,
	dockRef,
}: RevisionViewBarProps) {
	const { t } = useLingui();
	const format = useRevisionFormat();
	const titleId = React.useId();
	const [restoreOpen, setRestoreOpen] = React.useState(false);
	const nothingToRestore = isCurrent
		? t`Current version`
		: sameAsCurrent
			? t`Same as current version`
			: null;
	const canRestore = !nothingToRestore && !readOnly;
	const when = format.when(revisionDate(revision.createdAt));
	const olderRef = React.useRef<HTMLButtonElement>(null);
	const newerRef = React.useRef<HTMLButtonElement>(null);
	const lastStepRef = React.useRef<RevisionStepDirection | null>(null);

	React.useLayoutEffect(() => {
		const direction = lastStepRef.current;
		if (!direction) return;
		lastStepRef.current = null;
		const arrow = direction === "older" ? olderRef.current : newerRef.current;
		const active = document.activeElement;
		if (arrow?.disabled && (active === arrow || active === document.body)) {
			titleRef.current?.focus({ preventScroll: true });
		}
	}, [revision.id, titleRef]);

	const step = (direction: RevisionStepDirection) => {
		lastStepRef.current = direction;
		onStep(direction);
	};

	const closeRestore = React.useCallback(() => setRestoreOpen(false), []);

	return (
		<div
			ref={dockRef}
			className="emdash-revision-dock pointer-events-none sticky bottom-0 z-20 -mx-(--emdash-editor-gutter) mt-auto flex justify-center px-(--emdash-editor-gutter) pt-8 pb-[max(1rem,env(safe-area-inset-bottom))]"
		>
			<section
				aria-labelledby={titleId}
				data-author-color={authorColor}
				className="emdash-revision-bar @container pointer-events-auto w-full max-w-[30rem] rounded-[0.875rem] bg-kumo-base ring ring-kumo-line"
			>
				{/* One line when the bar is wide enough for the version and its buttons, otherwise two
				    at every version, so stepping through versions never moves the buttons. */}
				<div
					className={cn(
						"grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 py-1.5 ps-4 pe-1.5",
						!showStepper && "@min-[30rem]:grid-cols-[auto_minmax(0,1fr)_auto] @min-[30rem]:gap-x-3",
					)}
				>
					<h2
						ref={titleRef}
						id={titleId}
						tabIndex={-1}
						className="truncate text-base font-semibold focus:outline-none"
					>
						{when}
					</h2>
					<p
						className={cn(
							"col-span-2 row-start-2 flex min-w-0 items-center gap-x-1.5 pb-1.5 text-base text-kumo-subtle",
							!showStepper &&
								"@min-[30rem]:col-span-1 @min-[30rem]:col-start-2 @min-[30rem]:row-start-1 @min-[30rem]:pb-0",
						)}
					>
						<span className="flex min-w-0 items-center gap-1.5">
							<span
								aria-hidden="true"
								className="size-2 shrink-0 rounded-full bg-(--emdash-author)"
							/>
							<bdi className="truncate">{format.author(revision.author)}</bdi>
						</span>
						{isPublished && (
							<span className="flex shrink-0 items-center gap-1.5">
								<span aria-hidden="true">·</span>
								<span className="sr-only">
									{t({
										message: ", ",
										context: "Read aloud between a version's author and status",
									})}
								</span>
								<span>{t`Published`}</span>
							</span>
						)}
					</p>
					<div
						className={cn(
							"col-start-2 row-start-1 flex items-center",
							!showStepper && "@min-[30rem]:col-start-3",
						)}
					>
						{showStepper && (
							<>
								<Button
									ref={olderRef}
									type="button"
									variant="ghost"
									shape="square"
									aria-label={t`Older version`}
									icon={<CaretPrev className="size-4" />}
									disabled={!hasOlder}
									onClick={() => step("older")}
								/>
								<Button
									ref={newerRef}
									type="button"
									variant="ghost"
									shape="square"
									aria-label={t`Newer version`}
									icon={<CaretNext className="size-4" />}
									disabled={!hasNewer}
									onClick={() => step("newer")}
								/>
							</>
						)}
						<Tooltip
							content={t`Back to editing (Esc)`}
							// The open tooltip takes the Esc it advertises, so that Esc has to leave too.
							onOpenChange={(open, details) => {
								if (!open && details.reason === "escape-key") onExit();
							}}
							render={
								<Button
									type="button"
									variant="ghost"
									shape="square"
									aria-label={t`Back to editing`}
									aria-keyshortcuts="Escape"
									icon={<X aria-hidden="true" />}
									disabled={restorePending}
									onClick={onExit}
								/>
							}
						/>
					</div>
				</div>
				{/* The content box holds Restore's height when there's nothing to restore, so the bar
				    keeps its size from one version to the next. */}
				<div className="box-content flex min-h-9 items-center justify-between gap-3 border-t border-kumo-line py-1.5 ps-4 pe-1.5">
					<Switch
						size="sm"
						controlFirst={false}
						label={
							<span className="font-normal whitespace-nowrap text-kumo-subtle">{t`Show changes`}</span>
						}
						checked={showChanges}
						disabled={!canShowChanges}
						onCheckedChange={onShowChangesChange}
					/>
					{canRestore ? (
						<Button
							type="button"
							variant="primary"
							icon={<ArrowCounterClockwise />}
							disabled={saveBusy || restorePending}
							onClick={() => setRestoreOpen(true)}
						>
							{t`Restore`}
						</Button>
					) : (
						nothingToRestore && (
							<span className="min-w-0 truncate pe-2.5 text-base text-kumo-subtle">
								{nothingToRestore}
							</span>
						)
					)}
				</div>
			</section>
			<RevisionRestoreDialog
				open={restoreOpen}
				onClose={closeRestore}
				collection={collection}
				entryId={entryId}
				revision={revision}
				hasDraft={hasDraft}
				scheduled={scheduled}
				isDirty={isDirty}
				restorePending={restorePending}
				onRestoreStart={onRestoreStart}
				onRestoreFailed={onRestoreFailed}
				onRestoreSettled={onRestoreSettled}
				onRevisionRestored={onRevisionRestored}
			/>
		</div>
	);
}
