import { Badge } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import * as React from "react";

import type { DiffFieldDescriptor, FieldDiff, ItemRow } from "../../lib/revision-diff/types.js";
import { markAttributes } from "./revision-blocks.js";
import { revisionTargetElementId } from "./revision-format.js";

export type RenderItemField = (
	field: FieldDiff,
	descriptor: DiffFieldDescriptor | undefined,
	marked: boolean,
) => React.ReactNode;

/** The first text the item holds, in field order, as the editor's cards show it. */
function itemSummary(row: ItemRow): string | null {
	for (const field of row.fields) {
		const value = row.value[field.slug];
		if (typeof value === "string" && value.trim()) return value.trim();
	}
	return null;
}

const ItemCard = React.memo(function ItemCard({
	row,
	repeater,
	marked,
	renderField,
}: {
	row: ItemRow;
	repeater: boolean;
	marked: boolean;
	renderField: RenderItemField;
}) {
	const { t } = useLingui();
	const summary = itemSummary(row);
	const label = row.label ?? t`Item ${row.position}`;
	const removed = marked && row.status === "removed";
	const targetProps =
		row.status === "unchanged" && !row.moved
			? {}
			: { id: revisionTargetElementId(row.targetId), tabIndex: -1 };

	const badges: string[] = [];
	if (marked) {
		if (row.status === "added") badges.push(t`Added`);
		if (row.status === "removed") badges.push(t`Removed`);
		if (row.status === "changed") badges.push(repeater ? t`Changed` : t`Edited`);
		if (row.moved) badges.push(t`Moved`);
	}

	return (
		<section
			{...targetProps}
			className="rounded-lg border border-kumo-line bg-kumo-control"
			{...markAttributes({ ring: marked && row.status === "added", dim: removed })}
		>
			<div className="min-w-0 p-3">
				<div className="flex flex-wrap items-center gap-2">
					<span className="min-w-0 wrap-break-word font-medium" dir="auto">
						{removed ? <del>{label}</del> : label}
					</span>
					{badges.map((badge) => (
						<Badge key={badge} variant="secondary">
							{badge}
						</Badge>
					))}
				</div>
				{summary && summary !== label && (
					<p dir="auto" className="w-fit max-w-full truncate text-xs text-kumo-subtle">
						{summary}
					</p>
				)}
			</div>
			{row.fields.length > 0 && (
				<div className="space-y-4 border-t border-kumo-line p-4">
					{row.fields.map((field) => (
						<React.Fragment key={field.slug}>
							{renderField(
								field,
								row.descriptors[field.slug],
								marked && row.status === "changed" && field.status !== "unchanged",
							)}
						</React.Fragment>
					))}
				</div>
			)}
		</section>
	);
});

/**
 * A blocks or repeater field as cards like the editor's, each showing its fields. Added, removed
 * and moved items are marked on the card, and edits inside the fields that changed.
 */
export function RevisionItems({
	kind,
	rows,
	marked,
	renderField,
}: {
	/** `blocks` or `repeater`. */
	kind: string;
	rows: readonly ItemRow[];
	marked: boolean;
	renderField: RenderItemField;
}) {
	const { t } = useLingui();
	const visible = marked ? rows : rows.filter((row) => row.status !== "removed");
	if (visible.length === 0) {
		return (
			<p className="rounded-lg border border-dashed border-kumo-line p-6 text-center text-sm text-kumo-subtle">
				{kind === "blocks" ? t`No blocks yet` : t`No items yet`}
			</p>
		);
	}
	return (
		<div className="space-y-3">
			{visible.map((row) => (
				<ItemCard
					key={row.targetId}
					row={row}
					repeater={kind === "repeater"}
					marked={row.status === "unchanged" && !row.moved ? false : marked}
					renderField={renderField}
				/>
			))}
		</div>
	);
}
