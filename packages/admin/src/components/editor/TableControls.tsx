import { Button, DropdownMenu, Popover, Select, Switch } from "@cloudflare/kumo";
import type { MessageDescriptor } from "@lingui/core";
import { msg, plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import * as Icons from "@phosphor-icons/react";
import type { Editor, Range } from "@tiptap/core";
import { closeHistory } from "@tiptap/pm/history";
import {
	NodeSelection,
	TextSelection,
	type SelectionBookmark,
	type Transaction,
} from "@tiptap/pm/state";
import { CellSelection, cellAround } from "@tiptap/pm/tables";
import { useEditorState } from "@tiptap/react";
import * as React from "react";

import { cn } from "../../lib/utils.js";
import { getTableControlState, runTableAction, type TableActionId } from "./TableActions.js";
import { selectionIsContainedInTableCells } from "./TableExtensions.js";

// prettier-ignore
type Action = readonly [TableActionId, MessageDescriptor, Icons.Icon, MessageDescriptor | null, boolean?];
type ControlState = NonNullable<ReturnType<typeof getTableControlState>>;
type ControlProps = { editor: Editor; editable?: boolean; onRun?: (label: string) => void };
// prettier-ignore
const GROUPS: ReadonlyArray<readonly [MessageDescriptor, readonly Action[]]> = [
	[msg`Selection`, [["select-row", msg`Select row`, Icons.Rows, null], ["select-column", msg`Select column`, Icons.Columns, null], ["select-table", msg`Select table`, Icons.SelectionAll, null]]],
	[msg`Rows`, [["add-row-before", msg`Add row above`, Icons.RowsPlusTop, msg`Row added above`], ["add-row-after", msg`Add row below`, Icons.RowsPlusBottom, msg`Row added below`], ["delete-row", msg`Delete row`, Icons.Rows, null]]],
	[msg`Columns`, [["add-column-before", msg`Add column before`, Icons.ColumnsPlusLeft, msg`Column added before`, true], ["add-column-after", msg`Add column after`, Icons.ColumnsPlusRight, msg`Column added after`, true], ["delete-column", msg`Delete column`, Icons.Columns, null]]],
	[msg`Headers`, [["header-row", msg`Toggle header row`, Icons.Table, null], ["header-column", msg`Toggle header column`, Icons.Table, null]]],
	[msg`Cells`, [["merge", msg`Merge selected cells`, Icons.Union, msg`Cells merged`], ["split", msg`Split merged cell`, Icons.Intersect, msg`Cell split`]]],
	[msg`Widths`, [["decrease-width", msg`Decrease column width`, Icons.ArrowsInLineHorizontal, msg`Column width decreased`], ["increase-width", msg`Increase column width`, Icons.ArrowsOutLineHorizontal, msg`Column width increased`], ["distribute-widths", msg`Distribute columns evenly`, Icons.ArrowsHorizontal, msg`Columns distributed evenly`], ["reset-widths", msg`Reset column widths`, Icons.Columns, msg`Column widths reset`]]],
		[msg`Document`, [["paragraph-before", msg`Insert paragraph before`, Icons.Paragraph, msg`Paragraph inserted before table`], ["paragraph-after", msg`Insert paragraph after`, Icons.Paragraph, msg`Paragraph inserted after table`]]],
	[msg`Table`, [["delete-table", msg`Delete table`, Icons.Trash, msg`Table deleted`]]],
];
const SIZES = Array.from({ length: 10 }, (_, index) => index + 1);
const SIZE_ITEMS = Object.fromEntries(SIZES.map((size) => [String(size), size]));
const MENU_CLASS =
	"emdash-table-menu max-h-[min(28rem,50dvh)] max-w-[calc(100vw-1rem)] overflow-y-auto text-sm motion-reduce:animate-none motion-reduce:transition-none";

export function insertTable(
	editor: Editor,
	rows: number,
	columns: number,
	withHeaderRow: boolean,
	range?: Range,
	insertPosition?: number,
): boolean {
	const chain = editor
		.chain()
		.focus()
		.command(({ tr }) => {
			closeHistory(tr);
			return true;
		});
	if (insertPosition !== undefined)
		chain
			.insertContentAt(insertPosition, { type: "paragraph" })
			.setTextSelection(insertPosition + 1);
	else if (range) chain.deleteRange(range);
	chain.command(({ tr }) => {
		const nested = Array.from(
			{ length: tr.selection.$from.depth },
			(_, index) => tr.selection.$from.node(index + 1).type.name,
		).some((name) => name === "blockquote" || name === "listItem");
		if (nested) {
			const position = tr.selection.$from.after(1);
			tr.insert(position, tr.doc.type.schema.nodes.paragraph!.create());
			tr.setSelection(TextSelection.create(tr.doc, position + 1));
		}
		return true;
	});
	return chain
		.insertTable({ rows, cols: columns, withHeaderRow })
		.command(({ tr }) => {
			const cell = cellAround(tr.selection.$from);
			if (cell && cell.after(-1) === tr.doc.content.size)
				tr.insert(cell.after(-1), tr.doc.type.schema.nodes.paragraph!.create());
			return true;
		})
		.run();
}

export function TableSizePicker({
	onInsert,
	onCancel,
}: {
	onInsert: (rows: number, columns: number, withHeaderRow: boolean) => void;
	onCancel: () => void;
}) {
	const { t } = useLingui();
	const [rows, setRows] = React.useState(1);
	const [columns, setColumns] = React.useState(1);
	const [withHeaderRow, setWithHeaderRow] = React.useState(true);
	const [hovered, setHovered] = React.useState<readonly [number, number] | null>(null);
	const coarse = matchMedia("(any-pointer: coarse)").matches;
	const gridRef = React.useRef<HTMLDivElement>(null);
	const coarseRef = React.useRef<HTMLDivElement>(null);
	const activeRef = React.useRef<HTMLButtonElement>(null);
	const refocus = React.useRef(false);
	const move = (row: number, column: number) => {
		setHovered(null);
		setRows(Math.max(1, Math.min(10, row)));
		setColumns(Math.max(1, Math.min(10, column)));
	};
	React.useLayoutEffect(() => {
		if (refocus.current) {
			refocus.current = false;
			activeRef.current?.focus();
		}
	}, [rows, columns]);
	React.useLayoutEffect(() => {
		if (coarse) coarseRef.current?.querySelector<HTMLElement>("button")?.focus();
		else activeRef.current?.focus();
	}, [coarse]);
	const onGridKeyDown = (event: React.KeyboardEvent) => {
		const rtl = getComputedStyle(gridRef.current!).direction === "rtl";
		if (event.key === "Enter" || event.key === " ") onInsert(rows, columns, withHeaderRow);
		else if (event.key === "ArrowUp") move(rows - 1, columns);
		else if (event.key === "ArrowDown") move(rows + 1, columns);
		else if (event.key === "ArrowLeft") move(rows, columns + (rtl ? 1 : -1));
		else if (event.key === "ArrowRight") move(rows, columns + (rtl ? -1 : 1));
		else if (event.key === "Home") move(event.ctrlKey ? 1 : rows, 1);
		else if (event.key === "End") move(event.ctrlKey ? 10 : rows, 10);
		else return;
		refocus.current = true;
		event.preventDefault();
		event.stopPropagation();
	};
	const [previewRows, previewColumns] = hovered ?? [rows, columns];
	return (
		<div
			className="w-fit max-w-full p-3"
			onKeyDown={(event) => {
				if (event.key === "Escape") {
					event.preventDefault();
					onCancel();
				}
			}}
		>
			<p className="mb-2 text-sm font-medium">{t`${previewRows} × ${previewColumns} table`}</p>
			{!coarse && (
				<div
					ref={gridRef}
					role="grid"
					aria-label={t`Table size`}
					aria-multiselectable="true"
					className="flex flex-col gap-0.5"
					onKeyDown={onGridKeyDown}
					onMouseLeave={() => setHovered(null)}
				>
					{SIZES.map((row) => (
						<div key={row} role="row" className="grid grid-cols-10 gap-0.5">
							{SIZES.map((column) => {
								const active = row === rows && column === columns;
								const selected = row <= previewRows && column <= previewColumns;
								const props = {
									ref: active ? activeRef : undefined,
									tabIndex: active ? 0 : -1,
									"aria-selected": selected,
									"aria-label": t`${row} × ${column} table`,
									className: cn(
										"h-6 w-6 rounded-sm border border-kumo-line p-0",
										selected && "bg-kumo-brand text-kumo-inverted",
									),
									onMouseEnter: () => setHovered([row, column] as const),
									onFocus: () => move(row, column),
									onClick: () => onInsert(row, column, withHeaderRow),
								};
								// prettier-ignore
								return <Button key={column} type="button" variant="ghost" shape="square" role="gridcell" {...props} />;
							})}
						</div>
					))}
				</div>
			)}
			{coarse && (
				<div ref={coarseRef} className="min-w-64">
					<div className="grid grid-cols-2 gap-3">
						{/* prettier-ignore */}
						{([t`Rows`, t`Columns`] as const).map((label, index) => <Select key={label} label={label} value={String(index === 0 ? rows : columns)} onValueChange={(value) => (index === 0 ? setRows : setColumns)(Number(value))} items={SIZE_ITEMS} className="min-h-11" />)}
					</div>
				</div>
			)}
			{/* prettier-ignore */}
			<div className="mt-3"><Switch.Item checked={withHeaderRow} onCheckedChange={setWithHeaderRow} label={t`Header row`} className="min-h-11 [&>span]:text-sm [&>span]:font-normal" /></div>
			{/* prettier-ignore */}
			{coarse && <Button type="button" className="min-h-11 w-full" onClick={() => onInsert(rows, columns, withHeaderRow)}>{t`Insert table`}</Button>}
		</div>
	);
}

// prettier-ignore
export function useTableControls(editor: Editor) { return useEditorState({ editor, selector: ({ editor: activeEditor }) => getTableControlState(activeEditor) }); }

export function TableSelectionAnnouncer({
	editor,
	onChange,
}: {
	editor: Editor;
	onChange: (label: string) => void;
}) {
	const { t } = useLingui();
	React.useEffect(() => {
		const announce = ({ transaction }: { transaction: { docChanged: boolean } }) => {
			const state = getTableControlState(editor);
			if (!transaction.docChanged && editor.state.selection instanceof CellSelection && state)
				onChange(
					t`${plural(state.rows, { one: "# row", other: "# rows" })} × ${plural(state.columns, { one: "# column", other: "# columns" })} selected`,
				);
		};
		const announceDeletion = ({ transaction }: { transaction: Transaction }) => {
			const rows: unknown = transaction.getMeta("emdashDeletedTableRows");
			const columns: unknown = transaction.getMeta("emdashDeletedTableColumns");
			if (typeof rows === "number")
				onChange(plural(rows, { one: "Row deleted", other: "# rows deleted" }));
			else if (typeof columns === "number")
				onChange(plural(columns, { one: "Column deleted", other: "# columns deleted" }));
		};
		editor.on("selectionUpdate", announce);
		editor.on("transaction", announceDeletion);
		return () => {
			editor.off("selectionUpdate", announce);
			editor.off("transaction", announceDeletion);
		};
	}, [editor, onChange, t]);
	return null;
}

function ActionMenu({
	editor,
	onRun,
	state,
}: {
	editor: Editor;
	onRun?: (label: string | null) => void;
	state: ControlState;
}) {
	const { t } = useLingui();
	const selected =
		editor.state.selection instanceof CellSelection
			? t`${plural(state.rows, { one: "# row", other: "# rows" })} × ${plural(state.columns, { one: "# column", other: "# columns" })} selected`
			: t`Current cell`;
	const result = ([id, , , descriptor]: Action, changed: boolean) => {
		if (id.startsWith("select-")) return null;
		if (id === "delete-row")
			return plural(state.rows, { one: "Row deleted", other: "# rows deleted" });
		if (id === "delete-column")
			return plural(state.columns, { one: "Column deleted", other: "# columns deleted" });
		if (id === "header-row")
			return state.headerRow === true ? t`Header row removed` : t`Header row added`;
		if (id === "header-column")
			return state.headerColumn === true ? t`Header column removed` : t`Header column added`;
		if (id === "paragraph-before" && !changed) return t`Moved to paragraph before table`;
		if (id === "paragraph-after" && !changed) return t`Moved to paragraph after table`;
		return t(descriptor!);
	};
	return (
		<>
			<div className="px-2 py-1 text-xs text-kumo-subtle">{selected}</div>
			{GROUPS.map(([group, actions], groupIndex) => (
				<React.Fragment key={group.id}>
					{groupIndex > 0 && <DropdownMenu.Separator />}
					<DropdownMenu.Group>
						<DropdownMenu.Label className="text-xs">{t(group)}</DropdownMenu.Label>
						{actions.map((action) => {
							const [id, descriptor, Icon, , rtl] = action;
							const label =
								id === "delete-row" && state.rows > 1
									? t`Delete rows`
									: id === "delete-column" && state.columns > 1
										? t`Delete columns`
										: t(descriptor);
							const run = () => {
								const before = editor.state.doc;
								if (runTableAction(editor, id))
									onRun?.(result(action, !before.eq(editor.state.doc)));
							};
							const itemProps = {
								disabled: !state.can[id],
								onClick: run,
								className: "text-sm transition-none pointer-coarse:min-h-11",
							};
							if (id === "header-row" || id === "header-column") {
								const checked = id === "header-row" ? state.headerRow : state.headerColumn;
								if (checked === "mixed") {
									// prettier-ignore
									return <DropdownMenu.Item key={id} {...itemProps} role="menuitemcheckbox" aria-checked="mixed" className={`${itemProps.className} relative ps-8 pe-2`}><span className="absolute start-2 flex h-3.5 w-3.5 items-center justify-center"><Icons.Minus className="h-3 w-3" aria-hidden="true" /></span>{label}<span className="ms-auto text-xs text-kumo-subtle">{t`Mixed`}</span></DropdownMenu.Item>;
								}
								// prettier-ignore
								return <DropdownMenu.CheckboxItem key={id} {...itemProps} checked={checked} data-emdash-header-checkbox>{label}</DropdownMenu.CheckboxItem>;
							}
							// prettier-ignore
							return <DropdownMenu.Item key={id} {...itemProps} icon={<Icon className={cn("me-2 h-4 w-4", rtl && "rtl:-scale-x-100")} aria-hidden="true" />} variant={id === "delete-table" ? "danger" : "default"}>{label}</DropdownMenu.Item>;
						})}
					</DropdownMenu.Group>
				</React.Fragment>
			))}
		</>
	);
}

type CloseIntent = "focus" | "picker" | "restore";
// prettier-ignore
const tableSelected = (editor: Editor) => selectionIsContainedInTableCells(editor.state) || (editor.state.selection instanceof NodeSelection && editor.state.selection.node.type.spec.tableRole === "table");

function TableMenu({
	editor,
	editable: editableProp,
	more,
	onRun,
}: ControlProps & { more: boolean }) {
	const { t } = useLingui();
	const triggerRef = React.useRef<HTMLButtonElement>(null);
	const bookmarkRef = React.useRef<SelectionBookmark | null>(null);
	const closingFocusRef = React.useRef<Element | null>(null);
	const shortcutReturnRef = React.useRef(false);
	const intentRef = React.useRef<CloseIntent | null>(null);
	const pickerFrameRef = React.useRef(0);
	const [menuOpen, setMenuOpen] = React.useState(false);
	const [pickerOpen, setPickerOpen] = React.useState(false);
	const state = useEditorState({
		editor,
		selector: ({ editor: activeEditor }) => ({
			inTable: tableSelected(activeEditor),
			controls: menuOpen ? getTableControlState(activeEditor) : null,
		}),
	});
	const editable = editableProp ?? editor.isEditable;
	React.useEffect(() => () => cancelAnimationFrame(pickerFrameRef.current), []);
	React.useEffect(() => {
		if (editable) return;
		setMenuOpen(false);
		setPickerOpen(false);
		intentRef.current = null;
		shortcutReturnRef.current = false;
	}, [editable]);
	const restore = React.useCallback(
		(restoreSelection = true) => {
			const active = document.activeElement;
			if (
				editor.view.hasFocus() ||
				(active !== document.body &&
					active !== triggerRef.current &&
					!closingFocusRef.current?.contains(active))
			)
				return;
			try {
				const bookmark = bookmarkRef.current;
				if (restoreSelection && bookmark)
					editor.view.dispatch(editor.state.tr.setSelection(bookmark.resolve(editor.state.doc)));
			} catch {}
			editor.view.focus();
		},
		[editor],
	);
	React.useEffect(() => {
		if (more) return;
		const focusTrigger = (event: KeyboardEvent) => {
			if (event.altKey && event.key === "F10" && editor.view.dom.contains(event.target as Node)) {
				bookmarkRef.current = editor.state.selection.getBookmark();
				shortcutReturnRef.current = true;
				triggerRef.current?.focus();
			} else if (
				event.key === "Escape" &&
				!menuOpen &&
				event.target === triggerRef.current &&
				shortcutReturnRef.current
			) {
				event.preventDefault();
				shortcutReturnRef.current = false;
				restore();
			}
		};
		window.addEventListener("keydown", focusTrigger, true);
		return () => window.removeEventListener("keydown", focusTrigger, true);
	}, [editor, menuOpen, more, restore]);
	if (!editable) return null;
	const finishMenu = () => {
		const intent = intentRef.current;
		intentRef.current = null;
		if (intent === "picker")
			pickerFrameRef.current = requestAnimationFrame(() => setPickerOpen(true));
		else if (intent === "focus") restore(false);
		else if (intent === "restore") restore();
	};
	const title = more ? t`More table actions` : t`Table`;
	return (
		<>
			<DropdownMenu
				modal={false}
				onOpenChange={(open, details) => {
					if (!open)
						closingFocusRef.current =
							document.activeElement?.closest('[role="menu"], [role="dialog"]') ?? null;
					if (open) {
						bookmarkRef.current = editor.state.selection.getBookmark();
						shortcutReturnRef.current = false;
						intentRef.current = null;
					} else if (details.reason === "escape-key" && intentRef.current === null) {
						intentRef.current = "restore";
					}
					setMenuOpen(open);
				}}
				onOpenChangeComplete={(open) => !open && finishMenu()}
			>
				{/* prettier-ignore */}
				<DropdownMenu.Trigger render={<Button ref={triggerRef} type="button" variant="ghost" shape={more ? "square" : undefined} className={more ? "h-8 w-8 pointer-coarse:h-11 pointer-coarse:w-11" : "h-8 min-w-11 flex-none gap-0.5 px-2 hover:bg-kumo-interact/50 pointer-coarse:min-h-11"} onMouseDown={more ? undefined : (event) => event.preventDefault()} onBlur={() => { shortcutReturnRef.current = false; }} aria-label={title} aria-expanded={menuOpen} aria-keyshortcuts={more ? undefined : "Alt+F10"} title={title} data-emdash-table-trigger={more ? undefined : ""}>{more ? <Icons.DotsThree className="h-4 w-4" aria-hidden="true" /> : <><Icons.Table className="h-4 w-4" aria-hidden="true" /><Icons.CaretDown className="h-3 w-3" aria-hidden="true" /></>}</Button>} />
				<DropdownMenu.Content
					align="start"
					positionMethod="fixed"
					collisionAvoidance={{ side: "shift", align: "shift", fallbackAxisSide: "none" }}
					className={cn(MENU_CLASS, more ? "min-w-56" : "min-w-48")}
				>
					{/* prettier-ignore */}
					{more || state.inTable ? state.controls && <ActionMenu editor={editor} state={state.controls} onRun={(label) => { intentRef.current = "focus"; if (label) onRun?.(label); }} /> : <DropdownMenu.Item icon={<Icons.Table className="me-2 h-4 w-4" aria-hidden="true" />} onClick={() => { intentRef.current = "picker"; }} className="text-sm pointer-coarse:min-h-11">{t`Insert table`}</DropdownMenu.Item>}
				</DropdownMenu.Content>
			</DropdownMenu>
			{/* prettier-ignore */}
			{!more && <Popover modal={false} open={pickerOpen} onOpenChange={(open, details) => { if (!open) closingFocusRef.current = document.activeElement?.closest('[role="menu"], [role="dialog"]') ?? null; setPickerOpen(open); if (!open && details.reason === "escape-key" && intentRef.current === null) intentRef.current = "restore"; }} onOpenChangeComplete={(open) => { if (open) return; const intent = intentRef.current; intentRef.current = null; if (intent === "focus") restore(false); else if (intent === "restore") restore(); }}><Popover.Content anchor={triggerRef} align="start" className="w-auto p-0 motion-reduce:animate-none motion-reduce:transition-none"><TableSizePicker onInsert={(rows, columns, header) => { if (insertTable(editor, rows, columns, header)) { intentRef.current = "focus"; setPickerOpen(false); onRun?.(t`Table inserted`); } }} onCancel={() => { closingFocusRef.current = document.activeElement?.closest('[role="dialog"]') ?? null; intentRef.current = "restore"; setPickerOpen(false); }} /></Popover.Content></Popover>}
		</>
	);
}

export function TableToolbarControl(props: ControlProps) {
	return <TableMenu {...props} more={false} />;
}
export function TableMoreMenu(props: ControlProps) {
	return <TableMenu {...props} more />;
}
