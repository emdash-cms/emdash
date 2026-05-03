import { Badge } from "@cloudflare/kumo";

import { renderElement } from "../render-element.js";
import type { BlockInteraction, ItemListBlock } from "../types.js";
import { cn } from "../utils.js";

const HAS_SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;
const HTTP_URL_RE = /^https?:\/\//i;

function isSafePreviewUrl(url: string): boolean {
	if (!url) return false;
	if (HAS_SCHEME_RE.test(url)) {
		return HTTP_URL_RE.test(url);
	}
	return url.startsWith("/") && !url.startsWith("//");
}

export function ItemListBlockComponent({
	block,
	onAction,
}: {
	block: ItemListBlock;
	onAction: (interaction: BlockInteraction) => void;
}) {
	if (block.items.length === 0 && block.empty_text) {
		return <p className="py-4 text-center text-sm text-kumo-subtle">{block.empty_text}</p>;
	}

	const compact = block.density === "compact";

	return (
		<div className="divide-y divide-kumo-line rounded-md border border-kumo-line bg-kumo-surface">
			{block.items.map((item, i) => {
				const canPreviewAvatar = item.avatar_url ? isSafePreviewUrl(item.avatar_url) : false;
				return (
					<div
						key={`${item.title}-${i}`}
						className={cn("flex items-start gap-3", compact ? "p-3" : "p-4")}
					>
						{canPreviewAvatar ? (
							<img
								src={item.avatar_url}
								alt=""
								className="h-9 w-9 shrink-0 rounded-md object-cover"
								referrerPolicy="no-referrer"
								loading="lazy"
							/>
						) : item.icon ? (
							<div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-kumo-muted text-xs font-medium text-kumo-subtle">
								{item.icon}
							</div>
						) : null}
						<div className="min-w-0 flex-1">
							<div className="flex flex-wrap items-center gap-2">
								<h3 className="text-sm font-semibold text-kumo-default">{item.title}</h3>
								{item.badge && <Badge>{item.badge}</Badge>}
								{item.meta && <span className="text-xs text-kumo-subtle">{item.meta}</span>}
							</div>
							{item.description && (
								<p className={cn("text-sm text-kumo-subtle", compact ? "mt-0.5" : "mt-1")}>
									{item.description}
								</p>
							)}
							{item.actions && item.actions.length > 0 && (
								<div className={cn("flex flex-wrap gap-2", compact ? "mt-2" : "mt-3")}>
									{item.actions.map((action, actionIndex) => (
										<div key={action.action_id ?? actionIndex}>{renderElement(action, onAction)}</div>
									))}
								</div>
							)}
						</div>
					</div>
				);
			})}
		</div>
	);
}
