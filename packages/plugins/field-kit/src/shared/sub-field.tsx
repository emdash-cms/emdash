import { Input, InputArea, Select, Switch } from "@cloudflare/kumo";
import * as React from "react";

import type { SubFieldDef } from "./types";

interface SubFieldProps {
	/**
	 * Unique DOM id for this sub-field instance. Required because the same
	 * sub-field key (e.g. "name") may render many times in a `list` widget,
	 * so the id must be composed per-instance by the caller to keep label
	 * and input association correct.
	 */
	id: string;
	def: SubFieldDef;
	value: unknown;
	onChange: (value: unknown) => void;
}

function normalizeSelectItems(
	options: SubFieldDef["options"],
): Array<{ label: string; value: string }> {
	if (!options || !Array.isArray(options)) return [];
	return options.map((opt) => (typeof opt === "string" ? { label: opt, value: opt } : opt));
}

/**
 * Wrap a label with a required asterisk. Kumo's `Field` wrapper marks
 * non-required fields with "(optional)" but does not display `*` for
 * required ones, so we add it ourselves to make the requirement obvious.
 */
function labelWithRequired(label: string, required: boolean | undefined): React.ReactNode {
	if (!required) return label;
	return (
		<>
			{label}
			<span className="ml-0.5 text-kumo-danger">*</span>
		</>
	);
}

/**
 * Renders a single sub-field input based on its type definition.
 * Used by object-form and list widgets.
 */
export function SubField({ id, def, value, onChange }: SubFieldProps) {
	const fieldId = id;

	switch (def.type) {
		case "text":
			return (
				<Input
					id={fieldId}
					type="text"
					label={labelWithRequired(def.label, def.required)}
					description={def.helpText}
					required={def.required}
					placeholder={def.placeholder}
					value={typeof value === "string" ? value : ""}
					onChange={(e) => onChange(e.target.value)}
				/>
			);

		case "url":
			return (
				<Input
					id={fieldId}
					type="url"
					label={labelWithRequired(def.label, def.required)}
					description={def.helpText}
					required={def.required}
					placeholder={def.placeholder ?? "https://"}
					value={typeof value === "string" ? value : ""}
					onChange={(e) => onChange(e.target.value)}
				/>
			);

		case "number": {
			const prefixOrSuffix = def.prefix || def.suffix;
			const labelId = `${fieldId}-label`;
			const numberInput = (
				<Input
					id={fieldId}
					type="number"
					label={prefixOrSuffix ? undefined : labelWithRequired(def.label, def.required)}
					aria-labelledby={prefixOrSuffix ? labelId : undefined}
					description={prefixOrSuffix ? undefined : def.helpText}
					required={def.required}
					placeholder={def.placeholder}
					min={def.min}
					max={def.max}
					step={def.step}
					value={typeof value === "number" ? value : ""}
					onChange={(e) => {
						const v = e.target.value;
						onChange(v === "" ? undefined : Number(v));
					}}
				/>
			);

			if (!prefixOrSuffix) return numberInput;

			return (
				<div className="flex flex-col gap-1.5">
					<label id={labelId} htmlFor={fieldId} className="text-sm font-medium text-kumo-default">
						{def.label}
						{def.required && <span className="ml-0.5 text-kumo-danger">*</span>}
					</label>
					<div className="flex items-center gap-2">
						{def.prefix && (
							<span className="whitespace-nowrap text-sm text-kumo-subtle">{def.prefix}</span>
						)}
						{numberInput}
						{def.suffix && (
							<span className="whitespace-nowrap text-sm text-kumo-subtle">{def.suffix}</span>
						)}
					</div>
					{def.helpText && <p className="text-xs text-kumo-subtle">{def.helpText}</p>}
				</div>
			);
		}

		case "boolean":
			return (
				<Switch
					id={fieldId}
					label={def.label}
					labelTooltip={def.helpText}
					checked={!!value}
					onCheckedChange={(checked) => onChange(checked)}
				/>
			);

		case "select": {
			const items = normalizeSelectItems(def.options);
			return (
				<Select
					label={labelWithRequired(def.label, def.required)}
					description={def.helpText}
					required={def.required}
					placeholder={def.placeholder ?? "Select..."}
					value={typeof value === "string" ? value : ""}
					onValueChange={(v) => onChange((v as string) === "" ? undefined : v)}
					items={items}
				/>
			);
		}

		case "textarea":
			return (
				<InputArea
					id={fieldId}
					label={labelWithRequired(def.label, def.required)}
					description={def.helpText}
					required={def.required}
					placeholder={def.placeholder}
					rows={def.rows ?? 3}
					value={typeof value === "string" ? value : ""}
					onChange={(e) => onChange(e.target.value)}
				/>
			);

		case "date":
			return (
				<Input
					id={fieldId}
					type="date"
					label={labelWithRequired(def.label, def.required)}
					description={def.helpText}
					required={def.required}
					value={typeof value === "string" ? value : ""}
					onChange={(e) => onChange(e.target.value || undefined)}
				/>
			);

		case "color":
			return (
				<div className="flex flex-col gap-1.5">
					<label htmlFor={fieldId} className="text-sm font-medium text-kumo-default">
						{def.label}
						{def.required && <span className="ml-0.5 text-kumo-danger">*</span>}
					</label>
					<div className="flex items-center gap-2">
						<input
							id={fieldId}
							type="color"
							className="h-9 w-12 cursor-pointer rounded-md bg-kumo-base ring ring-kumo-hairline p-1"
							value={typeof value === "string" ? value : "#000000"}
							onChange={(e) => onChange(e.target.value)}
						/>
						<Input
							type="text"
							aria-label={`${def.label} hex value`}
							placeholder="#000000"
							value={typeof value === "string" ? value : ""}
							onChange={(e) => onChange(e.target.value)}
						/>
					</div>
					{def.helpText && <p className="text-xs text-kumo-subtle">{def.helpText}</p>}
				</div>
			);

		default:
			return (
				<Input
					id={fieldId}
					type="text"
					label={labelWithRequired(def.label, def.required)}
					value={typeof value === "string" ? String(value) : ""}
					onChange={(e) => onChange(e.target.value)}
				/>
			);
	}
}
