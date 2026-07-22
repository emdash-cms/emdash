// ── Composition Objects ──────────────────────────────────────────────────────

export interface ConfirmDialog {
	title: string;
	text: string;
	confirm: string;
	deny: string;
	style?: "danger";
}

// ── Elements ─────────────────────────────────────────────────────────────────

export interface ButtonElement {
	type: "button";
	action_id: string;
	label: string;
	style?: "primary" | "danger" | "secondary";
	value?: unknown;
	confirm?: ConfirmDialog;
}

export interface TextInputElement {
	type: "text_input";
	action_id: string;
	label: string;
	placeholder?: string;
	initial_value?: string;
	multiline?: boolean;
}

export interface NumberInputElement {
	type: "number_input";
	action_id: string;
	label: string;
	initial_value?: number;
	min?: number;
	max?: number;
}

export interface SelectElement {
	type: "select";
	action_id: string;
	label: string;
	options: Array<{ label: string; value: string }>;
	initial_value?: string;
	/** Plugin route that returns `{ items: Array<{ id, name }> }` to populate options dynamically */
	optionsRoute?: string;
}

export interface ToggleElement {
	type: "toggle";
	action_id: string;
	label: string;
	description?: string;
	initial_value?: boolean;
}

export interface SecretInputElement {
	type: "secret_input";
	action_id: string;
	label: string;
	placeholder?: string;
	has_value?: boolean;
}

export interface CheckboxElement {
	type: "checkbox";
	action_id: string;
	label: string;
	options: Array<{ label: string; value: string }>;
	initial_value?: string[];
}

export interface DateInputElement {
	type: "date_input";
	action_id: string;
	label: string;
	initial_value?: string;
	placeholder?: string;
}

export interface ComboboxElement {
	type: "combobox";
	action_id: string;
	label: string;
	options: Array<{ label: string; value: string }>;
	initial_value?: string;
	placeholder?: string;
}

export interface RadioElement {
	type: "radio";
	action_id: string;
	label: string;
	options: Array<{ label: string; value: string }>;
	initial_value?: string;
}

/**
 * Sub-field types allowed inside a RepeaterElement. Limited to the scalar
 * inputs the admin widget currently renders inline.
 */
export type RepeaterSubField =
	| TextInputElement
	| NumberInputElement
	| SelectElement
	| ToggleElement;

/**
 * Array-of-objects field. Renders as a list of collapsible cards with inline
 * add/remove and drag-and-drop reordering. Sub-fields are scalar Block Kit
 * elements keyed by their `action_id`.
 *
 * Admin-authoring only: this element is rendered by the admin widget so plugin
 * blocks can capture repeating data. The runtime block renderer
 * (`renderElement`) deliberately returns `null` for `repeater` — repeater
 * values are persisted on the parent block and consumed by the plugin's own
 * runtime component, not re-rendered as a stand-alone block.
 */
export interface RepeaterElement {
	type: "repeater";
	action_id: string;
	label: string;
	/** Singular label used in the UI (e.g. "FAQ" → "Add FAQ"). */
	item_label?: string;
	fields: RepeaterSubField[];
	min_items?: number;
	max_items?: number;
	/**
	 * Default rows for the field. Note: the admin widget seeds new rows from
	 * the sub-field types (empty string / `false`), not from `initial_value`;
	 * plugins should populate persisted state via the form `values` payload
	 * instead of relying on `initial_value` for pre-filled rows.
	 */
	initial_value?: Array<Record<string, unknown>>;
}

/**
 * Picks an item from the media library (or uploads a new one). The stored value
 * is the selected asset's URL string, so this element is value-compatible with a
 * plain `text_input` — existing content continues to work after swapping.
 */
export interface MediaPickerElement {
	type: "media_picker";
	action_id: string;
	label: string;
	/** Mime-type prefix filter (e.g. "image/"). Defaults to "image/". */
	mime_type_filter?: string;
	initial_value?: string;
	placeholder?: string;
}

export type Element =
	| ButtonElement
	| TextInputElement
	| NumberInputElement
	| SelectElement
	| ToggleElement
	| SecretInputElement
	| CheckboxElement
	| DateInputElement
	| ComboboxElement
	| RadioElement
	| RepeaterElement
	| MediaPickerElement;

// ── Form Fields (elements + optional condition) ──────────────────────────────

export type FieldCondition =
	| { field: string; eq?: unknown; neq?: never }
	| { field: string; neq?: unknown; eq?: never };

export type FormField = (
	| ButtonElement
	| TextInputElement
	| NumberInputElement
	| SelectElement
	| ToggleElement
	| SecretInputElement
	| CheckboxElement
	| DateInputElement
	| ComboboxElement
	| RadioElement
) & {
	condition?: FieldCondition;
};

// ── Block Sub-types ──────────────────────────────────────────────────────────

export interface TableColumn {
	key: string;
	label: string;
	format?: "text" | "badge" | "relative_time" | "number" | "code";
	sortable?: boolean;
}

export interface StatItem {
	label: string;
	value: string | number;
	description?: string;
	trend?: "up" | "down" | "neutral";
}

export interface MediaGridItem {
	url: string;
	alt: string;
	title?: string;
	description?: string;
	badge?: string;
	actions?: ButtonElement[];
}

/** A single data series for a timeseries chart. */
export interface ChartSeries {
	/** Display name shown in tooltips and legends */
	name: string;
	/** Array of `[timestamp_ms, value]` tuples ordered by time */
	data: [number, number][];
	/**
	 * Hex color for this series. If omitted, an automatic categorical color
	 * from the Kumo palette is assigned based on the series index.
	 */
	color?: string;
}

/** Timeseries-specific chart configuration */
export interface TimeseriesChartConfig {
	chart_type: "timeseries";
	/** Visual style of each series. Defaults to `"line"`. */
	style?: "line" | "bar";
	/** Array of time series to display */
	series: ChartSeries[];
	/** Label for the x-axis */
	x_axis_name?: string;
	/** Label for the y-axis */
	y_axis_name?: string;
	/** Height of the chart in pixels. Defaults to 350. */
	height?: number;
	/** Render a gradient fill beneath line series */
	gradient?: boolean;
}

/** Custom chart configuration using raw ECharts options (pie, etc.) */
export interface CustomChartConfig {
	chart_type: "custom";
	/** Raw ECharts option object — passed through to `chart.setOption()` */
	options: Record<string, unknown>;
	/** Height of the chart in pixels. Defaults to 350. */
	height?: number;
}

export type ChartConfig = TimeseriesChartConfig | CustomChartConfig;

// ── Blocks ───────────────────────────────────────────────────────────────────

interface BlockBase {
	block_id?: string;
}

export interface HeaderBlock extends BlockBase {
	type: "header";
	text: string;
}

export interface SectionBlock extends BlockBase {
	type: "section";
	text: string;
	accessory?: Element;
}

export interface DividerBlock extends BlockBase {
	type: "divider";
}

export interface FieldsBlock extends BlockBase {
	type: "fields";
	fields: Array<{ label: string; value: string }>;
}

export interface TableBlock extends BlockBase {
	type: "table";
	columns: TableColumn[];
	rows: Array<Record<string, unknown>>;
	next_cursor?: string;
	page_action_id: string;
	empty_text?: string;
}

export interface ActionsBlock extends BlockBase {
	type: "actions";
	elements: Element[];
}

export interface StatsBlock extends BlockBase {
	type: "stats";
	items: StatItem[];
}

export interface FormBlock extends BlockBase {
	type: "form";
	fields: FormField[];
	submit: { label: string; action_id: string };
}

export interface ImageBlock extends BlockBase {
	type: "image";
	url: string;
	alt: string;
	title?: string;
}

export interface ContextBlock extends BlockBase {
	type: "context";
	text: string;
}

export interface ColumnsBlock extends BlockBase {
	type: "columns";
	columns: Block[][];
}

export interface ChartBlock extends BlockBase {
	type: "chart";
	config: ChartConfig;
}

export interface BannerBlock extends BlockBase {
	type: "banner";
	title?: string;
	description?: string;
	variant?: "default" | "alert" | "error";
}

export interface MeterBlock extends BlockBase {
	type: "meter";
	label: string;
	value: number;
	max?: number;
	min?: number;
	custom_value?: string;
}

export interface CodeBlock extends BlockBase {
	type: "code";
	code: string;
	language?: "ts" | "tsx" | "jsonc" | "bash" | "css";
}

export interface TabPanel {
	label: string;
	blocks: Block[];
}

export interface TabBlock extends BlockBase {
	type: "tab";
	panels: TabPanel[];
	default_tab?: number;
}

export interface EmptyBlock extends BlockBase {
	type: "empty";
	title: string;
	description?: string;
	command_line?: string;
	size?: "sm" | "base" | "lg";
	actions?: Element[];
}

export interface AccordionBlock extends BlockBase {
	type: "accordion";
	label: string;
	blocks: Block[];
	default_open?: boolean;
}

export interface MediaGridBlock extends BlockBase {
	type: "media_grid";
	items: MediaGridItem[];
	columns?: 2 | 3 | 4;
	empty_text?: string;
}

export type Block =
	| HeaderBlock
	| SectionBlock
	| DividerBlock
	| FieldsBlock
	| TableBlock
	| ActionsBlock
	| StatsBlock
	| FormBlock
	| ImageBlock
	| ContextBlock
	| ColumnsBlock
	| ChartBlock
	| BannerBlock
	| MeterBlock
	| CodeBlock
	| TabBlock
	| EmptyBlock
	| AccordionBlock
	| MediaGridBlock;

// ── Interactions ─────────────────────────────────────────────────────────────

export interface BlockAction {
	type: "block_action";
	action_id: string;
	block_id?: string;
	value?: unknown;
}

export interface FormSubmit {
	type: "form_submit";
	action_id: string;
	block_id?: string;
	values: Record<string, unknown>;
}

export interface PageLoad {
	type: "page_load";
	page: string;
}

export type BlockInteraction = BlockAction | FormSubmit | PageLoad;

// ── Response ─────────────────────────────────────────────────────────────────

export interface BlockResponse {
	blocks: Block[];
	toast?: { message: string; type: "success" | "error" | "info" };
}
