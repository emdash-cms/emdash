import { Checkbox, Input, Select } from "@cloudflare/kumo";
import * as React from "react";

import type { FieldWidgetProps, GridAxisDef } from "../shared/types";
import { normalizeGrid } from "../shared/utils";

type CellType = "toggle" | "text" | "number" | "select";

interface SelectOption {
	label: string;
	value: string;
}

/**
 * Grid widget — a two-dimensional matrix of rows × columns with configurable
 * cell types. Stores as a nested JSON object.
 *
 * Seed usage:
 *   {
 *     "slug": "availability",
 *     "type": "json",
 *     "widget": "field-kit:grid",
 *     "options": {
 *       "rows": [
 *         { "key": "mon", "label": "Monday" },
 *         { "key": "tue", "label": "Tuesday" }
 *       ],
 *       "columns": [
 *         { "key": "morning", "label": "Morning" },
 *         { "key": "afternoon", "label": "Afternoon" }
 *       ],
 *       "cell": "toggle"
 *     }
 *   }
 *
 * Stored value: { "mon": { "morning": true, "afternoon": false }, ... }
 */
export function Grid({ value, onChange, label, required, options, minimal }: FieldWidgetProps) {
	const rows = (options?.rows as GridAxisDef[] | undefined) ?? [];
	const columns = (options?.columns as GridAxisDef[] | undefined) ?? [];
	const cellType = ((options?.cell as string | undefined) ?? "toggle") as CellType;
	const cellOptions = (options?.cellOptions as SelectOption[] | string[] | undefined) ?? [];
	const helpText = options?.helpText as string | undefined;

	const data = normalizeGrid(value, rows, columns);
	const dataRef = React.useRef(data);
	dataRef.current = data;

	const normalizedCellOptions: SelectOption[] = React.useMemo(
		() => cellOptions.map((opt) => (typeof opt === "string" ? { label: opt, value: opt } : opt)),
		[cellOptions],
	);

	const updateCell = React.useCallback(
		(rowKey: string, colKey: string, cellValue: unknown) => {
			const rowData = { ...dataRef.current[rowKey], [colKey]: cellValue };
			onChange({ ...dataRef.current, [rowKey]: rowData });
		},
		[onChange],
	);

	const toggleCell = React.useCallback(
		(rowKey: string, colKey: string, next: boolean) => {
			const rowData = { ...dataRef.current[rowKey], [colKey]: next };
			onChange({ ...dataRef.current, [rowKey]: rowData });
		},
		[onChange],
	);

	if (rows.length === 0 || columns.length === 0) {
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
						The field's <code>options.rows</code> and <code>options.columns</code> arrays are
						required. Define them in your seed file to use this widget.
					</p>
				</div>
			</div>
		);
	}

	return (
		<div>
			{!minimal && (
				<label className="mb-1.5 block text-sm font-medium text-kumo-default">
					{label}
					{required && <span className="ml-0.5 text-kumo-danger">*</span>}
				</label>
			)}

			<div className="overflow-x-auto rounded-md ring ring-kumo-hairline">
				<table className="w-full border-collapse text-sm">
					<thead>
						<tr className="border-b border-kumo-hairline bg-kumo-tint">
							<th className="sticky left-0 z-10 bg-kumo-tint px-3 py-2 text-left font-medium text-kumo-default">
								&nbsp;
							</th>
							{columns.map((col) => (
								<th
									key={col.key}
									className="px-2 py-2 text-center font-medium text-kumo-default"
									title={col.label}
								>
									<div className="flex flex-col items-center gap-1">
										{col.image && (
											<img
												src={col.image}
												alt={col.label}
												width="24"
												height="24"
												className="rounded-sm"
											/>
										)}
										<span className="text-xs leading-tight">{col.label}</span>
									</div>
								</th>
							))}
						</tr>
					</thead>
					<tbody>
						{rows.map((row, rowIdx) => (
							<tr
								key={row.key}
								className={
									rowIdx % 2 === 0
										? "border-t border-kumo-hairline"
										: "border-t border-kumo-hairline bg-kumo-tint/40"
								}
							>
								<td className="sticky left-0 z-10 whitespace-nowrap bg-inherit px-3 py-2 font-medium text-kumo-default">
									<div className="flex items-center gap-1.5">
										{row.image && (
											<img
												src={row.image}
												alt={row.label}
												width="20"
												height="20"
												className="rounded-sm"
											/>
										)}
										{row.label}
									</div>
								</td>
								{columns.map((col) => {
									const cellValue = data[row.key]?.[col.key];
									return (
										<td key={col.key} className="px-2 py-2 text-center">
											<CellInput
												type={cellType}
												value={cellValue}
												options={normalizedCellOptions}
												rowKey={row.key}
												colKey={col.key}
												onToggle={toggleCell}
												onUpdate={updateCell}
												ariaLabel={`${row.label} — ${col.label}`}
											/>
										</td>
									);
								})}
							</tr>
						))}
					</tbody>
				</table>
			</div>

			{helpText && <p className="mt-1.5 text-xs text-kumo-subtle">{helpText}</p>}
		</div>
	);
}

interface CellInputProps {
	type: CellType;
	value: unknown;
	options: SelectOption[];
	rowKey: string;
	colKey: string;
	onToggle: (rowKey: string, colKey: string, next: boolean) => void;
	onUpdate: (rowKey: string, colKey: string, value: unknown) => void;
	ariaLabel: string;
}

function CellInput({
	type,
	value,
	options,
	rowKey,
	colKey,
	onToggle,
	onUpdate,
	ariaLabel,
}: CellInputProps) {
	switch (type) {
		case "toggle":
			return (
				<div className="flex justify-center">
					<Checkbox
						aria-label={ariaLabel}
						checked={!!value}
						onCheckedChange={(next) => onToggle(rowKey, colKey, !!next)}
					/>
				</div>
			);

		case "text":
			return (
				<Input
					size="sm"
					aria-label={ariaLabel}
					value={typeof value === "string" ? value : ""}
					onChange={(e) => onUpdate(rowKey, colKey, e.target.value)}
				/>
			);

		case "number":
			return (
				<Input
					size="sm"
					type="number"
					aria-label={ariaLabel}
					value={typeof value === "number" ? value : ""}
					onChange={(e) =>
						onUpdate(rowKey, colKey, e.target.value === "" ? undefined : Number(e.target.value))
					}
				/>
			);

		case "select":
			return (
				<Select
					aria-label={ariaLabel}
					value={typeof value === "string" ? value : ""}
					placeholder="—"
					onValueChange={(v) => onUpdate(rowKey, colKey, (v as string) === "" ? undefined : v)}
					items={options}
				/>
			);

		default:
			return null;
	}
}
