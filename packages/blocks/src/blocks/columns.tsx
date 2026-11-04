import { BlockRenderer } from "../renderer.js";
import type { BlockInteraction, ColumnsBlock, LinkTargetResolver } from "../types.js";

export function ColumnsBlockComponent({
	block,
	onAction,
	resolveLinkTarget,
}: {
	block: ColumnsBlock;
	onAction: (interaction: BlockInteraction) => void;
	resolveLinkTarget?: LinkTargetResolver;
}) {
	const colCount = Math.min(block.columns.length, 3);
	const gridClass = colCount === 2 ? "grid grid-cols-2 gap-4" : "grid grid-cols-3 gap-4";

	return (
		<div className={gridClass}>
			{block.columns.map((col, i) => (
				<div key={i}>
					<BlockRenderer blocks={col} onAction={onAction} resolveLinkTarget={resolveLinkTarget} />
				</div>
			))}
		</div>
	);
}
