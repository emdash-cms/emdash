import { Input, Select, Switch } from "@cloudflare/kumo";
import type { Element } from "@emdash-cms/blocks";
import { useLingui } from "@lingui/react/macro";
import * as React from "react";

import { BlockKitMediaPickerField } from "./BlockKitMediaPickerField";

interface BlockKitFieldWidgetProps {
	label: string;
	elements: Element[];
	value: unknown;
	onChange: (value: unknown) => void;
}

/**
 * Renders Block Kit elements as a field widget for sandboxed plugins.
 * Decomposes a JSON value into per-element values keyed by action_id,
 * and recomposes on change.
 */
export function BlockKitFieldWidget({
	label,
	elements,
	value,
	onChange,
}: BlockKitFieldWidgetProps) {
	const obj = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;

	// Use a ref to avoid stale closure -- rapid changes to different elements
	// would otherwise lose updates because each callback spreads from a stale obj.
	const objRef = React.useRef(obj);
	objRef.current = obj;

	const handleElementChange = React.useCallback(
		(actionId: string, elementValue: unknown) => {
			onChange({ ...objRef.current, [actionId]: elementValue });
		},
		[onChange],
	);

	// Filter out elements without action_id -- they can't be mapped to values
	const validElements = elements.filter((el) => el.action_id);

	return (
		<div>
			<span className="text-sm font-medium leading-none">{label}</span>
			<div className="mt-2 space-y-3">
				{validElements.map((el) => (
					<BlockKitFieldElement
						key={el.action_id}
						element={el}
						value={obj[el.action_id]}
						onChange={handleElementChange}
					/>
				))}
			</div>
		</div>
	);
}

function BlockKitFieldElement({
	element,
	value,
	onChange,
}: {
	element: Element;
	value: unknown;
	onChange: (actionId: string, value: unknown) => void;
}) {
	const { t } = useLingui();
	switch (element.type) {
		case "text_input":
			return (
				<Input
					label={element.label}
					placeholder={element.placeholder}
					value={typeof value === "string" ? value : ""}
					onChange={(e) => onChange(element.action_id, e.target.value)}
				/>
			);
		case "number_input":
			return (
				<Input
					label={element.label}
					type="number"
					value={typeof value === "number" ? String(value) : ""}
					onChange={(e) => {
						const n = Number(e.target.value);
						onChange(element.action_id, e.target.value && Number.isFinite(n) ? n : undefined);
					}}
				/>
			);
		case "toggle":
			return (
				<Switch
					label={element.label}
					checked={!!value}
					onCheckedChange={(checked) => onChange(element.action_id, checked)}
				/>
			);
		case "select": {
			const options = Array.isArray(element.options) ? element.options : [];
			return (
				<Select
					label={element.label}
					value={typeof value === "string" ? value : ""}
					onValueChange={(v) => onChange(element.action_id, v ?? "")}
					items={{
						"": t`Select...`,
						...Object.fromEntries(options.map((opt) => [opt.value, opt.label])),
					}}
				/>
			);
		}
		case "media_picker":
			return (
				<BlockKitMediaPickerField
					actionId={element.action_id}
					label={element.label}
					placeholder={element.placeholder}
					mimeTypeFilter={element.mime_type_filter}
					value={value}
					onChange={onChange}
				/>
			);
		default:
			return (
				<div className="text-sm text-kumo-subtle">
					{t`Unsupported widget element type: ${(element as { type: string }).type}`}
				</div>
			);
	}
}
