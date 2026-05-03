import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BlockRenderer } from "../src/renderer.js";
import type { Block, BlockInteraction } from "../src/types.js";

// ── Mocks ────────────────────────────────────────────────────────────────────

vi.mock("@cloudflare/kumo", () => ({
	Button: ({ children, onClick, variant, type }: any) => (
		<button onClick={onClick} data-variant={variant} type={type || "button"}>
			{children}
		</button>
	),
	Badge: ({ children }: any) => <span data-testid="badge">{children}</span>,
	Input: ({ label, value, defaultValue, onChange, onBlur, placeholder, type, min, max }: any) => (
		<div>
			<label>{label}</label>
			<input
				type={type || "text"}
				defaultValue={defaultValue}
				value={value}
				placeholder={placeholder}
				min={min}
				max={max}
				onChange={onChange}
				onBlur={onBlur}
			/>
		</div>
	),
	InputArea: ({ label, defaultValue, onChange, onBlur, placeholder }: any) => (
		<div>
			<label>{label}</label>
			<textarea
				defaultValue={defaultValue}
				placeholder={placeholder}
				onChange={onChange}
				onBlur={onBlur}
			/>
		</div>
	),
	Select: Object.assign(
		({ children, label, defaultValue, onValueChange }: any) => (
			<div>
				<label>{label}</label>
				<select defaultValue={defaultValue} onChange={(e: any) => onValueChange?.(e.target.value)}>
					{children}
				</select>
			</div>
		),
		{
			Option: ({ children, value }: any) => <option value={value}>{children}</option>,
		},
	),
	Switch: ({ label, checked, onCheckedChange }: any) => (
		<div>
			<label>
				<input
					type="checkbox"
					checked={checked}
					onChange={(e: any) => onCheckedChange?.(e.target.checked)}
				/>
				{label}
			</label>
		</div>
	),
	SensitiveInput: ({
		label,
		value,
		onValueChange,
		readOnly,
		onFocus,
		onBlur,
		placeholder,
	}: any) => (
		<div>
			<label>{label}</label>
			<input
				type="password"
				value={value}
				readOnly={readOnly}
				onFocus={onFocus}
				onBlur={onBlur}
				placeholder={placeholder}
				onChange={(e: any) => onValueChange?.(e.target.value)}
			/>
		</div>
	),
	Dialog: ({ children }: any) => <div data-testid="dialog">{children}</div>,
	DialogRoot: ({ children, open }: any) =>
		open ? <div data-testid="dialog-root">{children}</div> : null,
	Banner: ({ title, description, variant, icon }: any) => (
		<div data-testid="banner" data-variant={variant}>
			{icon}
			{title && <strong>{title}</strong>}
			{description && <p>{description}</p>}
		</div>
	),
	Meter: ({ label, value, max, min, customValue }: any) => (
		<div data-testid="meter" data-value={value} data-max={max} data-min={min}>
			<span>{label}</span>
			{customValue && <span>{customValue}</span>}
		</div>
	),
	CodeBlock: ({ code, lang }: any) => (
		<pre data-testid="code-block" data-lang={lang}>
			<code>{code}</code>
		</pre>
	),
	Empty: ({ title, description, commandLine, size, contents, icon }: any) => (
		<div data-testid="empty" data-size={size ?? "base"}>
			{icon}
			<strong>{title}</strong>
			{description && <p>{description}</p>}
			{commandLine && <pre data-testid="empty-command">{commandLine}</pre>}
			{contents}
		</div>
	),
	Tabs: ({ tabs, value, onValueChange }: any) => (
		<div role="tablist">
			{tabs.map((tab: any) => (
				<button
					key={tab.value}
					role="tab"
					aria-selected={value === tab.value}
					onClick={() => onValueChange?.(tab.value)}
				>
					{tab.label}
				</button>
			))}
		</div>
	),
	Checkbox: {
		Group: ({ children, legend }: any) => (
			<fieldset data-testid="checkbox-group">
				<legend>{legend}</legend>
				{children}
			</fieldset>
		),
		Item: ({ label, value }: any) => (
			<label>
				<input type="checkbox" value={value} />
				{label}
			</label>
		),
	},
	Radio: {
		Group: ({ children, legend }: any) => (
			<fieldset data-testid="radio-group">
				<legend>{legend}</legend>
				{children}
			</fieldset>
		),
		Item: ({ label, value }: any) => (
			<label>
				<input type="radio" value={value} />
				{label}
			</label>
		),
	},
	Collapsible: ({ children, label, open, onOpenChange }: any) => (
		<div data-testid="collapsible" data-open={open ? "true" : "false"}>
			<button type="button" onClick={() => onOpenChange?.(!open)}>
				{label}
			</button>
			{open && <div data-testid="collapsible-content">{children}</div>}
		</div>
	),
	Combobox: Object.assign(
		({ children, label }: any) => (
			<div data-testid="combobox">
				<label>{label}</label>
				{children}
			</div>
		),
		{
			TriggerInput: ({ placeholder }: any) => <input placeholder={placeholder} />,
			Content: ({ children }: any) => <div>{children}</div>,
			List: ({ children }: any) => <div>{typeof children === "function" ? null : children}</div>,
			Item: ({ children, value }: any) => <div data-value={value}>{children}</div>,
			Empty: ({ children }: any) => <div>{children}</div>,
		},
	),
}));

vi.mock("@cloudflare/kumo/components/chart", () => ({
	TimeseriesChart: (props: any) => (
		<div data-testid="timeseries-chart" data-height={props.height} />
	),
	Chart: (props: any) => <div data-testid="custom-chart" data-height={props.height} />,
	ChartPalette: { color: (i: number) => `#color${i}` },
}));

// eslint-disable-next-line unicorn/consistent-function-scoping -- vi.mock is hoisted; cannot reference outer scope
vi.mock("echarts/core", () => {
	const noop = () => {};
	return { __esModule: true, default: { use: noop }, use: noop };
});

vi.mock("echarts/charts", () => ({
	BarChart: {},
	LineChart: {},
	PieChart: {},
}));

vi.mock("echarts/components", () => ({
	AriaComponent: {},
	AxisPointerComponent: {},
	GridComponent: {},
	TooltipComponent: {},
}));

vi.mock("echarts/renderers", () => ({
	CanvasRenderer: {},
}));

vi.mock("@phosphor-icons/react", () => ({
	ArrowUp: () => <span data-testid="arrow-up" />,
	ArrowDown: () => <span data-testid="arrow-down" />,
	Minus: () => <span data-testid="minus" />,
	Info: () => <span data-testid="icon-info" />,
	Warning: () => <span data-testid="icon-warning" />,
	WarningCircle: () => <span data-testid="icon-warning-circle" />,
	Package: () => <span data-testid="icon-package" />,
}));

afterEach(cleanup);

// ── Helpers ──────────────────────────────────────────────────────────────────

function renderBlocks(blocks: Block[], onAction?: (i: BlockInteraction) => void) {
	const handler = onAction ?? vi.fn();
	return { ...render(<BlockRenderer blocks={blocks} onAction={handler} />), onAction: handler };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("BlockRenderer", () => {
	it("header block renders h2 with text", () => {
		renderBlocks([{ type: "header", text: "Settings" }]);
		const heading = screen.getByText("Settings");
		expect(heading.tagName).toBe("H2");
	});

	it("section block renders text", () => {
		renderBlocks([{ type: "section", text: "Configure your integration." }]);
		expect(screen.getByText("Configure your integration.")).toBeTruthy();
	});

	it("section block renders accessory button", () => {
		renderBlocks([
			{
				type: "section",
				text: "Webhook endpoint",
				accessory: { type: "button", action_id: "edit", label: "Edit" },
			},
		]);
		expect(screen.getByText("Webhook endpoint")).toBeTruthy();
		expect(screen.getByText("Edit")).toBeTruthy();
	});

	it("divider block renders hr", () => {
		const { container } = renderBlocks([{ type: "divider" }]);
		expect(container.querySelector("hr")).toBeTruthy();
	});

	it("fields block renders labels and values in grid", () => {
		renderBlocks([
			{
				type: "fields",
				fields: [
					{ label: "Status", value: "Active" },
					{ label: "Plan", value: "Pro" },
				],
			},
		]);
		expect(screen.getByText("Status")).toBeTruthy();
		expect(screen.getByText("Active")).toBeTruthy();
		expect(screen.getByText("Plan")).toBeTruthy();
		expect(screen.getByText("Pro")).toBeTruthy();
	});

	it("fields block sets title attribute on value for overflow tooltip", () => {
		const { container } = renderBlocks([
			{
				type: "fields",
				fields: [{ label: "Status", value: "Active" }],
			},
		]);
		const valueEl = container.querySelector('[title="Active"]');
		expect(valueEl).toBeTruthy();
		expect(valueEl?.textContent).toBe("Active");
	});

	it("table block renders column headers and row data", () => {
		renderBlocks([
			{
				type: "table",
				columns: [
					{ key: "name", label: "Name" },
					{ key: "role", label: "Role" },
				],
				rows: [{ name: "Alice", role: "Admin" }],
				page_action_id: "page",
			},
		]);
		expect(screen.getByText("Name")).toBeTruthy();
		expect(screen.getByText("Role")).toBeTruthy();
		expect(screen.getByText("Alice")).toBeTruthy();
		expect(screen.getByText("Admin")).toBeTruthy();
	});

	it("table block shows empty_text when rows empty", () => {
		renderBlocks([
			{
				type: "table",
				columns: [{ key: "name", label: "Name" }],
				rows: [],
				page_action_id: "page",
				empty_text: "No items found",
			},
		]);
		expect(screen.getByText("No items found")).toBeTruthy();
	});

	it("table badge format renders Badge component", () => {
		renderBlocks([
			{
				type: "table",
				columns: [{ key: "status", label: "Status", format: "badge" as const }],
				rows: [{ status: "Active" }],
				page_action_id: "page",
			},
		]);
		expect(screen.getByTestId("badge")).toBeTruthy();
		expect(screen.getByTestId("badge").textContent).toBe("Active");
	});

	it("actions block renders buttons horizontally", () => {
		renderBlocks([
			{
				type: "actions",
				elements: [
					{ type: "button", action_id: "a1", label: "Save" },
					{ type: "button", action_id: "a2", label: "Cancel" },
				],
			},
		]);
		expect(screen.getByText("Save")).toBeTruthy();
		expect(screen.getByText("Cancel")).toBeTruthy();
	});

	it("stats block renders stat cards with values", () => {
		renderBlocks([
			{
				type: "stats",
				items: [
					{ label: "Posts", value: 120 },
					{ label: "Users", value: "5k" },
				],
			},
		]);
		expect(screen.getByText("Posts")).toBeTruthy();
		expect(screen.getByText("120")).toBeTruthy();
		expect(screen.getByText("Users")).toBeTruthy();
		expect(screen.getByText("5k")).toBeTruthy();
	});

	it("stats block renders trend arrows", () => {
		renderBlocks([
			{
				type: "stats",
				items: [
					{ label: "Revenue", value: 100, trend: "up" },
					{ label: "Errors", value: 3, trend: "down" },
					{ label: "Latency", value: "50ms", trend: "neutral" },
				],
			},
		]);
		expect(screen.getByTestId("arrow-up")).toBeTruthy();
		expect(screen.getByTestId("arrow-down")).toBeTruthy();
		expect(screen.getByTestId("minus")).toBeTruthy();
	});

	it("form block renders fields and submit button", () => {
		renderBlocks([
			{
				type: "form",
				fields: [{ type: "text_input", action_id: "title", label: "Title" }],
				submit: { label: "Create", action_id: "create" },
			},
		]);
		expect(screen.getByText("Title")).toBeTruthy();
		expect(screen.getByText("Create")).toBeTruthy();
	});

	it("form onAction fires form_submit with collected values", () => {
		const onAction = vi.fn();
		renderBlocks(
			[
				{
					type: "form",
					block_id: "my_form",
					fields: [
						{
							type: "text_input",
							action_id: "title",
							label: "Title",
							initial_value: "Hello",
						},
						{
							type: "toggle",
							action_id: "published",
							label: "Published",
							initial_value: true,
						},
					],
					submit: { label: "Save", action_id: "save_post" },
				},
			],
			onAction,
		);

		// Submit the form
		const submitBtn = screen.getByText("Save");
		fireEvent.click(submitBtn);

		expect(onAction).toHaveBeenCalledWith({
			type: "form_submit",
			action_id: "save_post",
			block_id: "my_form",
			values: { title: "Hello", published: true },
		});
	});

	it("image block renders img with src and alt", () => {
		renderBlocks([
			{
				type: "image",
				url: "https://example.com/photo.jpg",
				alt: "A photo",
			},
		]);
		const img = screen.getByAltText("A photo") as HTMLImageElement;
		expect(img.src).toBe("https://example.com/photo.jpg");
	});

	it("media_grid block renders media cards and nested actions", () => {
		const onAction = vi.fn();
		renderBlocks(
			[
				{
					type: "media_grid",
					columns: 4,
					items: [
						{
							url: "https://example.com/photo.jpg",
							alt: "A product screenshot",
							title: "Product screenshot",
							description: "Shows the dashboard.",
							badge: "Featured",
							actions: [{ type: "button", action_id: "view", label: "View" }],
						},
					],
				},
			],
			onAction,
		);

		const img = screen.getByAltText("A product screenshot") as HTMLImageElement;
		expect(img.src).toBe("https://example.com/photo.jpg");
		expect(screen.getByText("Product screenshot")).toBeTruthy();
		expect(screen.getByText("Shows the dashboard.")).toBeTruthy();
		expect(screen.getByTestId("badge").textContent).toBe("Featured");

		fireEvent.click(screen.getByText("View"));
		expect(onAction).toHaveBeenCalledWith({ type: "block_action", action_id: "view" });
	});

	it("media_grid block shows empty_text when items are empty", () => {
		renderBlocks([{ type: "media_grid", items: [], empty_text: "No media yet" }]);
		expect(screen.getByText("No media yet")).toBeTruthy();
	});

	it("media_grid block previews root-relative URLs", () => {
		renderBlocks([{ type: "media_grid", items: [{ url: "/uploads/photo.jpg", alt: "Upload" }] }]);
		const img = screen.getByAltText("Upload") as HTMLImageElement;
		expect(img.getAttribute("src")).toBe("/uploads/photo.jpg");
	});

	it("media_grid block does not use unsafe URLs as img src", () => {
		const unsafeUrls = [
			"//example.com/image.jpg",
			"javascript:alert(1)",
			"data:image/svg+xml,<svg></svg>",
			"ftp://example.com/image.jpg",
		];

		const { container } = renderBlocks([
			{
				type: "media_grid",
				items: unsafeUrls.map((url, i) => ({ url, alt: `Unsafe ${i}` })),
			},
		]);

		expect(container.querySelectorAll("img").length).toBe(0);
		expect(screen.getAllByText("Preview unavailable").length).toBe(unsafeUrls.length);
	});

	it("context block renders small muted text", () => {
		renderBlocks([{ type: "context", text: "Updated just now" }]);
		const el = screen.getByText("Updated just now");
		expect(el.tagName).toBe("P");
		expect(el.className).toContain("text-sm");
	});

	it("empty block renders title and default icon", () => {
		renderBlocks([{ type: "empty", title: "No items" }]);
		expect(screen.getByText("No items")).toBeTruthy();
		expect(screen.getByTestId("icon-package")).toBeTruthy();
		expect(screen.getByTestId("empty").getAttribute("data-size")).toBe("base");
	});

	it("empty block renders description, command line, size, and action buttons", () => {
		const onAction = vi.fn();
		renderBlocks(
			[
				{
					type: "empty",
					title: "No webhooks yet",
					description: "Create your first webhook.",
					command_line: "emdash webhooks create",
					size: "lg",
					actions: [
						{ type: "button", action_id: "create", label: "Create webhook", style: "primary" },
					],
				},
			],
			onAction,
		);

		expect(screen.getByText("Create your first webhook.")).toBeTruthy();
		expect(screen.getByTestId("empty-command").textContent).toBe("emdash webhooks create");
		expect(screen.getByTestId("empty").getAttribute("data-size")).toBe("lg");

		fireEvent.click(screen.getByText("Create webhook"));
		expect(onAction).toHaveBeenCalledWith({ type: "block_action", action_id: "create" });
	});

	it("empty block omits contents when actions array is empty", () => {
		const { container } = renderBlocks([{ type: "empty", title: "X", actions: [] }]);
		expect(container.querySelectorAll("button").length).toBe(0);
	});

	it("accordion block renders label closed by default and reveals nested blocks on open", () => {
		const { container } = renderBlocks([
			{
				type: "accordion",
				label: "Advanced",
				blocks: [{ type: "header", text: "Hidden heading" }],
			},
		]);

		expect(screen.getByText("Advanced")).toBeTruthy();
		expect(container.querySelector('[data-testid="collapsible"]')?.getAttribute("data-open")).toBe(
			"false",
		);
		expect(screen.queryByText("Hidden heading")).toBeNull();

		fireEvent.click(screen.getByText("Advanced"));
		expect(screen.getByText("Hidden heading")).toBeTruthy();
	});

	it("accordion block respects default_open and forwards onAction from nested blocks", () => {
		const onAction = vi.fn();
		renderBlocks(
			[
				{
					type: "accordion",
					label: "Tools",
					default_open: true,
					blocks: [
						{
							type: "actions",
							elements: [{ type: "button", action_id: "ping", label: "Ping" }],
						},
					],
				},
			],
			onAction,
		);

		fireEvent.click(screen.getByText("Ping"));
		expect(onAction).toHaveBeenCalledWith({ type: "block_action", action_id: "ping" });
	});

	it("columns block renders blocks in columns", () => {
		renderBlocks([
			{
				type: "columns",
				columns: [[{ type: "header", text: "Left" }], [{ type: "header", text: "Right" }]],
			},
		]);
		expect(screen.getByText("Left")).toBeTruthy();
		expect(screen.getByText("Right")).toBeTruthy();
	});

	it("tab block renders panel labels and shows first panel by default", () => {
		renderBlocks([
			{
				type: "tab",
				panels: [
					{ label: "General", blocks: [{ type: "header", text: "General Settings" }] },
					{ label: "Advanced", blocks: [{ type: "header", text: "Advanced Settings" }] },
				],
			},
		]);
		expect(screen.getByText("General")).toBeTruthy();
		expect(screen.getByText("Advanced")).toBeTruthy();
		expect(screen.getByText("General Settings")).toBeTruthy();
		expect(screen.queryByText("Advanced Settings")).toBeNull();
	});

	it("tab block switches panel on tab click", () => {
		renderBlocks([
			{
				type: "tab",
				panels: [
					{ label: "General", blocks: [{ type: "header", text: "General Settings" }] },
					{ label: "Advanced", blocks: [{ type: "header", text: "Advanced Settings" }] },
				],
			},
		]);
		fireEvent.click(screen.getByText("Advanced"));
		expect(screen.queryByText("General Settings")).toBeNull();
		expect(screen.getByText("Advanced Settings")).toBeTruthy();
	});

	it("tab block respects default_tab", () => {
		renderBlocks([
			{
				type: "tab",
				default_tab: 1,
				panels: [
					{ label: "General", blocks: [{ type: "header", text: "General Settings" }] },
					{ label: "Advanced", blocks: [{ type: "header", text: "Advanced Settings" }] },
				],
			},
		]);
		expect(screen.queryByText("General Settings")).toBeNull();
		expect(screen.getByText("Advanced Settings")).toBeTruthy();
	});

	it("button click fires onAction with block_action", () => {
		const onAction = vi.fn();
		renderBlocks(
			[
				{
					type: "actions",
					elements: [
						{
							type: "button",
							action_id: "do_thing",
							label: "Do thing",
							value: { id: 42 },
						},
					],
				},
			],
			onAction,
		);

		fireEvent.click(screen.getByText("Do thing"));

		expect(onAction).toHaveBeenCalledWith({
			type: "block_action",
			action_id: "do_thing",
			value: { id: 42 },
		});
	});

	it("button with confirm shows dialog, confirm fires action", () => {
		const onAction = vi.fn();
		renderBlocks(
			[
				{
					type: "actions",
					elements: [
						{
							type: "button",
							action_id: "delete_item",
							label: "Delete",
							style: "danger",
							value: "item_1",
							confirm: {
								title: "Delete item?",
								text: "This cannot be undone.",
								confirm: "Yes, delete",
								deny: "Cancel",
							},
						},
					],
				},
			],
			onAction,
		);

		// Initially no dialog
		expect(screen.queryByTestId("dialog-root")).toBeNull();

		// Click button — dialog appears
		fireEvent.click(screen.getByText("Delete"));
		expect(screen.getByTestId("dialog-root")).toBeTruthy();
		expect(screen.getByText("Delete item?")).toBeTruthy();
		expect(screen.getByText("This cannot be undone.")).toBeTruthy();

		// Click confirm — fires action
		fireEvent.click(screen.getByText("Yes, delete"));
		expect(onAction).toHaveBeenCalledWith({
			type: "block_action",
			action_id: "delete_item",
			value: "item_1",
		});
	});
});
