import { Badge } from "@cloudflare/kumo";

import { renderElement } from "../render-element.js";
import type { BlockInteraction, MediaGridBlock, MediaGridItem } from "../types.js";
import { cn } from "../utils.js";

const columnClass = {
	2: "sm:grid-cols-2",
	3: "sm:grid-cols-2 lg:grid-cols-3",
	4: "sm:grid-cols-2 lg:grid-cols-4",
} as const;

function getSafePreviewSrc(url: string): string | null {
	const trimmed = url.trim();

	if (trimmed.startsWith("//")) return null;
	if (trimmed.startsWith("/")) return trimmed;

	try {
		const parsed = new URL(trimmed);
		return parsed.protocol === "http:" || parsed.protocol === "https:" ? trimmed : null;
	} catch {
		return null;
	}
}

function MediaGridItemCard({
	item,
	onAction,
}: {
	item: MediaGridItem;
	onAction: (interaction: BlockInteraction) => void;
}) {
	const previewSrc = getSafePreviewSrc(item.url);

	return (
		<article className="overflow-hidden rounded-lg border border-kumo-line bg-kumo-base">
			<div className="aspect-video bg-kumo-tint">
				{previewSrc ? (
					<img src={previewSrc} alt={item.alt} className="h-full w-full object-cover" />
				) : (
					<div className="flex h-full items-center justify-center px-4 text-center text-sm text-kumo-subtle">
						Preview unavailable
					</div>
				)}
			</div>
			{(item.badge || item.title || item.description || item.actions?.length) && (
				<div className="space-y-3 p-4">
					{item.badge && <Badge>{item.badge}</Badge>}
					{(item.title || item.description) && (
						<div className="space-y-1">
							{item.title && <h3 className="font-medium text-kumo-default">{item.title}</h3>}
							{item.description && <p className="text-sm text-kumo-subtle">{item.description}</p>}
						</div>
					)}
					{item.actions && item.actions.length > 0 && (
						<div className="flex flex-wrap gap-2">
							{item.actions.map((action, i) => (
								<div key={action.action_id ?? i}>{renderElement(action, onAction)}</div>
							))}
						</div>
					)}
				</div>
			)}
		</article>
	);
}

export function MediaGridBlockComponent({
	block,
	onAction,
}: {
	block: MediaGridBlock;
	onAction: (interaction: BlockInteraction) => void;
}) {
	if (block.items.length === 0 && block.empty_text) {
		return <p className="py-4 text-center text-sm text-kumo-subtle">{block.empty_text}</p>;
	}

	return (
		<div className={cn("grid gap-4", columnClass[block.columns ?? 3])}>
			{block.items.map((item, i) => (
				<MediaGridItemCard key={`${item.url}:${i}`} item={item} onAction={onAction} />
			))}
		</div>
	);
}
