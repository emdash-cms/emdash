import type { CardBlock, CardItem } from "../types.js";

export function CardBlockComponent({ block }: { block: CardBlock }) {
	return <CardItemView item={block} />;
}

export function CardItemView({ item }: { item: CardItem }) {
	const href = item.ctaUrl || "";

	return (
		<article className="overflow-hidden rounded-lg border border-kumo-line bg-kumo-base">
			{item.image && (
				<img
					src={item.image}
					alt={item.title}
					className="h-40 w-full object-cover"
					loading="lazy"
				/>
			)}
			<div className="p-5">
				<h3 className="text-base font-semibold text-kumo-default">{item.title}</h3>
				{item.description && (
					<p className="mt-2 text-sm leading-6 text-kumo-subtle">{item.description}</p>
				)}
				{item.ctaText && href && (
					<a href={href} className="mt-4 inline-flex text-sm font-medium text-kumo-brand">
						{item.ctaText}
					</a>
				)}
			</div>
		</article>
	);
}
