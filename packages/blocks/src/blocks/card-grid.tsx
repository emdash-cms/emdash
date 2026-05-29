import { CardItemView } from "./card.js";
import type { CardGridBlock } from "../types.js";

const columnsClass: Record<2 | 3 | 4, string> = {
	2: "sm:grid-cols-2",
	3: "sm:grid-cols-2 lg:grid-cols-3",
	4: "sm:grid-cols-2 lg:grid-cols-4",
};

export function CardGridBlockComponent({ block }: { block: CardGridBlock }) {
	const columns = block.columns ?? 3;

	return (
		<section className="space-y-4">
			{(block.title || block.description) && (
				<div>
					{block.title && <h2 className="text-xl font-semibold text-kumo-default">{block.title}</h2>}
					{block.description && (
						<p className="mt-2 text-sm leading-6 text-kumo-subtle">{block.description}</p>
					)}
				</div>
			)}
			<div className={`grid gap-4 ${columnsClass[columns]}`}>
				{block.items.map((item, index) => (
					<CardItemView key={`${item.title}-${index}`} item={item} />
				))}
			</div>
		</section>
	);
}
