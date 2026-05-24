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
		<Collapsible label={block.label} open={open} onOpenChange={setOpen}>
			<BlockRenderer blocks={block.blocks} onAction={onAction} />
		</Collapsible>
	);
}
