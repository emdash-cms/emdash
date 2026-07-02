import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BlockRenderer } from "../src/renderer.js";
import type { BlockInteraction, FormBlock } from "../src/types.js";

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
	Circle: () => <span data-testid="icon-circle" />,
	CheckCircle: () => <span data-testid="icon-check-circle" />,
	XCircle: () => <span data-testid="icon-x-circle" />,
	Info: () => <span data-testid="icon-info" />,
	Warning: () => <span data-testid="icon-warning" />,
	WarningCircle: () => <span data-testid="icon-warning-circle" />,
}));

afterEach(cleanup);

// ── Helpers ──────────────────────────────────────────────────────────────────

function renderForm(form: FormBlock, onAction?: (i: BlockInteraction) => void) {
	const handler = onAction ?? vi.fn();
	return {
		...render(<BlockRenderer blocks={[form]} onAction={handler} />),
		onAction: handler,
	};
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("form conditional fields", () => {
	it("condition eq: field shown when condition met", () => {
		renderForm({
			type: "form",
			fields: [
				{
					type: "toggle",
					action_id: "enable",
					label: "Enable",
					initial_value: true,
				},
				{
					type: "text_input",
					action_id: "name",
					label: "Name",
					condition: { field: "enable", eq: true },
				},
			],
			submit: { label: "Save", action_id: "save" },
		});

		// Toggle is true → Name field should be visible
		expect(screen.getByText("Name")).toBeTruthy();
	});

	it("condition eq: field hidden when condition not met", () => {
		renderForm({
			type: "form",
			fields: [
				{
					type: "toggle",
					action_id: "enable",
					label: "Enable",
					initial_value: false,
				},
				{
					type: "text_input",
					action_id: "name",
					label: "Name",
					condition: { field: "enable", eq: true },
				},
			],
			submit: { label: "Save", action_id: "save" },
		});

		// Toggle is false → Name field should not be rendered
		expect(screen.queryByText("Name")).toBeNull();
	});

	it("condition neq: field shown when value differs", () => {
		renderForm({
			type: "form",
			fields: [
				{
					type: "select",
					action_id: "status",
					label: "Status",
					options: [
						{ label: "Active", value: "active" },
						{ label: "Disabled", value: "disabled" },
					],
					initial_value: "active",
				},
				{
					type: "text_input",
					action_id: "reason",
					label: "Reason",
					condition: { field: "status", neq: "disabled" },
				},
			],
			submit: { label: "Save", action_id: "save" },
		});

		// Status is "active" which is != "disabled" → Reason field visible
		expect(screen.getByText("Reason")).toBeTruthy();
	});

	it("condition reacts to changes", () => {
		renderForm({
			type: "form",
			fields: [
				{
					type: "toggle",
					action_id: "show_extra",
					label: "Show extra",
					initial_value: false,
				},
				{
					type: "text_input",
					action_id: "extra",
					label: "Extra field",
					condition: { field: "show_extra", eq: true },
				},
			],
			submit: { label: "Save", action_id: "save" },
		});

		// Initially hidden
		expect(screen.queryByText("Extra field")).toBeNull();

		// Click toggle to enable
		const toggle = screen.getByRole("checkbox");
		fireEvent.click(toggle);

		// Now visible
		expect(screen.getByText("Extra field")).toBeTruthy();
	});

	it("hidden field values are included in submit payload", () => {
		const onAction = vi.fn();
		renderForm(
			{
				type: "form",
				fields: [
					{
						type: "toggle",
						action_id: "show_name",
						label: "Show name",
						initial_value: true,
					},
					{
						type: "text_input",
						action_id: "name",
						label: "Name",
						initial_value: "Alice",
						condition: { field: "show_name", eq: true },
					},
				],
				submit: { label: "Save", action_id: "save" },
			},
			onAction,
		);

		// Field is visible, then hide it by toggling off
		const toggle = screen.getByRole("checkbox");
		fireEvent.click(toggle);

		// Name field is now hidden
		expect(screen.queryByText("Name")).toBeNull();

		// Submit — hidden field's last known value should still be in payload
		fireEvent.click(screen.getByText("Save"));

		expect(onAction).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "form_submit",
				action_id: "save",
				values: expect.objectContaining({
					show_name: false,
					name: "Alice",
				}),
			}),
		);
	});

	it("multiple conditional fields evaluate independently", () => {
		renderForm({
			type: "form",
			fields: [
				{
					type: "toggle",
					action_id: "toggle_a",
					label: "Toggle A",
					initial_value: true,
				},
				{
					type: "toggle",
					action_id: "toggle_b",
					label: "Toggle B",
					initial_value: false,
				},
				{
					type: "text_input",
					action_id: "field_a",
					label: "Field A",
					condition: { field: "toggle_a", eq: true },
				},
				{
					type: "text_input",
					action_id: "field_b",
					label: "Field B",
					condition: { field: "toggle_b", eq: true },
				},
			],
			submit: { label: "Save", action_id: "save" },
		});

		// Toggle A is true → Field A visible
		expect(screen.getByText("Field A")).toBeTruthy();

		// Toggle B is false → Field B hidden
		expect(screen.queryByText("Field B")).toBeNull();
	});
});
