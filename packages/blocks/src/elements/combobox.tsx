import { Combobox } from "@cloudflare/kumo";
import { useCallback, useContext, useEffect, useMemo, useState } from "react";

import { FormOwnerContext } from "../form-context.js";
import type { BlockInteraction, ComboboxElement } from "../types.js";

export function ComboboxElementComponent({
	element,
	onAction,
	onChange,
}: {
	element: ComboboxElement;
	onAction: (interaction: BlockInteraction) => void;
	onChange?: (actionId: string, value: unknown) => void;
}) {
	const form = useContext(FormOwnerContext);
	const initialOption = useMemo(
		() => element.options.find((o) => o.value === element.initial_value) ?? null,
		[element.options, element.initial_value],
	);

	const [selected, setSelected] = useState<{ label: string; value: string } | null>(initialOption);

	useEffect(() => {
		setSelected(initialOption);
	}, [initialOption]);

	const handleChange = useCallback(
		(newValue: unknown) => {
			const opt = newValue as { label: string; value: string } | null;
			setSelected(opt);
			const val = opt?.value ?? null;
			if (onChange) {
				onChange(element.action_id, val);
			} else {
				onAction({
					type: "block_action",
					action_id: element.action_id,
					value: val,
				});
			}
		},
		[onChange, onAction, element.action_id],
	);

	return (
		<Combobox
			label={element.label}
			items={element.options}
			value={selected}
			onValueChange={handleChange}
		>
			<Combobox.TriggerInput form={form} placeholder={element.placeholder ?? "Search..."} />
			<Combobox.Content>
				<Combobox.List>
					{(item: { label: string; value: string }) => (
						<Combobox.Item value={item}>{item.label}</Combobox.Item>
					)}
				</Combobox.List>
				<Combobox.Empty>No results</Combobox.Empty>
			</Combobox.Content>
		</Combobox>
	);
}
