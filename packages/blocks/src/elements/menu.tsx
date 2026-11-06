import { Button, DropdownMenu } from "@cloudflare/kumo";
import { CaretDown } from "@phosphor-icons/react";

import type { BlockInteraction, MenuElement } from "../types.js";

export function MenuElementComponent({
	element,
	onAction,
}: {
	element: MenuElement;
	onAction: (interaction: BlockInteraction) => void;
}) {
	return (
		<DropdownMenu>
			<DropdownMenu.Trigger
				render={
					<Button type="button" variant={element.style === "primary" ? "primary" : "secondary"}>
						{element.label}
						<CaretDown className="size-3.5" aria-hidden="true" />
					</Button>
				}
			/>
			<DropdownMenu.Content>
				{element.items.map((item) => (
					<DropdownMenu.Item
						key={item.value}
						onClick={() =>
							onAction({ type: "block_action", action_id: element.action_id, value: item.value })
						}
					>
						{item.label}
					</DropdownMenu.Item>
				))}
			</DropdownMenu.Content>
		</DropdownMenu>
	);
}
