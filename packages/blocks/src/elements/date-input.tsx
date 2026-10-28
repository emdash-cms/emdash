import { useCallback, useContext, useEffect, useState } from "react";

import { FormOwnerContext } from "../form-context.js";
import type { BlockInteraction, DateInputElement } from "../types.js";

export function DateInputElementComponent({
	element,
	onAction,
	onChange,
}: {
	element: DateInputElement;
	onAction: (interaction: BlockInteraction) => void;
	onChange?: (actionId: string, value: unknown) => void;
}) {
	const form = useContext(FormOwnerContext);
	const [value, setValue] = useState(element.initial_value ?? "");

	useEffect(() => {
		setValue(element.initial_value ?? "");
	}, [element.initial_value]);

	const handleChange = useCallback(
		(e: React.ChangeEvent<HTMLInputElement>) => {
			const newValue = e.target.value;
			setValue(newValue);
			if (onChange) {
				onChange(element.action_id, newValue);
			}
		},
		[onChange, element.action_id],
	);

	const handleBlur = useCallback(
		(e: React.FocusEvent<HTMLInputElement>) => {
			if (!onChange) {
				onAction({
					type: "block_action",
					action_id: element.action_id,
					value: e.target.value,
				});
			}
		},
		[onChange, onAction, element.action_id],
	);

	return (
		<div className="flex flex-col gap-1">
			<label className="text-sm font-medium text-kumo-text">{element.label}</label>
			<input
				form={form}
				type="date"
				value={value}
				onChange={handleChange}
				onBlur={handleBlur}
				placeholder={element.placeholder}
				className="h-9 rounded-lg border border-kumo-line bg-kumo-bg px-3 text-sm text-kumo-text outline-none focus:ring-2 focus:ring-kumo-ring"
			/>
		</div>
	);
}
