import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ObjectForm } from "../src/widgets/object-form";

vi.mock("@cloudflare/kumo", () => ({
	Button: ({ children, onClick, icon, "aria-label": ariaLabel, disabled }: any) => (
		<button type="button" onClick={onClick} aria-label={ariaLabel} disabled={disabled}>
			{icon}
			{children}
		</button>
	),
	Input: ({ label, value, onChange, type, id, required }: any) => (
		<label>
			{typeof label === "string" ? label : label}
			<input
				id={id}
				type={type ?? "text"}
				value={value ?? ""}
				required={required}
				onChange={onChange}
			/>
		</label>
	),
	InputArea: ({ label, value, onChange, id, required }: any) => (
		<label>
			{typeof label === "string" ? label : label}
			<textarea id={id} value={value ?? ""} required={required} onChange={onChange} />
		</label>
	),
	Select: ({ label, value, onValueChange, items, required }: any) => (
		<label>
			{typeof label === "string" ? label : label}
			<select
				value={value ?? ""}
				required={required}
				onChange={(e) => onValueChange?.(e.target.value)}
			>
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
				type="checkbox"
				role="switch"
				checked={!!checked}
				onChange={(e) => onCheckedChange?.(e.target.checked)}
			/>
		</label>
	),
}));

vi.mock("@phosphor-icons/react", () => ({
	CaretRight: () => <span>▸</span>,
}));

afterEach(() => cleanup());

describe("ObjectForm widget", () => {
	it("renders sub-fields from options.fields", () => {
		render(
			<ObjectForm
				value={{}}
				onChange={() => {}}
				label="Nutrition"
				id="nut"
				options={{
					fields: [
						{ key: "name", label: "Name", type: "text" },
						{ key: "count", label: "Count", type: "number" },
					],
				}}
			/>,
		);
		expect(screen.getByText("Name")).not.toBeNull();
		expect(screen.getByText("Count")).not.toBeNull();
	});

	it("populates sub-field values from the stored object", () => {
		render(
			<ObjectForm
				value={{ name: "flour", count: 3 }}
				onChange={() => {}}
				label="Nutrition"
				id="nut"
				options={{
					fields: [
						{ key: "name", label: "Name", type: "text" },
						{ key: "count", label: "Count", type: "number" },
					],
				}}
			/>,
		);
		expect(screen.getByDisplayValue("flour")).not.toBeNull();
		expect(screen.getByDisplayValue("3")).not.toBeNull();
	});

	it("emits the full object on field change", () => {
		const onChange = vi.fn();
		render(
			<ObjectForm
				value={{ name: "flour", count: 3 }}
				onChange={onChange}
				label="Nutrition"
				id="nut"
				options={{
					fields: [
						{ key: "name", label: "Name", type: "text" },
						{ key: "count", label: "Count", type: "number" },
					],
				}}
			/>,
		);
		fireEvent.change(screen.getByDisplayValue("flour"), {
			target: { value: "sugar" },
		});
		expect(onChange).toHaveBeenCalledWith({ name: "sugar", count: 3 });
	});

	it("shows misconfigured warning when fields is empty", () => {
		render(
			<ObjectForm
				value={{}}
				onChange={() => {}}
				label="Empty"
				id="empty"
				options={{ fields: [] }}
			/>,
		);
		expect(screen.getByText(/Widget misconfigured/i)).not.toBeNull();
	});

	it("preserves unknown keys not defined in options.fields", () => {
		const onChange = vi.fn();
		render(
			<ObjectForm
				value={{ name: "a", stray: "unexpected" }}
				onChange={onChange}
				label="Form"
				id="f"
				options={{
					fields: [{ key: "name", label: "Name", type: "text" }],
				}}
			/>,
		);
		fireEvent.change(screen.getByDisplayValue("a"), {
			target: { value: "b" },
		});
		// onChange should pass along keys not managed by this widget so stored
		// JSON round-trips cleanly when the schema evolves.
		const payload = onChange.mock.calls[0]?.[0] as Record<string, unknown>;
		expect(payload).toEqual({ name: "b", stray: "unexpected" });
	});

	it("gives each sub-field a unique DOM id composed from the parent id", () => {
		const { container } = render(
			<ObjectForm
				value={{}}
				onChange={() => {}}
				label="Form"
				id="nutrition"
				options={{
					fields: [
						{ key: "calories", label: "Calories", type: "number" },
						{ key: "protein", label: "Protein", type: "number" },
					],
				}}
			/>,
		);
		expect(container.querySelector("#nutrition-calories")).not.toBeNull();
		expect(container.querySelector("#nutrition-protein")).not.toBeNull();
	});
});
