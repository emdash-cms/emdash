import { Collapsible } from "@cloudflare/kumo";
import * as React from "react";
import { useState } from "react";

import type { FaqBlock } from "../types.js";

export function FaqBlockComponent({ block }: { block: FaqBlock }) {
	return (
		<div className="flex flex-col gap-3">
			{block.items.map((item, index) => (
				<FaqItemAccordion key={`faq-${index}`} item={item} index={index} />
			))}
		</div>
	);
}

function FaqItemAccordion({
	item,
	index,
}: {
	item: { question: string; answer: string };
	index: number;
}) {
	const [open, setOpen] = useState(false);

	return (
		<Collapsible.Root
			open={open}
			onOpenChange={setOpen}
			data-testid="faq-collapsible"
			data-open={open}
		>
			<Collapsible.DefaultTrigger className="flex w-full cursor-pointer list-none items-center justify-between rounded-lg border border-kumo-line bg-kumo-tint/50 px-4 py-3 text-start text-sm font-medium text-kumo-default hover:bg-kumo-tint">
				<span>{item.question || `Question ${index + 1}`}</span>
				<span className="text-kumo-subtle transition-transform group-open:rotate-180">
					<svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
						<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
					</svg>
				</span>
			</Collapsible.DefaultTrigger>
			<Collapsible.DefaultPanel className="rounded-b-lg border border-t-0 border-kumo-line bg-kumo-base px-4 py-3">
				<p className="text-sm leading-7 text-kumo-default">{item.answer}</p>
			</Collapsible.DefaultPanel>
		</Collapsible.Root>
	);
}
