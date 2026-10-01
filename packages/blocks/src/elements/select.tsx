import { Select } from "@cloudflare/kumo";
import { useCallback } from "react";

import type { BlockInteraction, SelectElement } from "../types.js";

export function SelectElementComponent({
	element,
	onAction,
	onChange,
}: {
	element: SelectElement;
	onAction: (interaction: BlockInteraction) => void;
	onChange?: (actionId: string, value: unknown) => void;
}) {
	const handleValueChange = useCallback(
		(value: unknown) => {
			if (onChange) {
				onChange(element.action_id, value);
			} else {
				onAction({
					type: "block_action",
					action_id: element.action_id,
					value,
				});
			}
		},
		[onChange, onAction, element.action_id],
	);

	return (
		<Select
			label={element.label}
			defaultValue={element.initial_value}
			onValueChange={handleValueChange}
			items={element.options}
		>
			{element.options.map((opt) => (
				<Select.Option key={opt.value} value={opt.value}>
					{opt.label}
				</Select.Option>
			))}
		</Select>
	);
}
