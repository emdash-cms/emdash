import * as React from "react";
import { describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";

import "../../dist/styles.css";
import { BylineFieldEditor } from "../../src/components/BylineFieldEditor.js";
import type {
	BylineFieldDefinition,
	CreateBylineFieldInput,
	UpdateBylineFieldInput,
} from "../../src/lib/api/byline-fields.js";
import { ApiResponseError } from "../../src/lib/api/client.js";
import { pressOutside } from "../utils/mouse.ts";
import { render } from "../utils/render.tsx";

const TAKEN_SLUG = "Another field already uses this slug. Enter a different one.";
const LOCKED =
	"Locked because this field has stored values. Delete the values (or the field) to change this.";

const existingField: BylineFieldDefinition = {
	id: "field_01",
	slug: "job_title",
	label: "Job title",
	type: "string",
	required: false,
	translatable: true,
	validation: null,
	sortOrder: 0,
	createdAt: "2026-01-01T00:00:00.000Z",
	updatedAt: "2026-01-01T00:00:00.000Z",
};

/** Saves the way the byline schema page does: the mutation's error comes back as a prop. */
function Harness({
	field,
	usageTotal,
	onSave = vi.fn(async () => {}),
}: {
	field?: BylineFieldDefinition;
	usageTotal?: number;
	onSave?: (input: CreateBylineFieldInput | UpdateBylineFieldInput) => Promise<unknown>;
}) {
	const [open, setOpen] = React.useState(false);
	const [saving, setSaving] = React.useState(false);
	const [error, setError] = React.useState<unknown>(null);
	return (
		<>
			<button type="button" onClick={() => setOpen(true)}>
				Open editor
			</button>
			<BylineFieldEditor
				open={open}
				onOpenChange={(next) => {
					setOpen(next);
					if (!next) setError(null);
				}}
				field={field}
				usageTotal={usageTotal}
				isSaving={saving}
				error={error}
				onSave={async (input) => {
					setSaving(true);
					setError(null);
					try {
						await onSave(input);
						setOpen(false);
					} catch (err) {
						setError(err);
						throw err;
					} finally {
						setSaving(false);
					}
				}}
			/>
		</>
	);
}

async function openEditor(props: React.ComponentProps<typeof Harness> = {}) {
	const screen = await render(<Harness {...props} />);
	await screen.getByRole("button", { name: "Open editor" }).click();
	const dialog = screen.getByRole("dialog", {
		name: props.field ? "Edit byline field" : "New byline field",
	});
	await expect.element(dialog).toBeVisible();
	return dialog;
}

describe("BylineFieldEditor", () => {
	it("points at each missing field when submitted, and sends nothing until they are filled", async () => {
		const onSave = vi.fn(async () => {});
		const dialog = await openEditor({ onSave });
		const action = dialog.getByRole("button", { name: "Create field" });
		await expect.element(action).toBeEnabled();
		expect(dialog.getByText("Enter a label.").query()).toBeNull();

		await action.click();

		const label = dialog.getByLabelText("Label", { exact: true });
		await expect.element(dialog.getByText("Enter a label.")).toBeVisible();
		await expect.element(label).toHaveAttribute("aria-invalid", "true");
		await expect.element(label).toHaveFocus();
		expect(onSave).not.toHaveBeenCalled();

		await label.fill("Job title");
		await expect.element(dialog.getByText("Enter a label.")).not.toBeInTheDocument();
		await action.click();
		await vi.waitFor(() =>
			expect(onSave).toHaveBeenCalledWith(
				expect.objectContaining({ slug: "job_title", label: "Job title", type: "string" }),
			),
		);
	});

	it("explains a slug the server would turn down", async () => {
		const onSave = vi.fn(async () => {});
		const dialog = await openEditor({ onSave });
		await dialog.getByLabelText("Label", { exact: true }).fill("Role");
		const slug = dialog.getByRole("textbox", { name: "Slug", exact: true });
		await slug.fill("Bad Slug!");

		await dialog.getByRole("button", { name: "Create field" }).click();

		await expect
			.element(
				dialog.getByText(
					"Use lowercase letters, numbers, and underscores, starting with a letter.",
				),
			)
			.toBeVisible();
		await expect.element(slug).toHaveFocus();
		expect(onSave).not.toHaveBeenCalled();
	});

	it("asks for a select's options, each listed once", async () => {
		const onSave = vi.fn(async () => {});
		const dialog = await openEditor({ onSave });
		await dialog.getByLabelText("Label", { exact: true }).fill("Pronouns");
		await dialog.getByRole("combobox", { name: "Type" }).click();
		await page.getByRole("option", { name: "Select", exact: true }).click();
		const options = dialog.getByLabelText("Options (one per line)");

		await dialog.getByRole("button", { name: "Create field" }).click();

		await expect.element(dialog.getByText("Add at least one option.")).toBeVisible();
		await expect.element(options).toHaveFocus();

		await options.fill("she/her\nthey/them\nshe/her");
		await expect.element(dialog.getByText("List each option only once.")).toBeVisible();
		await dialog.getByRole("button", { name: "Create field" }).click();
		expect(onSave).not.toHaveBeenCalled();
	});

	it("saves when Enter is pressed in a text field", async () => {
		const onSave = vi.fn(async () => {});
		const dialog = await openEditor({ onSave });
		await dialog.getByLabelText("Label", { exact: true }).fill("Pronouns");

		await userEvent.keyboard("{Enter}");

		await vi.waitFor(() =>
			expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ slug: "pronouns" })),
		);
	});

	it("shows a slug another field uses on the slug field", async () => {
		const onSave = vi.fn(async () => {
			throw new ApiResponseError(409, "FIELD_EXISTS", 'Byline field "job_title" already exists', {
				slug: "job_title",
			});
		});
		const dialog = await openEditor({ onSave });
		await dialog.getByLabelText("Label", { exact: true }).fill("Job title");

		await dialog.getByRole("button", { name: "Create field" }).click();

		const slug = dialog.getByRole("textbox", { name: "Slug", exact: true });
		await expect.element(dialog.getByText(TAKEN_SLUG)).toBeVisible();
		await expect.element(slug).toHaveFocus();
		expect(dialog.getByText(/already exists/).query()).toBeNull();

		await slug.fill("role");
		await expect.element(dialog.getByText(TAKEN_SLUG)).not.toBeInTheDocument();
		expect(dialog.getByRole("alert").query()).toBeNull();
	});

	it("shows a reserved slug on the slug field", async () => {
		const onSave = vi.fn(async () => {
			throw new ApiResponseError(400, "VALIDATION_ERROR", "slug: Byline field slug is reserved", {
				issues: [{ path: "slug", message: "Byline field slug is reserved" }],
			});
		});
		const dialog = await openEditor({ onSave });
		await dialog.getByLabelText("Label", { exact: true }).fill("Bio");

		await dialog.getByRole("button", { name: "Create field" }).click();

		await expect
			.element(dialog.getByText("This slug is reserved. Enter a different one."))
			.toBeVisible();
		await expect.element(dialog.getByRole("textbox", { name: "Slug", exact: true })).toHaveFocus();
		expect(dialog.getByText(/Byline field slug is reserved/).query()).toBeNull();
	});

	it("says in the admin's words why a translatable flip was refused, and stops sending it", async () => {
		const onSave = vi.fn(async (_input: CreateBylineFieldInput | UpdateBylineFieldInput) => {
			throw new ApiResponseError(
				409,
				"TRANSLATABLE_LOCKED",
				'Cannot change "translatable" on field "job_title" while 3 value row(s) exist.',
			);
		});
		const screen = await render(<Harness field={existingField} onSave={onSave} />);
		await screen.getByRole("button", { name: "Open editor" }).click();
		const dialog = screen.getByRole("dialog", { name: "Edit byline field" });
		await dialog.getByRole("switch", { name: "Translatable" }).click();
		await dialog.getByRole("button", { name: "Save changes" }).click();

		await expect.element(dialog.getByRole("alert")).toHaveTextContent(LOCKED);

		// The usage count arrives and locks the switch on the stored value.
		await screen.rerender(<Harness field={existingField} usageTotal={3} onSave={onSave} />);
		await expect.element(dialog.getByRole("switch", { name: "Translatable" })).toBeChecked();
		await dialog.getByRole("button", { name: "Save changes" }).click();
		await vi.waitFor(() => expect(onSave).toHaveBeenCalledTimes(2));
		expect(onSave.mock.calls[1]?.[0]).toMatchObject({ translatable: undefined });
	});

	it("keeps typed input through a press outside, and still closes on Cancel", async () => {
		const dialog = await openEditor();
		await dialog.getByLabelText("Label", { exact: true }).fill("Pronouns");

		await pressOutside();
		await expect.element(dialog).toBeVisible();
		await expect.element(dialog.getByLabelText("Label", { exact: true })).toHaveValue("Pronouns");

		await dialog.getByRole("button", { name: "Cancel" }).click();
		await expect.element(dialog).not.toBeInTheDocument();
	});

	it("closes on a press outside when nothing was typed", async () => {
		const dialog = await openEditor();

		await pressOutside();
		await expect.element(dialog).not.toBeInTheDocument();
	});

	it("keeps an edit through a press outside", async () => {
		const dialog = await openEditor({ field: existingField });
		await dialog.getByLabelText("Label", { exact: true }).fill("Role");

		await pressOutside();
		await expect.element(dialog).toBeVisible();
	});

	it("closes an unchanged field on a press outside", async () => {
		const dialog = await openEditor({ field: existingField });

		await pressOutside();
		await expect.element(dialog).not.toBeInTheDocument();
	});

	it("closes on a press outside once the stored values put a flipped switch back", async () => {
		const screen = await render(<Harness field={existingField} />);
		await screen.getByRole("button", { name: "Open editor" }).click();
		const dialog = screen.getByRole("dialog", { name: "Edit byline field" });
		const translatable = dialog.getByRole("switch", { name: "Translatable" });
		await translatable.click();
		await expect.element(translatable).not.toBeChecked();

		await screen.rerender(<Harness field={existingField} usageTotal={3} />);
		await expect.element(translatable).toBeChecked();

		await pressOutside();
		await expect.element(dialog).not.toBeInTheDocument();
	});
});
