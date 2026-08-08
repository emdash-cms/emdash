import { AccordionBlockComponent } from "./blocks/accordion.js";
import { ActionsBlockComponent } from "./blocks/actions.js";
import { BannerBlockComponent } from "./blocks/banner.js";
import { CardGridBlockComponent } from "./blocks/card-grid.js";
import { ChartBlockComponent } from "./blocks/chart.js";
import { CodeBlockComponent } from "./blocks/code.js";
import { ColumnsBlockComponent } from "./blocks/columns.js";
import { ContextBlockComponent } from "./blocks/context.js";
import { DividerBlockComponent } from "./blocks/divider.js";
import { EmptyBlockComponent } from "./blocks/empty.js";
import { FieldsBlockComponent } from "./blocks/fields.js";
import { FormBlockComponent } from "./blocks/form.js";
import { HeaderBlockComponent } from "./blocks/header.js";
import { ImageBlockComponent } from "./blocks/image.js";
import { MeterBlockComponent } from "./blocks/meter.js";
import { SectionBlockComponent } from "./blocks/section.js";
import { StatsBlockComponent } from "./blocks/stats.js";
import { TabBlockComponent } from "./blocks/tab.js";
import { TableBlockComponent } from "./blocks/table.js";
import type { Block, BlockInteraction } from "./types.js";

function renderBlock(
	block: Block,
	onAction: (interaction: BlockInteraction) => void,
): React.ReactNode {
	switch (block.type) {
		case "header":
			return <HeaderBlockComponent block={block} />;
		case "section":
			return <SectionBlockComponent block={block} onAction={onAction} />;
		case "divider":
			return <DividerBlockComponent />;
		case "fields":
			return <FieldsBlockComponent block={block} />;
		case "table":
			return <TableBlockComponent block={block} onAction={onAction} />;
		case "actions":
			return <ActionsBlockComponent block={block} onAction={onAction} />;
		case "stats":
			return <StatsBlockComponent block={block} />;
		case "form":
			return <FormBlockComponent block={block} onAction={onAction} />;
		case "image":
			return <ImageBlockComponent block={block} />;
		case "context":
			return <ContextBlockComponent block={block} />;
		case "columns":
			return <ColumnsBlockComponent block={block} onAction={onAction} />;
		case "chart":
			return <ChartBlockComponent block={block} />;
		case "meter":
			return <MeterBlockComponent block={block} />;
		case "banner":
			return <BannerBlockComponent block={block} />;
		case "code":
			return <CodeBlockComponent block={block} />;
		case "tab":
			return <TabBlockComponent block={block} onAction={onAction} />;
		case "empty":
			return <EmptyBlockComponent block={block} onAction={onAction} />;
		case "accordion":
			return <AccordionBlockComponent block={block} onAction={onAction} />;
		case "card_grid":
			return <CardGridBlockComponent block={block} onAction={onAction} />;
		default: {
			const _exhaustive: never = block;
			return null;
		}
	}
}

export interface BlockRendererProps {
	blocks: Block[];
	onAction: (interaction: BlockInteraction) => void;
}

export function BlockRenderer({ blocks, onAction }: BlockRendererProps) {
	return (
		<div className="flex flex-col gap-4">
			{blocks.map((block, i) => (
				<div key={block.block_id ?? i}>{renderBlock(block, onAction)}</div>
			))}
		</div>
	);
}
