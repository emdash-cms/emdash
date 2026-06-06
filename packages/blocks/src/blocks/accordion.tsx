import { Collapsible } from "@cloudflare/kumo";
import { useState } from "react";

import { BlockRenderer } from "../renderer.js";
import type { AccordionBlock, BlockInteraction } from "../types.js";

export function AccordionBlockComponent({
	block,
	onAction,
}: {
	block: AccordionBlock;
	onAction: (interaction: BlockInteraction) => void;
}) {
	const [open, setOpen] = useState(block.default_open ?? false);

	return (
		<Collapsible.Root open={open} onOpenChange={setOpen} data-testid="collapsible" data-open={open}>
			<Collapsible.DefaultTrigger>{block.label}</Collapsible.DefaultTrigger>
			<Collapsible.DefaultPanel>
				<BlockRenderer blocks={block.blocks} onAction={onAction} />
			</Collapsible.DefaultPanel>
		</Collapsible.Root>
	);
}
