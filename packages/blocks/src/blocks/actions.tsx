import { renderElement } from "../render-element.js";
import type { ActionsBlock, BlockInteraction, LinkTargetResolver } from "../types.js";

export function ActionsBlockComponent({
	block,
	onAction,
	resolveLinkTarget,
}: {
	block: ActionsBlock;
	onAction: (interaction: BlockInteraction) => void;
	resolveLinkTarget?: LinkTargetResolver;
}) {
	return (
		<div className="flex flex-wrap gap-2">
			{block.elements.map((el, i) => (
				<div key={"action_id" in el ? el.action_id : i}>
					{renderElement(el, onAction, undefined, resolveLinkTarget)}
				</div>
			))}
		</div>
	);
}
