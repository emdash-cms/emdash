import { ButtonElementComponent } from "./elements/button.js";
import { CheckboxElementComponent } from "./elements/checkbox.js";
import { ComboboxElementComponent } from "./elements/combobox.js";
import { DateInputElementComponent } from "./elements/date-input.js";
import { NumberInputElementComponent } from "./elements/number-input.js";
import { RadioElementComponent } from "./elements/radio.js";
import { SecretInputElementComponent } from "./elements/secret-input.js";
import { SelectElementComponent } from "./elements/select.js";
import { TextInputElementComponent } from "./elements/text-input.js";
import { ToggleElementComponent } from "./elements/toggle.js";
import type { BlockInteraction, Element } from "./types.js";

export function renderElement(
	element: Element,
	onAction: (interaction: BlockInteraction) => void,
	onChange?: (actionId: string, value: unknown) => void,
): React.ReactNode {
	switch (element.type) {
		case "button":
			return <ButtonElementComponent element={element} onAction={onAction} />;
		case "text_input":
			return (
				<TextInputElementComponent element={element} onAction={onAction} onChange={onChange} />
			);
		case "number_input":
			return (
				<NumberInputElementComponent element={element} onAction={onAction} onChange={onChange} />
			);
		case "select":
			return <SelectElementComponent element={element} onAction={onAction} onChange={onChange} />;
		case "toggle":
			return <ToggleElementComponent element={element} onAction={onAction} onChange={onChange} />;
		case "secret_input":
			return (
				<SecretInputElementComponent element={element} onAction={onAction} onChange={onChange} />
			);
		case "checkbox":
			return <CheckboxElementComponent element={element} onAction={onAction} onChange={onChange} />;
		case "radio":
			return <RadioElementComponent element={element} onAction={onAction} onChange={onChange} />;
		case "date_input":
			return (
				<DateInputElementComponent element={element} onAction={onAction} onChange={onChange} />
			);
		case "combobox":
			return <ComboboxElementComponent element={element} onAction={onAction} onChange={onChange} />;
		case "repeater":
			// Admin-authoring only. The runtime block renderer never returns a
			// DOM node for `repeater` — values are persisted on the parent
			// block and consumed by the plugin's own runtime component.
			if ((import.meta as { env?: { DEV?: boolean } }).env?.DEV) {
				console.warn(
					"[blocks] renderElement: 'repeater' is an admin-authoring element and renders nothing at runtime",
				);
			}
			return null;
		case "media_picker":
			return null;
		default: {
			const _exhaustive: never = element;
			return null;
		}
	}
}
