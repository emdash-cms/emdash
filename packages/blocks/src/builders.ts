import type {
	AccordionBlock,
	ActionsBlock,
	BannerBlock,
	Block,
	ButtonElement,
	CardBlock,
	CardGridBlock,
	CardItem,
	CheckboxElement,
	ChartBlock,
	ChartSeries,
	CodeBlock,
	ComboboxElement,
	ColumnsBlock,
	ConfirmDialog,
	ContextBlock,
	CtaBannerBlock,
	DateInputElement,
	RadioElement,
	RepeaterElement,
	RepeaterSubField,
	DividerBlock,
	Element,
	EmptyBlock,
	FaqBlock,
	FaqItem,
	FeatureListBlock,
	FeatureListItem,
	FieldsBlock,
	LogoCloudBlock,
	LogoCloudItem,
	FormBlock,
	FormField,
	HeaderBlock,
	IconBlock,
	ImageBlock,
	PricingPlan,
	PricingTableBlock,
	StepsBlock,
	StepItem,
	MediaPickerElement,
	MeterBlock,
	NumberInputElement,
	SecretInputElement,
	SectionBlock,
	SelectElement,
	StatItem,
	StatsBlock,
	TableBlock,
	TableColumn,
	TextInputElement,
	TestimonialBlock,
	TestimonialItem,
	ToggleElement,
	TabBlock,
	TabPanel,
	VideoEmbedBlock,
} from "./types.js";

// ── Block Builders ───────────────────────────────────────────────────────────

function header(text: string, opts?: { blockId?: string }): HeaderBlock {
	return {
		type: "header",
		text,
		...(opts?.blockId !== undefined && { block_id: opts.blockId }),
	};
}

function section(text: string, opts?: { accessory?: Element; blockId?: string }): SectionBlock {
	return {
		type: "section",
		text,
		...(opts?.accessory !== undefined && { accessory: opts.accessory }),
		...(opts?.blockId !== undefined && { block_id: opts.blockId }),
	};
}

function divider(opts?: { blockId?: string }): DividerBlock {
	return {
		type: "divider",
		...(opts?.blockId !== undefined && { block_id: opts.blockId }),
	};
}

function fieldsBlock(
	fields: Array<{ label: string; value: string }>,
	opts?: { blockId?: string },
): FieldsBlock {
	return {
		type: "fields",
		fields,
		...(opts?.blockId !== undefined && { block_id: opts.blockId }),
	};
}

function table(opts: {
	blockId?: string;
	columns: TableColumn[];
	rows: Array<Record<string, unknown>>;
	nextCursor?: string;
	pageActionId: string;
	emptyText?: string;
}): TableBlock {
	return {
		type: "table",
		columns: opts.columns,
		rows: opts.rows,
		page_action_id: opts.pageActionId,
		...(opts.nextCursor !== undefined && { next_cursor: opts.nextCursor }),
		...(opts.emptyText !== undefined && { empty_text: opts.emptyText }),
		...(opts.blockId !== undefined && { block_id: opts.blockId }),
	};
}

function actionsBlock(elements: Element[], opts?: { blockId?: string }): ActionsBlock {
	return {
		type: "actions",
		elements,
		...(opts?.blockId !== undefined && { block_id: opts.blockId }),
	};
}

function stats(items: StatItem[], opts?: { blockId?: string }): StatsBlock {
	return {
		type: "stats",
		items,
		...(opts?.blockId !== undefined && { block_id: opts.blockId }),
	};
}

function form(opts: {
	blockId?: string;
	fields: FormField[];
	submit: { label: string; actionId: string };
}): FormBlock {
	return {
		type: "form",
		fields: opts.fields,
		submit: { label: opts.submit.label, action_id: opts.submit.actionId },
		...(opts.blockId !== undefined && { block_id: opts.blockId }),
	};
}

function image(opts: { url: string; alt: string; title?: string; blockId?: string }): ImageBlock {
	return {
		type: "image",
		url: opts.url,
		alt: opts.alt,
		...(opts.title !== undefined && { title: opts.title }),
		...(opts.blockId !== undefined && { block_id: opts.blockId }),
	};
}

function context(text: string, opts?: { blockId?: string }): ContextBlock {
	return {
		type: "context",
		text,
		...(opts?.blockId !== undefined && { block_id: opts.blockId }),
	};
}

function columnsBlock(columns: Block[][], opts?: { blockId?: string }): ColumnsBlock {
	return {
		type: "columns",
		columns,
		...(opts?.blockId !== undefined && { block_id: opts.blockId }),
	};
}

function bannerBlock(
	opts: {
		blockId?: string;
		variant?: "default" | "alert" | "error";
	} & ({ title: string; description?: string } | { title?: string; description: string }),
): BannerBlock {
	return {
		type: "banner",
		...(opts.title !== undefined && { title: opts.title }),
		...(opts.description !== undefined && { description: opts.description }),
		...(opts.variant !== undefined && { variant: opts.variant }),
		...(opts.blockId !== undefined && { block_id: opts.blockId }),
	};
}

// ── Element Builders ─────────────────────────────────────────────────────────

function textInput(
	actionId: string,
	label: string,
	opts?: {
		placeholder?: string;
		initialValue?: string;
		multiline?: boolean;
	},
): TextInputElement {
	return {
		type: "text_input",
		action_id: actionId,
		label,
		...(opts?.placeholder !== undefined && { placeholder: opts.placeholder }),
		...(opts?.initialValue !== undefined && {
			initial_value: opts.initialValue,
		}),
		...(opts?.multiline !== undefined && { multiline: opts.multiline }),
	};
}

function numberInput(
	actionId: string,
	label: string,
	opts?: { initialValue?: number; min?: number; max?: number },
): NumberInputElement {
	return {
		type: "number_input",
		action_id: actionId,
		label,
		...(opts?.initialValue !== undefined && {
			initial_value: opts.initialValue,
		}),
		...(opts?.min !== undefined && { min: opts.min }),
		...(opts?.max !== undefined && { max: opts.max }),
	};
}

function select(
	actionId: string,
	label: string,
	options: Array<{ label: string; value: string }>,
	opts?: { initialValue?: string },
): SelectElement {
	return {
		type: "select",
		action_id: actionId,
		label,
		options,
		...(opts?.initialValue !== undefined && {
			initial_value: opts.initialValue,
		}),
	};
}

function toggle(
	actionId: string,
	label: string,
	opts?: { description?: string; initialValue?: boolean },
): ToggleElement {
	return {
		type: "toggle",
		action_id: actionId,
		label,
		...(opts?.description !== undefined && { description: opts.description }),
		...(opts?.initialValue !== undefined && {
			initial_value: opts.initialValue,
		}),
	};
}

function button(
	actionId: string,
	label: string,
	opts?: {
		style?: "primary" | "danger" | "secondary";
		value?: unknown;
		confirm?: ConfirmDialog;
	},
): ButtonElement {
	return {
		type: "button",
		action_id: actionId,
		label,
		...(opts?.style !== undefined && { style: opts.style }),
		...(opts?.value !== undefined && { value: opts.value }),
		...(opts?.confirm !== undefined && { confirm: opts.confirm }),
	};
}

function secretInput(
	actionId: string,
	label: string,
	opts?: { placeholder?: string; hasValue?: boolean },
): SecretInputElement {
	return {
		type: "secret_input",
		action_id: actionId,
		label,
		...(opts?.placeholder !== undefined && { placeholder: opts.placeholder }),
		...(opts?.hasValue !== undefined && { has_value: opts.hasValue }),
	};
}

function checkbox(
	actionId: string,
	label: string,
	options: Array<{ label: string; value: string }>,
	opts?: { initialValue?: string[] },
): CheckboxElement {
	return {
		type: "checkbox",
		action_id: actionId,
		label,
		options,
		...(opts?.initialValue !== undefined && { initial_value: opts.initialValue }),
	};
}

function dateInput(
	actionId: string,
	label: string,
	opts?: { initialValue?: string; placeholder?: string },
): DateInputElement {
	return {
		type: "date_input",
		action_id: actionId,
		label,
		...(opts?.initialValue !== undefined && { initial_value: opts.initialValue }),
		...(opts?.placeholder !== undefined && { placeholder: opts.placeholder }),
	};
}

function combobox(
	actionId: string,
	label: string,
	options: Array<{ label: string; value: string }>,
	opts?: { initialValue?: string; placeholder?: string },
): ComboboxElement {
	return {
		type: "combobox",
		action_id: actionId,
		label,
		options,
		...(opts?.initialValue !== undefined && { initial_value: opts.initialValue }),
		...(opts?.placeholder !== undefined && { placeholder: opts.placeholder }),
	};
}

function radio(
	actionId: string,
	label: string,
	options: Array<{ label: string; value: string }>,
	opts?: { initialValue?: string },
): RadioElement {
	return {
		type: "radio",
		action_id: actionId,
		label,
		options,
		...(opts?.initialValue !== undefined && { initial_value: opts.initialValue }),
	};
}

function repeater(
	actionId: string,
	label: string,
	fields: RepeaterSubField[],
	opts?: {
		itemLabel?: string;
		minItems?: number;
		maxItems?: number;
		initialValue?: Array<Record<string, unknown>>;
	},
): RepeaterElement {
	return {
		type: "repeater",
		action_id: actionId,
		label,
		fields,
		...(opts?.itemLabel !== undefined && { item_label: opts.itemLabel }),
		...(opts?.minItems !== undefined && { min_items: opts.minItems }),
		...(opts?.maxItems !== undefined && { max_items: opts.maxItems }),
		...(opts?.initialValue !== undefined && { initial_value: opts.initialValue }),
	};
}

function mediaPicker(
	actionId: string,
	label: string,
	opts?: {
		mimeTypeFilter?: string;
		initialValue?: string;
		placeholder?: string;
	},
): MediaPickerElement {
	return {
		type: "media_picker",
		action_id: actionId,
		label,
		...(opts?.mimeTypeFilter !== undefined && { mime_type_filter: opts.mimeTypeFilter }),
		...(opts?.initialValue !== undefined && { initial_value: opts.initialValue }),
		...(opts?.placeholder !== undefined && { placeholder: opts.placeholder }),
	};
}

function timeseriesChart(opts: {
	blockId?: string;
	series: ChartSeries[];
	style?: "line" | "bar";
	xAxisName?: string;
	yAxisName?: string;
	height?: number;
	gradient?: boolean;
}): ChartBlock {
	return {
		type: "chart",
		config: {
			chart_type: "timeseries",
			series: opts.series,
			...(opts.style !== undefined && { style: opts.style }),
			...(opts.xAxisName !== undefined && { x_axis_name: opts.xAxisName }),
			...(opts.yAxisName !== undefined && { y_axis_name: opts.yAxisName }),
			...(opts.height !== undefined && { height: opts.height }),
			...(opts.gradient !== undefined && { gradient: opts.gradient }),
		},
		...(opts.blockId !== undefined && { block_id: opts.blockId }),
	};
}

function customChart(opts: {
	blockId?: string;
	options: Record<string, unknown>;
	height?: number;
}): ChartBlock {
	return {
		type: "chart",
		config: {
			chart_type: "custom",
			options: opts.options,
			...(opts.height !== undefined && { height: opts.height }),
		},
		...(opts.blockId !== undefined && { block_id: opts.blockId }),
	};
}

function meter(opts: {
	blockId?: string;
	label: string;
	value: number;
	max?: number;
	min?: number;
	customValue?: string;
}): MeterBlock {
	return {
		type: "meter",
		label: opts.label,
		value: opts.value,
		...(opts.max !== undefined && { max: opts.max }),
		...(opts.min !== undefined && { min: opts.min }),
		...(opts.customValue !== undefined && { custom_value: opts.customValue }),
		...(opts.blockId !== undefined && { block_id: opts.blockId }),
	};
}

function codeBlock(opts: {
	blockId?: string;
	code: string;
	language?: "ts" | "tsx" | "jsonc" | "bash" | "css";
}): CodeBlock {
	return {
		type: "code",
		code: opts.code,
		...(opts.language !== undefined && { language: opts.language }),
		...(opts.blockId !== undefined && { block_id: opts.blockId }),
	};
}

function tabBlock(
	panels: TabPanel[],
	opts?: {
		defaultTab?: number;
		blockId?: string;
	},
): TabBlock {
	return {
		type: "tab",
		panels,
		...(opts?.defaultTab !== undefined && { default_tab: opts.defaultTab }),
		...(opts?.blockId !== undefined && { block_id: opts.blockId }),
	};
}

function empty(opts: {
	blockId?: string;
	title: string;
	description?: string;
	commandLine?: string;
	size?: "sm" | "base" | "lg";
	actions?: Element[];
}): EmptyBlock {
	return {
		type: "empty",
		title: opts.title,
		...(opts.description !== undefined && { description: opts.description }),
		...(opts.commandLine !== undefined && { command_line: opts.commandLine }),
		...(opts.size !== undefined && { size: opts.size }),
		...(opts.actions !== undefined && { actions: opts.actions }),
		...(opts.blockId !== undefined && { block_id: opts.blockId }),
	};
}

function accordion(opts: {
	blockId?: string;
	label: string;
	blocks: Block[];
	defaultOpen?: boolean;
}): AccordionBlock {
	return {
		type: "accordion",
		label: opts.label,
		blocks: opts.blocks,
		...(opts.defaultOpen !== undefined && { default_open: opts.defaultOpen }),
		...(opts.blockId !== undefined && { block_id: opts.blockId }),
	};
}

function testimonial(opts: { blockId?: string; items: TestimonialItem[] }): TestimonialBlock {
	return {
		type: "testimonial",
		items: opts.items,
		...(opts.blockId !== undefined && { block_id: opts.blockId }),
	};
}

function card(opts: CardItem & { blockId?: string }): CardBlock {
	return {
		type: "card",
		title: opts.title,
		...(opts.description !== undefined && { description: opts.description }),
		...(opts.image !== undefined && { image: opts.image }),
		...(opts.ctaText !== undefined && { ctaText: opts.ctaText }),
		...(opts.ctaUrl !== undefined && { ctaUrl: opts.ctaUrl }),
		...(opts.blockId !== undefined && { block_id: opts.blockId }),
	};
}

function cardGrid(opts: {
	blockId?: string;
	title?: string;
	description?: string;
	columns?: 2 | 3 | 4;
	items: CardItem[];
}): CardGridBlock {
	return {
		type: "cardGrid",
		...(opts.title !== undefined && { title: opts.title }),
		...(opts.description !== undefined && { description: opts.description }),
		...(opts.columns !== undefined && { columns: opts.columns }),
		items: opts.items,
		...(opts.blockId !== undefined && { block_id: opts.blockId }),
	};
}

function icon(opts: { blockId?: string; name: string; label: string; description?: string }): IconBlock {
	return {
		type: "icon",
		name: opts.name,
		label: opts.label,
		...(opts.description !== undefined && { description: opts.description }),
		...(opts.blockId !== undefined && { block_id: opts.blockId }),
	};
}

function featureList(opts: {
	blockId?: string;
	title?: string;
	description?: string;
	columns?: number;
	items: FeatureListItem[];
}): FeatureListBlock {
	return {
		type: "featureList",
		...(opts.title !== undefined && { title: opts.title }),
		...(opts.description !== undefined && { description: opts.description }),
		...(opts.columns !== undefined && { columns: opts.columns }),
		items: opts.items,
		...(opts.blockId !== undefined && { block_id: opts.blockId }),
	};
}

function logoCloud(opts: {
	blockId?: string;
	title?: string;
	items: LogoCloudItem[];
}): LogoCloudBlock {
	return {
		type: "logoCloud",
		...(opts.title !== undefined && { title: opts.title }),
		items: opts.items,
		...(opts.blockId !== undefined && { block_id: opts.blockId }),
	};
}

function steps(opts: {
	blockId?: string;
	title?: string;
	items: StepItem[];
}): StepsBlock {
	return {
		type: "steps",
		...(opts.title !== undefined && { title: opts.title }),
		items: opts.items,
		...(opts.blockId !== undefined && { block_id: opts.blockId }),
	};
}

function faq(opts: { blockId?: string; items: FaqItem[] }): FaqBlock {
	return {
		type: "faq",
		items: opts.items,
		...(opts.blockId !== undefined && { block_id: opts.blockId }),
	};
}

function videoEmbed(opts: {
	blockId?: string;
	title?: string;
	provider?: "youtube" | "vimeo" | "custom";
	embedUrl: string;
	caption?: string;
	poster?: string;
}): VideoEmbedBlock {
	return {
		type: "videoEmbed",
		...(opts.title !== undefined && { title: opts.title }),
		...(opts.provider !== undefined && { provider: opts.provider }),
		embedUrl: opts.embedUrl,
		...(opts.caption !== undefined && { caption: opts.caption }),
		...(opts.poster !== undefined && { poster: opts.poster }),
		...(opts.blockId !== undefined && { block_id: opts.blockId }),
	};
}

function pricingTable(opts: {
	blockId?: string;
	title?: string;
	description?: string;
	plans: PricingPlan[];
}): PricingTableBlock {
	return {
		type: "pricingTable",
		...(opts.title !== undefined && { title: opts.title }),
		...(opts.description !== undefined && { description: opts.description }),
		plans: opts.plans,
		...(opts.blockId !== undefined && { block_id: opts.blockId }),
	};
}

function ctaBanner(opts: {
	blockId?: string;
	title: string;
	description?: string;
	primaryAction: { label: string; href: string };
	secondaryAction?: { label: string; href: string };
	variant?: "default" | "dark" | "brand";
}): CtaBannerBlock {
	return {
		type: "ctaBanner",
		title: opts.title,
		...(opts.description !== undefined && { description: opts.description }),
		primaryAction: opts.primaryAction,
		...(opts.secondaryAction !== undefined && { secondaryAction: opts.secondaryAction }),
		...(opts.variant !== undefined && { variant: opts.variant }),
		...(opts.blockId !== undefined && { block_id: opts.blockId }),
	};
}

// ── Exports ──────────────────────────────────────────────────────────────────

export const blocks = {
	header,
	section,
	divider,
	fields: fieldsBlock,
	table,
	actions: actionsBlock,
	stats,
	form,
	image,
	context,
	columns: columnsBlock,
	timeseriesChart,
	customChart,
	banner: bannerBlock,
	meter,
	code: codeBlock,
	tab: tabBlock,
	empty,
	accordion,
	testimonial,
	card,
	cardGrid,
	icon,
	featureList,
	logoCloud,
	steps,
	faq,
	videoEmbed,
	pricingTable,
	ctaBanner,
};

export const elements = {
	textInput,
	numberInput,
	select,
	toggle,
	button,
	secretInput,
	checkbox,
	combobox,
	dateInput,
	radio,
	repeater,
	mediaPicker,
};
