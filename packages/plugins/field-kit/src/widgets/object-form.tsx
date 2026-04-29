import { Button } from "@cloudflare/kumo";
import { CaretRight } from "@phosphor-icons/react";
import * as React from "react";

import { SubField } from "../shared/sub-field";
import type { FieldWidgetProps, SubFieldDef } from "../shared/types";
import { normalizeObject } from "../shared/utils";

/**
 * Object form widget — renders a group of typed sub-fields that store as a
 * single JSON object.
 *
 * Seed usage:
 *   {
 *     "slug": "nutrition",
 *     "type": "json",
 *     "widget": "field-kit:object-form",
 *     "options": {
 *       "fields": [
 *         { "key": "calories", "label": "Calories", "type": "number", "suffix": "kcal" },
 *         { "key": "protein", "label": "Protein", "type": "number", "suffix": "g" }
 *       ]
 *     }
 *   }
 *
 * Stored value: { "calories": 250, "protein": 12.5 }
 */
export function ObjectForm({
	value,
	onChange,
	label,
	id,
	required,
	options,
	minimal,
}: FieldWidgetProps) {
	const fields = (options?.fields as SubFieldDef[] | undefined) ?? [];
	const collapsed = options?.collapsed as boolean | undefined;
	const helpText = options?.helpText as string | undefined;

	const [isOpen, setIsOpen] = React.useState(!collapsed);

	const data = normalizeObject(value, fields);
	const dataRef = React.useRef(data);
	dataRef.current = data;

	const handleFieldChange = React.useCallback(
		(key: string, fieldValue: unknown) => {
			onChange({ ...dataRef.current, [key]: fieldValue });
		},
		[onChange],
	);

	if (fields.length === 0) {
		return (
			<div>
				{!minimal && (
					<label className="mb-1.5 block text-sm font-medium text-kumo-default">
						{label}
						{required && <span className="ml-0.5 text-kumo-danger">*</span>}
					</label>
				)}
				<div className="rounded-md bg-kumo-danger-tint/60 p-3 text-sm text-kumo-danger">
					<p className="font-medium">Widget misconfigured</p>
					<p className="mt-1 opacity-80">
						The field's <code>options.fields</code> array is empty or missing. Define sub-fields in
						your seed file to use this widget.
					</p>
				</div>
			</div>
		);
	}

	return (
		<div>
			{!minimal && (
				<Button
					variant="ghost"
					size="sm"
					className="mb-2 !px-1 font-medium"
					onClick={() => setIsOpen((o) => !o)}
					icon={
						<CaretRight
							style={{
								transform: isOpen ? "rotate(90deg)" : undefined,
								transition: "transform 150ms ease",
							}}
						/>
					}
				>
					{label}
					{required && <span className="ml-0.5 text-kumo-danger">*</span>}
				</Button>
			)}

			{isOpen && (
				<div className="space-y-3 rounded-md p-3 ring ring-kumo-hairline">
					{fields.map((field) => (
						<SubField
							key={field.key}
							id={`${id}-${field.key}`}
							def={field}
							value={data[field.key]}
							onChange={(v) => handleFieldChange(field.key, v)}
						/>
					))}
				</div>
			)}

			{helpText && <p className="mt-1.5 text-xs text-kumo-subtle">{helpText}</p>}
		</div>
	);
}
