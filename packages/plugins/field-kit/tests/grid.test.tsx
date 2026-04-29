import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Grid } from "../src/widgets/grid";

vi.mock("@cloudflare/kumo", () => ({
	Checkbox: ({ checked, onCheckedChange, "aria-label": ariaLabel }: any) => (
		<input
			type="checkbox"
			aria-label={ariaLabel}
			checked={!!checked}
			onChange={(e) => onCheckedChange?.(e.target.checked)}
		/>
	),
	Input: ({ value, onChange, "aria-label": ariaLabel, type }: any) => (
		<input type={type ?? "text"} aria-label={ariaLabel} value={value ?? ""} onChange={onChange} />
	),
	Select: ({ value, onValueChange, items, "aria-label": ariaLabel }: any) => (
		<select
			aria-label={ariaLabel}
			value={value ?? ""}
			onChange={(e) => onValueChange?.(e.target.value)}
		>
			<option value="">—</option>
			{(items ?? []).map((opt: any) => (
				<option key={opt.value} value={opt.value}>
					{opt.label}
				</option>
			))}
		</select>
	),
}));

afterEach(() => cleanup());

const rows = [
	{ key: "mon", label: "Mon" },
	{ key: "tue", label: "Tue" },
];
const columns = [
	{ key: "am", label: "AM" },
	{ key: "pm", label: "PM" },
];

describe("Grid widget", () => {
	it("renders all cells as toggle checkboxes by default", () => {
		render(<Grid value={{}} onChange={() => {}} label="Grid" id="g" options={{ rows, columns }} />);
		const boxes = screen.getAllByRole("checkbox");
		expect(boxes).toHaveLength(4); // 2 rows × 2 cols
	});

	it("reflects existing toggle values", () => {
		render(
			<Grid
				value={{ mon: { am: true, pm: false }, tue: { am: true } }}
				onChange={() => {}}
				label="Grid"
				id="g"
				options={{ rows, columns }}
			/>,
		);
		expect((screen.getByLabelText("Mon — AM") as HTMLInputElement).checked).toBe(true);
		expect((screen.getByLabelText("Mon — PM") as HTMLInputElement).checked).toBe(false);
		expect((screen.getByLabelText("Tue — AM") as HTMLInputElement).checked).toBe(true);
	});

	it("normalizes legacy array format on read", () => {
		render(
			<Grid
				value={{ mon: ["am", "pm"], tue: ["am"] }}
				onChange={() => {}}
				label="Grid"
				id="g"
				options={{ rows, columns }}
			/>,
		);
		expect((screen.getByLabelText("Mon — AM") as HTMLInputElement).checked).toBe(true);
		expect((screen.getByLabelText("Mon — PM") as HTMLInputElement).checked).toBe(true);
		expect((screen.getByLabelText("Tue — AM") as HTMLInputElement).checked).toBe(true);
		expect((screen.getByLabelText("Tue — PM") as HTMLInputElement).checked).toBe(false);
	});

	it("emits object-shape on toggle write (even when input was array format)", () => {
		const onChange = vi.fn();
		render(
			<Grid
				value={{ mon: ["am"] }}
				onChange={onChange}
				label="Grid"
				id="g"
				options={{ rows, columns }}
			/>,
		);
		fireEvent.click(screen.getByLabelText("Mon — PM"));
		expect(onChange).toHaveBeenCalledWith({
			mon: { am: true, pm: true },
			tue: {},
		});
	});

	it("renders text cells when cell is 'text'", () => {
		render(
			<Grid
				value={{}}
				onChange={() => {}}
				label="Grid"
				id="g"
				options={{ rows, columns, cell: "text" }}
			/>,
		);
		expect(screen.getAllByRole("textbox")).toHaveLength(4);
	});

	it("renders select cells with cellOptions", () => {
		render(
			<Grid
				value={{}}
				onChange={() => {}}
				label="Grid"
				id="g"
				options={{
					rows,
					columns,
					cell: "select",
					cellOptions: [
						{ label: "A", value: "a" },
						{ label: "B", value: "b" },
					],
				}}
			/>,
		);
		const selects = screen.getAllByRole("combobox");
		expect(selects).toHaveLength(4);
	});

	it("preserves unknown cell keys on write so evolving schemas don't drop data", () => {
		const onChange = vi.fn();
		render(
			<Grid
				value={{ mon: { am: true, legacy: "keep-me" } }}
				onChange={onChange}
				label="Grid"
				id="g"
				options={{ rows, columns }}
			/>,
		);
		fireEvent.click(screen.getByLabelText("Mon — PM"));
		expect(onChange).toHaveBeenCalledWith({
			mon: { am: true, pm: true, legacy: "keep-me" },
			tue: {},
		});
	});

	it("shows misconfigured warning when rows or columns are missing", () => {
		render(
			<Grid
				value={{}}
				onChange={() => {}}
				label="Grid"
				id="g"
				options={{ rows: [], columns: [] }}
			/>,
		);
		expect(screen.queryByText(/Widget misconfigured/i)).not.toBeNull();
	});
});
