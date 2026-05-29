import type { TestimonialBlock, TestimonialItem } from "../types.js";

function TestimonialCard({ item }: { item: TestimonialItem }) {
	return (
		<figure className="rounded-lg border border-kumo-line bg-kumo-base p-5">
			<blockquote className="text-base leading-relaxed text-kumo-default">{item.quote}</blockquote>
			<figcaption className="mt-4 flex items-center gap-3">
				{item.avatar && (
					<img src={item.avatar} alt={item.author} className="h-10 w-10 rounded-full object-cover" />
				)}
				<div>
					<div className="text-sm font-medium text-kumo-default">{item.author}</div>
					{(item.title || item.company) && (
						<div className="text-sm text-kumo-subtle">
							{item.title}
							{item.title && item.company && ", "}
							{item.company}
						</div>
					)}
				</div>
			</figcaption>
		</figure>
	);
}

export function TestimonialBlockComponent({ block }: { block: TestimonialBlock }) {
	return (
		<div className="grid gap-4 sm:grid-cols-2">
			{block.items.map((item, index) => (
				<TestimonialCard key={`${item.author}-${index}`} item={item} />
			))}
		</div>
	);
}
