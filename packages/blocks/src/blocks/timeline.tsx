import { renderElement } from "../render-element.js";
import type { BlockInteraction, TimelineBlock, TimelineItem } from "../types.js";
import { cn } from "../utils.js";

const statusDotClasses: Record<NonNullable<TimelineItem["status"]>, string> = {
	default: "border-kumo-line bg-kumo-tint",
	success: "border-kumo-success bg-kumo-success",
	warning: "border-kumo-warning bg-kumo-warning",
	error: "border-kumo-danger bg-kumo-danger",
};

export function TimelineBlockComponent({
	block,
	onAction,
}: {
	block: TimelineBlock;
	onAction: (interaction: BlockInteraction) => void;
}) {
	if (block.items.length === 0) {
		return block.empty_text ? (
			<p className="py-4 text-center text-sm text-kumo-subtle">{block.empty_text}</p>
		) : null;
	}

	return (
		<ol className="ms-3 border-s border-kumo-line">
			{block.items.map((item, i) => (
				<li key={i} className="relative pb-5 ps-6 last:pb-0">
					<span
						aria-hidden="true"
						className={cn(
							"absolute start-[-0.4375rem] top-1.5 h-3.5 w-3.5 rounded-full border-2",
							statusDotClasses[item.status ?? "default"],
						)}
					/>
					<div className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4">
						<h3 className="font-medium text-kumo-default">{item.title}</h3>
						<time className="shrink-0 text-sm text-kumo-subtle" dateTime={item.timestamp}>
							{item.timestamp}
						</time>
					</div>
					{item.description && <p className="mt-1 text-sm text-kumo-subtle">{item.description}</p>}
					{item.actions && item.actions.length > 0 && (
						<div className="mt-3 flex flex-wrap gap-2">
							{item.actions.map((action, actionIndex) => (
								<div key={action.action_id ?? actionIndex}>{renderElement(action, onAction)}</div>
							))}
						</div>
					)}
				</li>
			))}
		</ol>
	);
}
