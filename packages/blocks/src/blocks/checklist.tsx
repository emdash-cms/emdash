import { CheckCircle, Circle, WarningCircle, XCircle } from "@phosphor-icons/react";

import { renderElement } from "../render-element.js";
import type { BlockInteraction, ChecklistBlock, ChecklistItem } from "../types.js";
import { cn } from "../utils.js";

const statusConfig = {
	pending: {
		icon: Circle,
		color: "text-kumo-subtle",
		marker: "border-kumo-line bg-kumo-tint",
	},
	complete: {
		icon: CheckCircle,
		color: "text-kumo-success",
		marker: "border-kumo-success/30 bg-kumo-success/10",
	},
	warning: {
		icon: WarningCircle,
		color: "text-kumo-warning",
		marker: "border-kumo-warning/30 bg-kumo-warning/10",
	},
	error: {
		icon: XCircle,
		color: "text-kumo-danger",
		marker: "border-kumo-danger/30 bg-kumo-danger/10",
	},
} as const;

function getChecklistItemKey(item: ChecklistItem, index: number): string {
	return [item.label, item.status, item.action?.action_id ?? "", index].join(":");
}

function ChecklistRow({
	item,
	onAction,
}: {
	item: ChecklistItem;
	onAction: (interaction: BlockInteraction) => void;
}) {
	const status = statusConfig[item.status];
	const StatusIcon = status.icon;

	return (
		<li className="flex gap-3 rounded-lg border border-kumo-line p-3">
			<div
				role="img"
				aria-label={item.status}
				className={cn(
					"mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full border",
					status.marker,
					status.color,
				)}
			>
				<StatusIcon
					aria-hidden="true"
					size={18}
					weight={item.status === "pending" ? "regular" : "fill"}
				/>
			</div>
			<div className="min-w-0 flex-1">
				<div className="font-medium text-kumo-default">{item.label}</div>
				{item.description && (
					<div className="mt-1 text-sm text-kumo-subtle">{item.description}</div>
				)}
				{item.action && <div className="mt-3">{renderElement(item.action, onAction)}</div>}
			</div>
		</li>
	);
}

export function ChecklistBlockComponent({
	block,
	onAction,
}: {
	block: ChecklistBlock;
	onAction: (interaction: BlockInteraction) => void;
}) {
	return (
		<div className="rounded-lg border border-kumo-line p-4">
			{(block.title || block.description) && (
				<div className="mb-4">
					{block.title && <h3 className="font-semibold text-kumo-default">{block.title}</h3>}
					{block.description && (
						<p className="mt-1 text-sm text-kumo-subtle">{block.description}</p>
					)}
				</div>
			)}
			<ul className="flex flex-col gap-2">
				{block.items.map((item, i) => (
					<ChecklistRow key={getChecklistItemKey(item, i)} item={item} onAction={onAction} />
				))}
			</ul>
		</div>
	);
}
