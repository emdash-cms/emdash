import type { IconBlock } from "../types.js";

export function IconBlockComponent({ block }: { block: IconBlock }) {
	return (
		<div className="flex flex-col items-start gap-2 rounded-lg border border-kumo-line bg-kumo-base p-4">
			<div className="flex h-10 w-10 items-center justify-center rounded-lg bg-kumo-brand/10 text-kumo-brand">
				<IconDisplay name={block.name} />
			</div>
			<div>
				<div className="text-sm font-semibold text-kumo-default">{block.label}</div>
				{block.description && <p className="mt-1 text-sm text-kumo-subtle">{block.description}</p>}
			</div>
		</div>
	);
}

function IconDisplay({ name }: { name: string }) {
	const iconMap: Record<string, string> = {
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
	return <span className="text-xl">{iconMap[name] ?? "•"}</span>;
}
