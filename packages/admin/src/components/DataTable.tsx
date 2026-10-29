import { Button, DropdownMenu, Table } from "@cloudflare/kumo";
import { DotsThree } from "@phosphor-icons/react";
import type * as React from "react";

import { cn } from "../lib/utils.js";

/**
 * A Kumo table laid out like a LayerCard: the header row sits on the tinted
 * outer layer and the rows on a raised card inside it. Cell padding, background
 * and borders come from the table, so a class on a single cell can't change them.
 */
export function DataTable({ className, children, ...props }: React.ComponentProps<typeof Table>) {
	return (
		<div className="overflow-x-auto rounded-xl bg-kumo-elevated ring ring-kumo-line">
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
					"[&_tbody_tr:first-child_td]:border-t",
					"[&_tbody_tr:first-child_td:first-child]:rounded-ss-xl [&_tbody_tr:first-child_td:last-child]:rounded-se-xl",
					className,
				)}
			>
				{children}
			</Table>
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
