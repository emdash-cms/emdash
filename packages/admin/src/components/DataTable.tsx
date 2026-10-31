import { Button, DropdownMenu, Table } from "@cloudflare/kumo";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { DotsThree, X } from "@phosphor-icons/react";
import * as React from "react";

import { cn } from "../lib/utils.js";

/**
 * Spread on a column's header and on each of its cells to hide the column while
 * the table is narrower than 28rem. Repeat what matters from it in `RowMeta`.
 */
export const secondaryColumn = { "data-priority": "secondary" } as const;

/**
 * Spread on a column's header and on each of its cells to hide the column while
 * the table is narrower than 42rem. To repeat it, use `RowMeta` with `priority="tertiary"`.
 */
export const tertiaryColumn = { "data-priority": "tertiary" } as const;

export type ColumnPriority = (typeof secondaryColumn | typeof tertiaryColumn)["data-priority"];

/**
 * Spread on a drag-handle column's header and on each of its cells. The column hugs
 * the handle, so a 32px handle's icon sits 16px from the table's edge. Set
 * `data-dragging` on the row being dragged to raise it above the others.
 */
export const handleColumn = { "data-column": "handle" } as const;

const POPUP_SELECTOR = "[role=dialog], [role=alertdialog], [role=menu]";
const CONTROL_SELECTOR = "a[href], button, input, select, textarea, [tabindex]";

function isControl(element: HTMLElement) {
	return (
		element.tabIndex >= 0 &&
		!element.matches(":disabled") &&
		!element.closest("[inert]") &&
		element.getClientRects().length > 0
	);
}

function rowControls(row: HTMLTableRowElement) {
	return [...row.querySelectorAll<HTMLElement>(CONTROL_SELECTOR)].filter(isControl);
}

function controlRows(tray: HTMLElement) {
	return [...tray.querySelectorAll<HTMLTableRowElement>("tbody > tr")].filter((row) =>
		[...row.querySelectorAll<HTMLElement>(CONTROL_SELECTOR)].some(isControl),
	);
}

const isMenuTrigger = (control: HTMLElement) => control.getAttribute("aria-haspopup") === "menu";

/** Where focus sat in the table: its row's place in the table body, and its place in the row. */
interface RowFocus {
	element: Element;
	row: HTMLTableRowElement;
	rowIndex: number;
	controlIndex: number;
	menuButton: boolean;
}

/** A row focus whose element has left, with the nodes on either side of its row as the row left. */
interface LostFocus extends RowFocus {
	next?: Node | null;
	previous?: Node | null;
}

function describeRowFocus(tray: HTMLElement, element: Element): RowFocus | null {
	const row = element.closest("tr");
	if (!row || row.parentElement?.localName !== "tbody" || !tray.contains(row)) return null;
	const controls = rowControls(row);
	const controlIndex = controls.findIndex((control) => control.contains(element));
	const control = controls[controlIndex];
	if (!control) return null;
	return {
		element,
		row,
		rowIndex: row.sectionRowIndex,
		controlIndex,
		menuButton: isMenuTrigger(control),
	};
}

/**
 * The lost row if it stayed, the row that took its place, or else the row before it. Without a
 * record of the row leaving, such as when the whole body is replaced, its old place decides.
 */
function replacementRow(rows: HTMLTableRowElement[], lost: LostFocus) {
	const find = (node: Node | null | undefined) => rows.find((row) => row === node);
	const inPlace = find(lost.row) ?? find(lost.next);
	if (inPlace) return { row: inPlace, inPlace: true };
	const before = find(lost.previous);
	if (before) return { row: before, inPlace: false };
	const after = rows.find((row) => row.sectionRowIndex >= lost.rowIndex);
	return after ? { row: after, inPlace: true } : { row: rows.at(-1), inPlace: false };
}

function focusReplacement(tray: HTMLElement, lost: LostFocus) {
	const { row, inPlace } = replacementRow(controlRows(tray), lost);
	if (!row) return;
	const controls = rowControls(row);
	const menuButton = controls.find(isMenuTrigger);
	// With no row in the lost row's place, a second press on the same control would act on a
	// row the user didn't pick, while the "…" button only opens a menu.
	const target = inPlace
		? (lost.menuButton && menuButton) || controls[Math.min(lost.controlIndex, controls.length - 1)]
		: (menuButton ?? controls[0]);
	target?.focus();
}

/** Watches the table for the row holding focus leaving it, and returns a cleanup. */
function keepRowFocus(tray: HTMLElement) {
	const doc = tray.ownerDocument;
	let focused: RowFocus | null = null;
	let lost: LostFocus | null = null;
	let popup: Element | null = null;
	let popupObserver: MutationObserver | null = null;

	function stopWaiting() {
		popupObserver?.disconnect();
		popupObserver = null;
		popup = null;
	}

	function forget() {
		focused = null;
		lost = null;
		stopWaiting();
	}

	function restore(from: LostFocus) {
		forget();
		focusReplacement(tray, from);
		const active = doc.activeElement;
		if (active && tray.contains(active)) focused = describeRowFocus(tray, active);
	}

	// A row added or dropped above the focused row in the same update shifts every row's place,
	// so the rows beside it as it left decide which row takes its place. A neighbour that left in
	// the same update passes the question on to its own neighbour.
	function noteRemovals(records: MutationRecord[]) {
		if (!focused || focused.element.isConnected) return;
		const removedWith = (node: Node | null | undefined) =>
			node && records.find((record) => [...record.removedNodes].includes(node));
		const removal = removedWith(focused.row);
		let next = removal?.nextSibling;
		while (next && !next.isConnected) next = removedWith(next)?.nextSibling;
		let previous = removal?.previousSibling;
		while (previous && !previous.isConnected) previous = removedWith(previous)?.previousSibling;
		lost = { ...focused, next, previous };
		focused = null;
		queueMicrotask(settle);
	}

	// Runs after Base UI hands focus back from a closing popup, which it does in a microtask.
	function settle() {
		if (!lost) return;
		const active = doc.activeElement;
		const holder = active?.closest(POPUP_SELECTOR);
		if (!active || active === doc.body) restore(lost);
		else if (holder) waitForPopup(holder);
		else lost = null;
	}

	// A menu or dialog opened from the row still has focus. Once it closes, Base UI can't hand
	// focus back to the row, so focus lands on the page body or on an older control. Settling
	// in a later task first lets a page that moves focus itself once a dialog closes do so.
	function waitForPopup(holder: Element) {
		if (holder === popup) return;
		stopWaiting();
		popup = holder;
		popupObserver = new MutationObserver(() => {
			if (holder.isConnected) return;
			popupObserver?.disconnect();
			// Base UI queues its hand-back as the popup unmounts, so it runs before this clears
			// `popup`, and a focus move in between is that hand-back.
			queueMicrotask(() => {
				if (popup === holder) popup = null;
			});
			setTimeout(settle, 0);
		});
		popupObserver.observe(doc.body, { childList: true, subtree: true });
	}

	const observer = new MutationObserver(noteRemovals);

	const onFocusIn = (event: FocusEvent) => {
		const target = event.target;
		// Another table's listener may already have moved focus on from this event's target.
		if (!(target instanceof Element) || target !== doc.activeElement) return;
		// The focused row can leave in the same task that moves focus, before the observer runs.
		noteRemovals(observer.takeRecords());
		const inTable = tray.contains(target);
		if (!inTable && target.closest(POPUP_SELECTOR)) return;
		// Base UI hands focus back from a closing popup to another row or to a control outside
		// the table.
		if (lost && (inTable || (popup && !popup.isConnected))) restore(lost);
		else if (inTable) focused = describeRowFocus(tray, target);
		else forget();
	};

	// Resumes tracking after a pointer press that left focus in a row, such as dragging a scrollbar.
	const onKeyDown = () => {
		const active = doc.activeElement;
		if (!focused && active && tray.contains(active)) focused = describeRowFocus(tray, active);
	};

	observer.observe(tray, { childList: true, subtree: true });
	doc.addEventListener("focusin", onFocusIn, true);
	doc.addEventListener("keydown", onKeyDown, true);
	// A pointer press puts focus where the user wants it, even on the page body.
	doc.addEventListener("pointerdown", forget, true);
	return () => {
		observer.disconnect();
		forget();
		doc.removeEventListener("focusin", onFocusIn, true);
		doc.removeEventListener("keydown", onKeyDown, true);
		doc.removeEventListener("pointerdown", forget, true);
	};
}

/**
 * A Kumo table laid out like a LayerCard: the header row sits on the tinted
 * outer layer and the rows on a raised card inside it. Cell padding, background
 * and borders come from the table, so a class on a single cell can't change them.
 * Set `data-selected` on a selected row, `data-drop-active` on a row while a
 * dragged item can be dropped on it, and `data-clickable` on a row that opens when
 * clicked anywhere, so it tints under the pointer.
 *
 * When the body row holding keyboard focus leaves, focus moves to the same control in the
 * row that takes its place: the "…" button if that had focus, otherwise the control in the
 * same place. When no row takes its place, focus moves to the "…" button of the row before
 * it, or to its first control if it has none. A control that leaves a row that stays hands
 * focus to the row's control in its place. A row's dialog usually closes, and hands focus
 * back to the row, before the refetch that removes the row lands. If the row leaves first,
 * focus moves once the dialog or menu opened from it closes, wherever Base UI then puts
 * focus. Otherwise focus that has moved anywhere but the page body stays put. A pointer
 * press cancels a move that is waiting, and focus stays where you put it by clicking
 * elsewhere.
 *
 * Breakpoints follow the table's own width, not the viewport's, because the
 * sidebar takes part of the screen from 768px up.
 */
export function DataTable({ className, children, ...props }: React.ComponentProps<typeof Table>) {
	const trayRef = React.useRef<HTMLDivElement>(null);
	React.useEffect(() => {
		const tray = trayRef.current;
		return tray ? keepRowFocus(tray) : undefined;
	}, []);
	return (
		<div
			ref={trayRef}
			className="@container overflow-x-auto rounded-xl bg-kumo-elevated ring ring-kumo-line"
		>
			<Table
				{...props}
				className={cn(
					"border-separate border-spacing-0 text-start",
					// Browsers center a th by default. :where() keeps this rule below a
					// th's own alignment class, such as text-end.
					"[:where(&)_th]:text-start",
					"[&_th]:border-b-0 [&_th]:bg-transparent [&_th]:px-4 [&_th]:py-3.5 [&_th]:font-normal [&_th]:whitespace-nowrap [&_th]:text-kumo-subtle",
					"[&_td]:border-kumo-line [&_td]:bg-kumo-base [&_td]:px-4 [&_td]:py-3.5",
					"[&_tr[data-selected]_td]:bg-kumo-tint",
					// A translucent tint would let the darker tray show through, so it's mixed into the cell's color.
					"[@media(hover:hover)]:[&_tr[data-clickable]:not([data-selected],[data-drop-active]):hover_td]:bg-[color-mix(in_srgb,var(--color-kumo-tint)_25%,var(--color-kumo-base))]",
					// Cells cover a row's background but not its outline, so the tint goes on the cells.
					// Rounding the first and last rows keeps the outline inside the card's corners.
					"[&_tr[data-drop-active]_td]:bg-kumo-tint",
					"[&_tr[data-drop-active]]:outline-2 [&_tr[data-drop-active]]:-outline-offset-2 [&_tr[data-drop-active]]:outline-kumo-brand [&_tr[data-drop-active]]:outline-dashed",
					"[&_tbody_tr[data-drop-active]:first-child]:rounded-t-xl [&_tbody_tr[data-drop-active]:last-child]:rounded-b-xl",
					"[&_tbody_tr:first-child_td]:border-t",
					"[&_tbody_tr:first-child_td:first-child]:rounded-ss-xl [&_tbody_tr:first-child_td:last-child]:rounded-se-xl",
					"@max-md:[&_th]:px-3 @max-md:[&_td]:px-3",
					"[&_:is(th,td)[data-column=handle]]:w-0 [&_:is(th,td)[data-column=handle]]:ps-2 [&_:is(th,td)[data-column=handle]]:pe-0",
					"[&_tr[data-dragging]]:relative [&_tr[data-dragging]]:z-10 [&_tr[data-dragging]]:shadow-lg",
					"@max-md:[&_:is(th,td)[data-priority=secondary]]:hidden @max-2xl:[&_:is(th,td)[data-priority=tertiary]]:hidden",
					// The card's top-end corner belongs to the last cell still shown.
					"@max-md:[&_tbody_tr:first-child_td:nth-last-child(1_of_:not([data-priority]))]:rounded-se-xl",
					"@max-2xl:[&_tbody_tr:first-child_td:nth-last-child(1_of_:not([data-priority=tertiary]))]:rounded-se-xl",
					className,
				)}
			>
				{children}
			</Table>
		</div>
	);
}

const rowMetaHidden: Record<ColumnPriority, string> = {
	secondary: "@md:hidden",
	tertiary: "@2xl:hidden",
};

/**
 * Details shown under a row's name while the columns they repeat are hidden: below 28rem
 * for a `priority` of `"secondary"`, the default, and below 42rem for `"tertiary"`.
 * Badges and other nowrap content inside it wrap, so a long label can't widen the table.
 */
export function RowMeta({
	priority = "secondary",
	children,
}: {
	priority?: ColumnPriority;
	children: React.ReactNode;
}) {
	return (
		<div
			className={cn(
				"mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-kumo-subtle [&_*]:max-w-full [&_*]:whitespace-normal",
				rowMetaHidden[priority],
			)}
		>
			{children}
		</div>
	);
}

/** A full-width row for a loading, empty, or no-results message. */
export function DataTableMessage({
	colSpan,
	children,
}: {
	colSpan: number;
	children: React.ReactNode;
}) {
	return (
		<tr>
			<td colSpan={colSpan} className="text-center text-kumo-subtle">
				<div className="py-4.5">{children}</div>
			</td>
		</tr>
	);
}

/**
 * The bar shown above a table while rows are selected: the number selected, the bulk
 * actions passed as children, and Clear. The actions wrap when the bar is narrow.
 * While `busy`, the count says the selected rows are being worked on and Clear is disabled.
 */
export function DataTableBulkBar({
	selectedCount,
	busy = false,
	onClear,
	children,
}: {
	selectedCount: number;
	busy?: boolean;
	onClear: () => void;
	children: React.ReactNode;
}) {
	const { t } = useLingui();
	return (
		<div className="flex flex-wrap items-center gap-3 rounded-xl bg-kumo-elevated px-4 py-2 ring ring-kumo-line">
			<span className="text-sm font-medium">
				{busy
					? t`Working on ${selectedCount} items…`
					: plural(selectedCount, { one: "# selected", other: "# selected" })}
			</span>
			<div className="flex flex-wrap items-center gap-2">
				{children}
				<Button size="sm" variant="ghost" icon={<X />} disabled={busy} onClick={onClear}>
					{t`Clear`}
				</Button>
			</div>
		</div>
	);
}

/**
 * Sizes a slug or other unbroken code. In a table at least 42rem wide, long text in
 * another column can't squeeze a short slug onto two lines, and a long one wraps at
 * 10rem instead of widening its column. In a narrower table it wraps anywhere, like
 * a row's name.
 */
export const cellCodeClassName = "wrap-anywhere @2xl:inline-block @2xl:w-max @2xl:max-w-40";

/** Styles the name that opens a row's record, as a link or a button. */
export const rowTitleClassName = "font-medium @max-2xl:wrap-anywhere hover:text-kumo-link";

/** A row's name as a button, for rows whose record opens in place rather than at a URL. */
export function RowTitleButton({ className, ...props }: React.ComponentProps<"button">) {
	return (
		<button
			type="button"
			{...props}
			className={cn(rowTitleClassName, "cursor-pointer text-start", className)}
		/>
	);
}

/** The "…" button that opens a row's actions. Pass `DropdownMenu` items as children. */
export function RowActionsMenu({ label, children }: { label: string; children: React.ReactNode }) {
	return (
		<DropdownMenu>
			<DropdownMenu.Trigger
				render={
					<Button variant="ghost" size="sm" shape="square" aria-label={label}>
						<DotsThree weight="bold" size={18} aria-hidden="true" />
					</Button>
				}
			/>
			<DropdownMenu.Content align="end">{children}</DropdownMenu.Content>
		</DropdownMenu>
	);
}
