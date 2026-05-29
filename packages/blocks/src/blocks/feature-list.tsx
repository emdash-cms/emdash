import type { FeatureListBlock, FeatureListItem } from "../types.js";

const FEATURE_ICON_MAP: Record<string, string> = {
	star: "★",
	check: "✓",
	lightning: "⚡",
	gear: "⚙",
	users: "👥",
	clock: "🕐",
	bell: "🔔",
	shield: "🛡",
	chart: "📊",
	heart: "♥",
	flag: "🚩",
	target: "◎",
	key: "🔑",
	lock: "🔒",
	globe: "🌐",
};

function resolveIcon(iconKey?: string): string {
	return FEATURE_ICON_MAP[iconKey ?? ""] ?? "•";
}

export function FeatureListBlockComponent({ block }: { block: FeatureListBlock }) {
	const columns = block.columns ?? 3;
	const columnClass =
		columns === 2 ? "sm:grid-cols-2" : columns === 4 ? "sm:grid-cols-2 lg:grid-cols-4" : "sm:grid-cols-2 lg:grid-cols-3";

	return (
		<section className="space-y-4">
			{(block.title || block.description) && (
				<div>
					{block.title && <h2 className="text-xl font-semibold text-kumo-default">{block.title}</h2>}
					{block.description && <p className="mt-2 text-sm text-kumo-subtle">{block.description}</p>}
				</div>
			)}
			{block.items.length > 0 ? (
				<div className={`grid gap-4 ${columnClass}`}>
					{block.items.map((item, index) => (
						<FeatureItem key={`${item.title}-${index}`} item={item} />
					))}
				</div>
			) : (
				<div className="rounded border border-dashed border-kumo-line bg-kumo-tint/40 p-4 text-sm text-kumo-subtle">
					No features
				</div>
			)}
		</section>
	);
}

function FeatureItem({ item }: { item: FeatureListItem }) {
	return (
		<div className="flex gap-4 rounded-lg border border-kumo-line bg-kumo-base p-4">
			<div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg bg-kumo-brand/10 text-kumo-brand">
				<span className="text-xl">{resolveIcon(item.icon)}</span>
			</div>
			<div className="min-w-0 flex-1">
				<h3 className="text-sm font-semibold text-kumo-default">{item.title}</h3>
				{item.description && (
					<p className="mt-1 text-sm leading-5 text-kumo-subtle">{item.description}</p>
				)}
			</div>
		</div>
	);
}
