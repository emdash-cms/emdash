import type { StepItem, StepsBlock } from "../types.js";

const STEP_ICON_MAP: Record<string, string> = {
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
	return STEP_ICON_MAP[iconKey ?? ""] ?? "•";
}

export function StepsBlockComponent({ block }: { block: StepsBlock }) {
	return (
		<section className="space-y-4">
			{block.title && <h2 className="text-xl font-semibold text-kumo-default">{block.title}</h2>}
			{block.items.length > 0 ? (
				<ol className="relative border-s-2 border-kumo-line ps-6 space-y-6">
					{block.items.map((item, index) => (
						<StepItemView key={`${item.title}-${index}`} item={item} index={index} />
					))}
				</ol>
			) : (
				<div className="rounded border border-dashed border-kumo-line bg-kumo-tint/40 p-4 text-sm text-kumo-subtle">
					No steps
				</div>
			)}
		</section>
	);
}

function StepItemView({ item, index }: { item: StepItem; index: number }) {
	return (
		<li className="relative">
			<div className="absolute -start-3 flex h-6 w-6 items-center justify-center rounded-full bg-kumo-brand text-white text-xs font-bold">
				{index + 1}
			</div>
			<div className="flex gap-3">
				{item.icon && (
					<span className="mt-0.5 text-lg text-kumo-brand">{resolveIcon(item.icon)}</span>
				)}
				<div>
					<h3 className="text-base font-semibold text-kumo-default">{item.title}</h3>
					{item.description && (
						<p className="mt-1 text-sm text-kumo-subtle">{item.description}</p>
					)}
				</div>
			</div>
		</li>
	);
}
