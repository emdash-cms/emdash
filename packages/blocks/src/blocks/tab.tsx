import { Tabs } from "@cloudflare/kumo";
import { useState } from "react";

import { BlockRenderer } from "../renderer.js";
import type { BlockInteraction, TabBlock } from "../types.js";

export function TabBlockComponent({
	block,
	onAction,
}: {
	block: TabBlock;
	onAction: (interaction: BlockInteraction) => void;
}) {
	const [activeTab, setActiveTab] = useState(block.default_tab ?? 0);
	const tabs = block.panels.map((panel, i) => ({ value: String(i), label: panel.label }));

	return (
		<div>
			<Tabs
				variant="underline"
				value={String(activeTab)}
				onValueChange={(value) => setActiveTab(Number(value))}
				tabs={tabs}
			/>
			<div className="pt-4">
				<BlockRenderer blocks={block.panels[activeTab]?.blocks ?? []} onAction={onAction} />
			</div>
		</div>
	);
}
