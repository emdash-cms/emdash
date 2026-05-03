import { Badge } from "@cloudflare/kumo";

import { renderElement } from "../render-element.js";
import type { BlockInteraction, CardGridBlock } from "../types.js";
import { cn } from "../utils.js";

const COLUMN_CLASSES: Record<NonNullable<CardGridBlock["columns"]>, string> = {
	1: "grid-cols-1",
	2: "grid-cols-1 sm:grid-cols-2",
	3: "grid-cols-1 sm:grid-cols-2 lg:grid-cols-3",
};

export function CardGridBlockComponent({
	block,
	onAction,
}: {
	block: CardGridBlock;
	onAction: (interaction: BlockInteraction) => void;
}) {
	if (block.cards.length === 0 && block.empty_text) {
		return <p className="py-4 text-center text-sm text-kumo-subtle">{block.empty_text}</p>;
	}

	return (
		<div className={cn("grid gap-3", COLUMN_CLASSES[block.columns ?? 3])}>
			{block.cards.map((card, i) => (
				<article
					key={`${card.title}-${i}`}
					className="overflow-hidden rounded-md border border-kumo-line bg-kumo-surface"
				>
					{card.image_url && (
						<img
							src={card.image_url}
							alt={card.image_alt ?? ""}
							className="h-32 w-full object-cover"
						/>
					)}
					<div className="flex h-full flex-col gap-3 p-4">
						<div className="flex items-start justify-between gap-3">
							<div className="min-w-0">
								<h3 className="text-sm font-semibold text-kumo-default">{card.title}</h3>
								{card.meta && <p className="mt-1 text-xs text-kumo-subtle">{card.meta}</p>}
							</div>
							{card.badge && <Badge>{card.badge}</Badge>}
						</div>
						{card.description && <p className="text-sm text-kumo-subtle">{card.description}</p>}
						{card.actions && card.actions.length > 0 && (
							<div className="mt-auto flex flex-wrap gap-2">
								{card.actions.map((action, actionIndex) => (
									<div key={action.action_id ?? actionIndex}>{renderElement(action, onAction)}</div>
								))}
							</div>
						)}
					</div>
				</article>
			))}
		</div>
	);
}
