import type { LogoCloudBlock, LogoCloudItem } from "../types.js";

export function LogoCloudBlockComponent({ block }: { block: LogoCloudBlock }) {
	return (
		<section className="space-y-4">
			{block.title && <h2 className="text-xl font-semibold text-kumo-default">{block.title}</h2>}
			{block.items.length > 0 ? (
				<div className="flex flex-wrap gap-6 items-center justify-center">
					{block.items.map((item, index) => (
						<LogoItem key={`${item.name}-${index}`} item={item} />
					))}
				</div>
			) : (
				<div className="rounded border border-dashed border-kumo-line bg-kumo-tint/40 p-4 text-sm text-kumo-subtle">
					No logos
				</div>
			)}
		</section>
	);
}

function LogoItem({ item }: { item: LogoCloudItem }) {
	const content = (
		<img
			src={item.logoUrl}
			alt={item.name}
			className="max-h-12 w-auto object-contain"
			loading="lazy"
		/>
	);

	if (item.url) {
		return (
			<a
				href={item.url}
				target="_blank"
				rel="noopener noreferrer"
				className="flex items-center text-kumo-subtle hover:text-kumo-default transition-colors"
			>
				{content}
			</a>
		);
	}

	return <div className="flex items-center">{content}</div>;
}
