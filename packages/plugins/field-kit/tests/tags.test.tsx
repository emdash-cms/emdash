import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Tags } from "../src/widgets/tags";

// ── Kumo mocks ──────────────────────────────────────────────────────────────
vi.mock("@cloudflare/kumo", () => ({
	Badge: ({ children }: any) => <span data-testid="badge">{children}</span>,
	Button: ({ children, onClick, icon, "aria-label": ariaLabel }: any) => (
		<button type="button" onClick={onClick} aria-label={ariaLabel}>
			{icon}
			{children}
		</button>
	),
}));

vi.mock("@phosphor-icons/react", () => ({
	X: () => <span>×</span>,
}));

afterEach(() => cleanup());

// An <input> with a `list` attribute has role="combobox"; without it, "textbox".
// Both are the same HTML element in our widget; query by id for consistency.
function findInput(id = "tags"): HTMLInputElement | null {
	return document.querySelector(`input#${id}`);
}

describe("Tags widget", () => {
	it("renders existing tags as chips", () => {
		render(<Tags value={["a", "b", "c"]} onChange={() => {}} label="Tags" id="tags" />);
		const badges = screen.getAllByTestId("badge");
		// each badge renders tag + mocked remove icon; check the tag text is present
		expect(badges).toHaveLength(3);
		expect(badges[0]!.textContent).toContain("a");
		expect(badges[1]!.textContent).toContain("b");
		expect(badges[2]!.textContent).toContain("c");
	});

	it("adds a tag on Enter", () => {
		const onChange = vi.fn();
		render(<Tags value={[]} onChange={onChange} label="Tags" id="tags" />);
		const input = findInput()!;
		fireEvent.change(input, { target: { value: "new-tag" } });
		fireEvent.keyDown(input, { key: "Enter" });
		expect(onChange).toHaveBeenCalledWith(["new-tag"]);
	});

	it("removes a tag when its remove button is clicked", () => {
		const onChange = vi.fn();
		render(<Tags value={["keep", "drop"]} onChange={onChange} label="Tags" id="tags" />);
		const removeButton = screen.getByLabelText("Remove drop");
		fireEvent.click(removeButton);
		expect(onChange).toHaveBeenCalledWith(["keep"]);
	});

	it("deduplicates tags", () => {
		const onChange = vi.fn();
		render(<Tags value={["a"]} onChange={onChange} label="Tags" id="tags" />);
		const input = findInput()!;
		fireEvent.change(input, { target: { value: "a" } });
		fireEvent.keyDown(input, { key: "Enter" });
		expect(onChange).not.toHaveBeenCalled();
	});

	it("enforces max", () => {
		const onChange = vi.fn();
		render(
			<Tags value={["a", "b"]} onChange={onChange} label="Tags" id="tags" options={{ max: 2 }} />,
		);
		// input is hidden when at limit
		expect(findInput()).toBeNull();
	});

	it("applies lowercase transform", () => {
		const onChange = vi.fn();
		render(
			<Tags
				value={[]}
				onChange={onChange}
				label="Tags"
				id="tags"
				options={{ transform: "lowercase" }}
			/>,
		);
		const input = findInput()!;
		fireEvent.change(input, { target: { value: "FooBar" } });
		fireEvent.keyDown(input, { key: "Enter" });
		expect(onChange).toHaveBeenCalledWith(["foobar"]);
	});

	it("rejects non-suggestion when allowCustom is false", () => {
		const onChange = vi.fn();
		render(
			<Tags
				value={[]}
				onChange={onChange}
				label="Tags"
				id="tags"
				options={{ allowCustom: false, suggestions: ["apple", "banana"] }}
			/>,
		);
		const input = findInput()!;
		fireEvent.change(input, { target: { value: "cherry" } });
		fireEvent.keyDown(input, { key: "Enter" });
		expect(onChange).not.toHaveBeenCalled();
	});

	it("accepts suggestion when allowCustom is false", () => {
		const onChange = vi.fn();
		render(
			<Tags
				value={[]}
				onChange={onChange}
				label="Tags"
				id="tags"
				options={{ allowCustom: false, suggestions: ["apple", "banana"] }}
			/>,
		);
		const input = findInput()!;
		fireEvent.change(input, { target: { value: "apple" } });
		fireEvent.keyDown(input, { key: "Enter" });
		expect(onChange).toHaveBeenCalledWith(["apple"]);
	});

	it("normalizes non-array value to empty array", () => {
		render(<Tags value={"not-an-array"} onChange={() => {}} label="Tags" id="tags" />);
		expect(screen.queryAllByTestId("badge")).toHaveLength(0);
	});
});
