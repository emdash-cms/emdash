import { Collapsible } from "@cloudflare/kumo";
import { useState } from "react";

import { BlockRenderer } from "../renderer.js";
import type { AccordionBlock, BlockInteraction, LinkTargetResolver } from "../types.js";

export function AccordionBlockComponent({
	block,
	onAction,
	resolveLinkTarget,
}: {
	block: AccordionBlock;
	onAction: (interaction: BlockInteraction) => void;
	resolveLinkTarget?: LinkTargetResolver;
}) {
	const [open, setOpen] = useState(block.default_open ?? false);

	return (
		<Collapsible.Root open={open} onOpenChange={setOpen} data-testid="collapsible" data-open={open}>
			<Collapsible.DefaultTrigger>{block.label}</Collapsible.DefaultTrigger>
			<Collapsible.DefaultPanel>
				<BlockRenderer
					blocks={block.blocks}
					onAction={onAction}
					resolveLinkTarget={resolveLinkTarget}
				/>
			</Collapsible.DefaultPanel>
		</Collapsible.Root>
	);
}
