/**
 * Color picker admin component.
 *
 * Exports a `fields` map with a "picker" widget that renders a color
 * input with hex value display and preview swatch.
 */

import * as React from "react";

interface FieldWidgetProps {
	value: unknown;
	onChange: (value: unknown) => void;
	label: string;
	id: string;
	required?: boolean;
	options?: Record<string, unknown>;
	minimal?: boolean;
}

/** Named CSS colors for the preset palette */
const PRESETS = [
	"#ef4444",
	"#f97316",
	"#eab308",
	"#22c55e",
	"#06b6d4",
	"#3b82f6",
	"#8b5cf6",
	"#ec4899",
	"#000000",
	"#ffffff",
];

const VALID_HEX_PATTERN = /^#[\da-f]{6}$/i;

function ColorPicker({ value, onChange, label, id, required, minimal }: FieldWidgetProps) {
	const rawColor = typeof value === "string" && value ? value : "#000000";
	// Only pass valid 6-digit hex to the native color input and preview;
	// partial input while typing would produce invalid color values.
	const color = VALID_HEX_PATTERN.test(rawColor) ? rawColor : "#000000";

	const handleHexChange = (e: React.ChangeEvent<HTMLInputElement>) => {
		const v = e.target.value;
		// Allow partial input while typing
		onChange(v);
	};

	return (
		<div data-testid="color-picker-widget">
			{!minimal && (
				<label htmlFor={id} className="text-sm font-medium leading-none mb-1.5 block">
					{label}
					{required && <span className="text-destructive ms-0.5">*</span>}
				</label>
			)}
			<div className="flex items-center gap-3">
				<input
					type="color"
					id={id}
					value={color}
					onChange={(e) => onChange(e.target.value)}
					className="h-10 w-10 cursor-pointer rounded border border-input p-0.5"
					data-testid="color-input"
				/>
				<input
					type="text"
					value={typeof value === "string" ? value : ""}
					onChange={handleHexChange}
					placeholder="#000000"
					className="flex h-10 w-28 rounded-md border border-input bg-transparent px-3 py-2 text-sm font-mono ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
					data-testid="color-hex-input"
				/>
				<div
					className="h-10 flex-1 rounded-md border border-input"
					style={{ backgroundColor: color }}
					data-testid="color-preview"
				/>
			</div>
			<div className="mt-2 flex gap-1" data-testid="color-presets">
				{PRESETS.map((preset) => (
					<button
						key={preset}
						type="button"
						onClick={() => onChange(preset)}
						className="h-6 w-6 rounded-sm border border-input transition-transform hover:scale-110"
						style={{ backgroundColor: preset }}
						title={preset}
						data-testid={`color-preset-${preset.slice(1)}`}
					/>
				))}
			</div>
		</div>
	);
}

export const fields = {
	picker: ColorPicker,
};
