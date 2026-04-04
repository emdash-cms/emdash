import { Input, Switch } from "@cloudflare/kumo";
import type { Element } from "@emdash-cms/blocks";
import { useLingui } from "@lingui/react/macro";
import * as React from "react";

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
				<div>
					<label className="text-sm font-medium mb-1.5 block">{element.label}</label>
					<select
						className="flex w-full rounded-md border border-kumo-line bg-transparent px-3 py-2 text-sm"
						value={typeof value === "string" ? value : ""}
						onChange={(e) => onChange(element.action_id, e.target.value)}
					>
						<option value="">{t`Select...`}</option>
						{options.map((opt) => (
							<option key={opt.value} value={opt.value}>
								{opt.label}
							</option>
						))}
					</select>
				</div>
			);
		}
		default:
			return (
				<div className="text-sm text-kumo-subtle">
					{t`Unsupported widget element type: ${(element as { type: string }).type}`}
				</div>
			);
	}
}
