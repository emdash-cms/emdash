/** Sub-field types available in object-form and list widgets. */
export type SubFieldType =
	| "text"
	| "number"
	| "boolean"
	| "select"
	| "textarea"
	| "date"
	| "color"
	| "url";

/** A single sub-field definition, used in object-form and list options.fields. */
export interface SubFieldDef {
	/** JSON object key this sub-field maps to. */
	key: string;
	/** Display label. */
	label: string;
	/** Input type. */
	type: SubFieldType;
	/** Whether this sub-field is required. */
	required?: boolean;
	/** Placeholder text. */
	placeholder?: string;
	/** Help text shown below the input. */
	helpText?: string;
	/** Default value when creating new items. */
	defaultValue?: unknown;
	/**
	 * For type: "select" — the available options.
	 * Accepts either string[] or Array<{ label: string; value: string }>.
	 */
	options?: string[] | Array<{ label: string; value: string }>;
	/** For type: "number" — minimum value. */
	min?: number;
	/** For type: "number" — maximum value. */
	max?: number;
	/** For type: "number" — step increment. */
	step?: number;
	/** For type: "number" — unit label after the input (e.g. "kg", "kcal"). */
	suffix?: string;
	/** For type: "number" — label before the input (e.g. "$"). */
	prefix?: string;
	/** For type: "textarea" — number of rows. */
	rows?: number;
}

/** Props passed to every field widget component by EmDash admin. */
export interface FieldWidgetProps {
	/** Current field value. */
	value: unknown;
	/** Callback to update the field value. Must receive the complete new value. */
	onChange: (value: unknown) => void;
	/** Field label from the schema. */
	label: string;
	/** HTML id attribute. */
	id: string;
	/** Whether the field is required. */
	required?: boolean;
	/** Widget-specific options from the seed field definition. */
	options?: Record<string, unknown>;
	/** When true, render in compact mode (hide the top-level label). */
	minimal?: boolean;
}

/** Row/column definition for the grid widget. */
export interface GridAxisDef {
	/** Unique key used in the stored value object. */
	key: string;
	/** Display label. */
	label: string;
	/** Optional icon image URL. */
	image?: string;
}
