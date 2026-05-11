import { Empty } from "@cloudflare/kumo";
import { Package } from "@phosphor-icons/react";

import { renderElement } from "../render-element.js";
import type { BlockInteraction, EmptyBlock } from "../types.js";

export function EmptyBlockComponent({
	block,
	onAction,
}: {
	block: EmptyBlock;
	onAction: (interaction: BlockInteraction) => void;
}) {
	const contents =
		block.actions && block.actions.length > 0 ? (
			<div className="flex flex-wrap justify-center gap-2">
				{block.actions.map((el, i) => (
					<div key={el.action_id ?? i}>{renderElement(el, onAction)}</div>
				))}
			</div>
		) : undefined;

	return (
		<Empty
			icon={<Package size={48} weight="duotone" />}
			title={block.title}
			description={block.description}
			commandLine={block.command_line}
			size={block.size}
			contents={contents}
		/>
	);
}
