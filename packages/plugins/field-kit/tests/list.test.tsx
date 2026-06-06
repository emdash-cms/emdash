import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { List } from "../src/widgets/list";

vi.mock("@cloudflare/kumo", () => ({
	Button: ({ children, onClick, icon, "aria-label": ariaLabel, disabled }: any) => (
		<button type="button" onClick={onClick} aria-label={ariaLabel} disabled={disabled}>
			{icon}
			{children}
		</button>
	),
	Input: ({ label, value, onChange, type, id }: any) => (
		<label>
			{label}
			<input id={id} type={type ?? "text"} value={value ?? ""} onChange={onChange} />
		</label>
	),
	InputArea: ({ label, value, onChange, id }: any) => (
		<label>
			{label}
			<textarea id={id} value={value ?? ""} onChange={onChange} />
		</label>
	),
	Select: ({ label, value, onValueChange, items }: any) => (
		<label>
			{label}
			<select value={value ?? ""} onChange={(e) => onValueChange?.(e.target.value)}>
				<option value="">—</option>
				{(items ?? []).map((opt: any) => (
					<option key={opt.value} value={opt.value}>
						{opt.label}
					</option>
				))}
			</select>
		</label>
	),
	Switch: ({ label, checked, onCheckedChange, id }: any) => (
		<label>
			{label}
			<input
				id={id}
				role="switch"
				type="checkbox"
				checked={!!checked}
				onChange={(e) => onCheckedChange?.(e.target.checked)}
			/>
		</label>
	),
}));

vi.mock("@phosphor-icons/react", () => ({
	CaretRight: () => <span>▸</span>,
	CaretUp: () => <span>▲</span>,
	CaretDown: () => <span>▼</span>,
	Plus: () => <span>+</span>,
	X: () => <span>×</span>,
}));

afterEach(() => cleanup());

const fields = [
	{ key: "name", label: "Name", type: "text" as const },
	{ key: "amount", label: "Amount", type: "text" as const },
];

describe("List widget", () => {
	it("renders each item as a summary row using the summary template", () => {
		render(
			<List
				value={[
					{ name: "Flour", amount: "500g" },
					{ name: "Sugar", amount: "100g" },
				]}
				onChange={() => {}}
				label="Ingredients"
				id="ing"
				options={{ fields, summary: "{{name}} — {{amount}}" }}
			/>,
		);
		expect(screen.getByRole("button", { name: /Flour — 500g/ })).not.toBeNull();
		expect(screen.getByRole("button", { name: /Sugar — 100g/ })).not.toBeNull();
	});

	it("falls back to itemLabel + index when no summary template", () => {
		render(
			<List
				value={[{ name: "a" }, { name: "b" }]}
				onChange={() => {}}
				label="Items"
				id="x"
				options={{ fields, itemLabel: "Thing" }}
			/>,
		);
		// Summary buttons for both rows use itemLabel + index
		const summaryButtons = screen
			.getAllByRole("button")
			.filter((b) => /Thing \d$/.test(b.textContent ?? ""));
		expect(summaryButtons.map((b) => b.textContent?.trim())).toEqual(
			expect.arrayContaining([
				expect.stringMatching(/Thing 1$/),
				expect.stringMatching(/Thing 2$/),
			]),
		);
	});

	it("adds a new empty item when Add is clicked", () => {
		const onChange = vi.fn();
		render(<List value={[]} onChange={onChange} label="Items" id="x" options={{ fields }} />);
		fireEvent.click(screen.getByRole("button", { name: /Add Item/ }));
		expect(onChange).toHaveBeenCalledWith([{ name: undefined, amount: undefined }]);
	});

	it("removes an item", () => {
		const onChange = vi.fn();
		render(
			<List
				value={[{ name: "a" }, { name: "b" }]}
				onChange={onChange}
				label="Items"
				id="x"
				options={{ fields }}
			/>,
		);
		const [, removeB] = screen.getAllByRole("button", {
			name: /Remove Item/,
		});
		fireEvent.click(removeB!);
		expect(onChange).toHaveBeenCalledWith([{ name: "a", amount: undefined }]);
	});

	it("reorders items with move down", () => {
		const onChange = vi.fn();
		render(
			<List
				value={[{ name: "a" }, { name: "b" }]}
				onChange={onChange}
				label="Items"
				id="x"
				options={{ fields }}
			/>,
		);
		const downButtons = screen.getAllByLabelText("Move down");
		fireEvent.click(downButtons[0]!);
		expect(onChange).toHaveBeenCalledWith([
			{ name: "b", amount: undefined },
			{ name: "a", amount: undefined },
		]);
	});

	it("respects max: add button disappears at limit", () => {
		render(
			<List
				value={[{ name: "a" }, { name: "b" }]}
				onChange={() => {}}
				label="Items"
				id="x"
				options={{ fields, max: 2 }}
			/>,
		);
		expect(screen.queryByRole("button", { name: /Add/i })).toBeNull();
	});

	it("respects min: remove buttons disappear at limit", () => {
		render(
			<List
				value={[{ name: "a" }]}
				onChange={() => {}}
				label="Items"
				id="x"
				options={{ fields, min: 1 }}
			/>,
		);
		expect(screen.queryAllByRole("button", { name: /Remove Item/ })).toHaveLength(0);
	});

	it("shows empty-state message when no items", () => {
		render(<List value={[]} onChange={() => {}} label="Items" id="x" options={{ fields }} />);
		expect(screen.queryByText(/No items yet/i)).not.toBeNull();
	});

	it("shows misconfigured warning when fields is empty", () => {
		render(<List value={[]} onChange={() => {}} label="Items" id="x" options={{ fields: [] }} />);
		expect(screen.queryByText(/Widget misconfigured/i)).not.toBeNull();
	});

	it("scopes sub-field ids under the parent field id for each expanded item", () => {
		const { container } = render(
			<List
				value={[{ name: "a" }, { name: "b" }]}
				onChange={() => {}}
				label="Ingredients"
				id="ing"
				options={{ fields }}
			/>,
		);
		// Default: first item expanded → sub-field id scoped to parent "ing"
		let nameInputs = container.querySelectorAll('input[id*="-name"]');
		expect(nameInputs.length).toBe(1);
		const firstId = (nameInputs[0] as HTMLInputElement).id;
		expect(firstId.startsWith("ing-")).toBe(true);
		expect(firstId.endsWith("-name")).toBe(true);

		// Collapse first, expand second → distinct id because stable key differs
		fireEvent.click(screen.getByRole("button", { name: /^▸ Item 1$/ }));
		fireEvent.click(screen.getByRole("button", { name: /^▸ Item 2$/ }));
		nameInputs = container.querySelectorAll('input[id*="-name"]');
		expect(nameInputs.length).toBe(1);
		const secondId = (nameInputs[0] as HTMLInputElement).id;
		expect(secondId.startsWith("ing-")).toBe(true);
		expect(secondId.endsWith("-name")).toBe(true);
		expect(secondId).not.toBe(firstId);
	});
});
