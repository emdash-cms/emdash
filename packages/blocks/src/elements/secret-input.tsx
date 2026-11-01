import { SensitiveInput } from "@cloudflare/kumo";
import { useCallback, useContext, useState } from "react";

import { FormOwnerContext } from "../form-context.js";
import type { BlockInteraction, SecretInputElement } from "../types.js";

export function SecretInputElementComponent({
	element,
	onAction,
	onChange,
}: {
	element: SecretInputElement;
	onAction: (interaction: BlockInteraction) => void;
	onChange?: (actionId: string, value: unknown) => void;
}) {
	const form = useContext(FormOwnerContext);
	const [value, setValue] = useState("");
	const [editing, setEditing] = useState(!element.has_value);

	const handleValueChange = useCallback(
		(v: string) => {
			setValue(v);
			if (onChange) {
				onChange(element.action_id, v);
			}
		},
		[onChange, element.action_id],
	);

	const handleFocus = useCallback(() => {
		if (!editing) {
			setEditing(true);
			setValue("");
		}
	}, [editing]);

	const handleBlur = useCallback(() => {
		if (!onChange && value) {
			onAction({
				type: "block_action",
				action_id: element.action_id,
				value,
			});
		}
		if (!value && element.has_value) {
			setEditing(false);
		}
	}, [onChange, onAction, element.action_id, value, element.has_value]);

	if (!editing) {
		return (
			<SensitiveInput
				form={form}
				label={element.label}
				value={"••••••••"}
				readOnly
				onFocus={handleFocus}
				placeholder={element.placeholder}
			/>
		);
	}

	return (
		<SensitiveInput
			form={form}
			label={element.label}
			value={value}
			onValueChange={handleValueChange}
			onFocus={handleFocus}
			onBlur={handleBlur}
			placeholder={element.placeholder}
		/>
	);
}
