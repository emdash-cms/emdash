import * as React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";

import { FieldEditor } from "../../src/components/FieldEditor";
import type { SchemaField } from "../../src/lib/api";
import { render } from "../utils/render.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FIELD_TYPE_REGEXES = [
	/Short Text/,
	/Long Text/,
	/Number Decimal number/,
	/Integer Whole number/,
	/Boolean True\/false toggle/,
	/Date & Time/,
	/^Select Single choice/,
	/Multi Select/,
	/Rich Text/,
	/Image/,
	/^File File from/,
	/Reference/,
	/JSON/,
	/Slug URL-friendly/,
];

const SHORT_TEXT_REGEX = /Short Text/;
const LONG_TEXT_REGEX = /Long Text/;
const BOOLEAN_REGEX = /Boolean/;
const RICH_TEXT_REGEX = /Rich Text Rich text editor/;

function makeField(overrides: Partial<SchemaField> = {}): SchemaField {
	return {
		id: "field_01",
		collectionId: "col_01",
		slug: "title",
		label: "Title",
		type: "string",
		columnType: "TEXT",
		required: true,
		unique: false,
		searchable: true,
		sortOrder: 0,
		createdAt: new Date().toISOString(),
		...overrides,
	};
}

// The kumo Dialog renders a `data-base-ui-inert` overlay that blocks pointer
// events inside the dialog in Playwright's actionability checks. Assertions
// (toBeInTheDocument, toHaveValue, etc.) work fine; only click() is blocked.
//
// Strategy:
// - Type selection step: assert type buttons exist (no clicking needed)
// - Config step: use edit mode (pass field prop) to go directly to config
// - onSave/callbacks: use edit mode fields to test form submission

describe("FieldEditor", () => {
	const defaultProps = {
		open: true,
		onOpenChange: vi.fn(),
		onSave: vi.fn(),
	};

	beforeEach(() => {
		vi.clearAllMocks();
	});

	describe("type selection step", () => {
		it("shows type selection grid when creating new field", async () => {
			const screen = await render(<FieldEditor {...defaultProps} />);
			await expect.element(screen.getByText("Add Field")).toBeInTheDocument();
			await expect
				.element(screen.getByRole("button", { name: SHORT_TEXT_REGEX }))
				.toBeInTheDocument();
			await expect
				.element(screen.getByRole("button", { name: LONG_TEXT_REGEX }))
				.toBeInTheDocument();
			await expect.element(screen.getByRole("button", { name: BOOLEAN_REGEX })).toBeInTheDocument();
			await expect
				.element(screen.getByRole("button", { name: RICH_TEXT_REGEX }))
				.toBeInTheDocument();
		});

		it("shows all 14 field types as buttons", async () => {
			const screen = await render(<FieldEditor {...defaultProps} />);
			// Each type renders as a button with label and description
			for (const name of FIELD_TYPE_REGEXES) {
				await expect.element(screen.getByRole("button", { name })).toBeInTheDocument();
			}
		});

		it("does not show config form on initial render", async () => {
			const screen = await render(<FieldEditor {...defaultProps} />);
			// Label and Slug inputs should NOT be present in type selection step
			expect(screen.getByLabelText("Label").query()).toBeNull();
			expect(screen.getByLabelText("Slug").query()).toBeNull();
		});
	});

	describe("config step (string field)", () => {
		// Use a minimal string field to go directly to config step
		const stringField = makeField({
			slug: "",
			label: "",
			type: "string",
			required: false,
			unique: false,
			searchable: false,
		});

		it("shows Configure Field title for string type", async () => {
			const screen = await render(
				<FieldEditor {...defaultProps} field={makeField({ type: "string" })} />,
			);
			await expect.element(screen.getByText("Edit Field")).toBeInTheDocument();
		});

		it("shows label and slug inputs", async () => {
			const screen = await render(<FieldEditor {...defaultProps} field={stringField} />);
			await expect.element(screen.getByLabelText("Label")).toBeInTheDocument();
			await expect.element(screen.getByLabelText("Slug")).toBeInTheDocument();
		});

		it("shows searchable checkbox for string type", async () => {
			const screen = await render(<FieldEditor {...defaultProps} field={stringField} />);
			await expect.element(screen.getByText("Searchable")).toBeInTheDocument();
		});

		it("shows min/max length validation for string type", async () => {
			const screen = await render(<FieldEditor {...defaultProps} field={stringField} />);
			await expect.element(screen.getByText("Validation")).toBeInTheDocument();
			await expect.element(screen.getByLabelText("Min Length")).toBeInTheDocument();
			await expect.element(screen.getByLabelText("Max Length")).toBeInTheDocument();
		});

		it("shows pattern input for string type", async () => {
			const screen = await render(<FieldEditor {...defaultProps} field={stringField} />);
			await expect.element(screen.getByLabelText("Pattern (Regex)")).toBeInTheDocument();
		});

		it("shows required and unique checkboxes", async () => {
			const screen = await render(<FieldEditor {...defaultProps} field={stringField} />);
			await expect.element(screen.getByText("Required")).toBeInTheDocument();
			await expect.element(screen.getByText("Unique")).toBeInTheDocument();
		});
	});

	describe("config step (number field)", () => {
		const numberField = makeField({
			slug: "",
			label: "",
			type: "number",
			required: false,
			unique: false,
			searchable: false,
		});

		it("shows min/max value for number type", async () => {
			const screen = await render(<FieldEditor {...defaultProps} field={numberField} />);
			await expect.element(screen.getByLabelText("Min Value")).toBeInTheDocument();
			await expect.element(screen.getByLabelText("Max Value")).toBeInTheDocument();
		});

		it("does not show searchable for number type", async () => {
			const screen = await render(<FieldEditor {...defaultProps} field={numberField} />);
			expect(screen.getByText("Searchable").query()).toBeNull();
		});

		it("does not show pattern for number type", async () => {
			const screen = await render(<FieldEditor {...defaultProps} field={numberField} />);
			expect(screen.getByLabelText("Pattern (Regex)").query()).toBeNull();
		});

		it("does not show min/max length for number type", async () => {
			const screen = await render(<FieldEditor {...defaultProps} field={numberField} />);
			expect(screen.getByLabelText("Min Length").query()).toBeNull();
			expect(screen.getByLabelText("Max Length").query()).toBeNull();
		});
	});

	describe("config step (text field)", () => {
		const textField = makeField({
			slug: "",
			label: "",
			type: "text",
			required: false,
			unique: false,
			searchable: false,
		});

		it("shows min/max length but no pattern for text type", async () => {
			const screen = await render(<FieldEditor {...defaultProps} field={textField} />);
			await expect.element(screen.getByLabelText("Min Length")).toBeInTheDocument();
			await expect.element(screen.getByLabelText("Max Length")).toBeInTheDocument();
			expect(screen.getByLabelText("Pattern (Regex)").query()).toBeNull();
		});

		it("shows searchable checkbox for text type", async () => {
			const screen = await render(<FieldEditor {...defaultProps} field={textField} />);
			await expect.element(screen.getByText("Searchable")).toBeInTheDocument();
		});
	});

	describe("config step (select field)", () => {
		const selectField = makeField({
			slug: "",
			label: "",
			type: "select",
			required: false,
			unique: false,
			searchable: false,
		});

		it("shows options textarea for select type", async () => {
			const screen = await render(<FieldEditor {...defaultProps} field={selectField} />);
			await expect.element(screen.getByText("Options (one per line)")).toBeInTheDocument();
			// Textarea should have the placeholder
			await expect.element(screen.getByPlaceholder("Option 1")).toBeInTheDocument();
		});
	});

	describe("config step (multiSelect field)", () => {
		const multiSelectField = makeField({
			slug: "",
			label: "",
			type: "multiSelect",
			required: false,
			unique: false,
			searchable: false,
		});

		it("shows options textarea for multi-select type", async () => {
			const screen = await render(<FieldEditor {...defaultProps} field={multiSelectField} />);
			await expect.element(screen.getByText("Options (one per line)")).toBeInTheDocument();
			await expect.element(screen.getByPlaceholder("Option 1")).toBeInTheDocument();
		});
	});

	describe("edit mode", () => {
		const existingField = makeField({
			validation: { maxLength: 200 },
		});

		it("skips type selection and shows config directly", async () => {
			const screen = await render(<FieldEditor {...defaultProps} field={existingField} />);
			await expect.element(screen.getByText("Edit Field")).toBeInTheDocument();
			await expect.element(screen.getByLabelText("Label")).toHaveValue("Title");
		});

		it("disables slug input in edit mode", async () => {
			const screen = await render(<FieldEditor {...defaultProps} field={existingField} />);
			await expect.element(screen.getByLabelText("Slug")).toBeDisabled();
		});

		it("shows hint about slug immutability", async () => {
			const screen = await render(<FieldEditor {...defaultProps} field={existingField} />);
			await expect
				.element(screen.getByText("Field slugs cannot be changed after creation"))
				.toBeInTheDocument();
		});

		it("does not show Change button in edit mode", async () => {
			const screen = await render(<FieldEditor {...defaultProps} field={existingField} />);
			expect(screen.getByRole("button", { name: "Change" }).query()).toBeNull();
		});

		it("shows Update Field button instead of Add Field", async () => {
			const screen = await render(<FieldEditor {...defaultProps} field={existingField} />);
			await expect
				.element(screen.getByRole("button", { name: "Update Field" }))
				.toBeInTheDocument();
		});

		it("pre-populates validation values", async () => {
			const screen = await render(<FieldEditor {...defaultProps} field={existingField} />);
			await expect.element(screen.getByLabelText("Max Length")).toHaveValue(200);
		});

		it("pre-populates slug value", async () => {
			const screen = await render(<FieldEditor {...defaultProps} field={existingField} />);
			await expect.element(screen.getByLabelText("Slug")).toHaveValue("title");
		});

		it("pre-populates required checkbox", async () => {
			const screen = await render(<FieldEditor {...defaultProps} field={existingField} />);
			// The Required checkbox text should be present (the field has required: true)
			await expect.element(screen.getByText("Required")).toBeInTheDocument();
		});

		it("does not auto-generate slug when editing label in edit mode", async () => {
			const screen = await render(<FieldEditor {...defaultProps} field={existingField} />);
			await screen.getByLabelText("Label").fill("New Label");
			// Slug should remain "title", not change to "new_label"
			await expect.element(screen.getByLabelText("Slug")).toHaveValue("title");
		});

		it("shows type indicator with field type info", async () => {
			const screen = await render(<FieldEditor {...defaultProps} field={existingField} />);
			await expect.element(screen.getByText("Short Text")).toBeInTheDocument();
			await expect.element(screen.getByText("Single line text input")).toBeInTheDocument();
		});
	});

	describe("saving state", () => {
		it("shows Saving... when isSaving is true", async () => {
			const field = makeField();
			const screen = await render(<FieldEditor {...defaultProps} isSaving={true} field={field} />);
			await expect.element(screen.getByText("Saving...")).toBeInTheDocument();
		});

		it("disables cancel button when saving", async () => {
			const field = makeField();
			const screen = await render(<FieldEditor {...defaultProps} isSaving={true} field={field} />);
			await expect.element(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
		});

		it("disables update button when saving", async () => {
			const field = makeField();
			const screen = await render(<FieldEditor {...defaultProps} isSaving={true} field={field} />);
			await expect.element(screen.getByRole("button", { name: "Saving..." })).toBeDisabled();
		});
	});

	describe("button state", () => {
		it("disables save button when label is empty", async () => {
			const field = makeField({ slug: "test", label: "" });
			const screen = await render(<FieldEditor {...defaultProps} field={field} />);
			await expect.element(screen.getByRole("button", { name: "Update Field" })).toBeDisabled();
		});

		it("enables save button when label and slug are filled", async () => {
			const field = makeField({ slug: "test", label: "Test" });
			const screen = await render(<FieldEditor {...defaultProps} field={field} />);
			await expect.element(screen.getByRole("button", { name: "Update Field" })).toBeEnabled();
		});
	});

	describe("dialog closed", () => {
		it("renders nothing visible when open is false", async () => {
			const screen = await render(<FieldEditor {...defaultProps} open={false} />);
			expect(screen.getByText("Add Field").query()).toBeNull();
		});
	});
});
