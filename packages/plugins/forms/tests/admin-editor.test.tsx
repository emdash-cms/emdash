// @vitest-environment jsdom
import { setupI18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { pages } from "../src/admin.js";
import { formCreateSchema, formUpdateSchema } from "../src/schemas.js";

type Request = { route: string; body: unknown; resolve: (response: Response) => void };
let requests: Request[] = [];

type ButtonProps = React.ComponentProps<"button">;
type InputProps = React.ComponentProps<"input"> & { label?: string };
type InputAreaProps = React.ComponentProps<"textarea"> & { label?: string };
type SelectProps = {
	label?: string;
	value?: string;
	onValueChange: (value: string | undefined) => void;
	items: Array<{ label: string; value: string }>;
};
type CheckboxProps = {
	label: string;
	checked?: boolean;
	onCheckedChange: (checked: boolean) => void;
};

vi.mock("@cloudflare/kumo", () => ({
	Badge: ({ children }: Pick<ButtonProps, "children">) => <span>{children}</span>,
	Button: ({ children, onClick, disabled, ...props }: ButtonProps) => (
		<button type="button" onClick={onClick} disabled={disabled} {...props}>
			{children}
		</button>
	),
	Checkbox: ({ label, checked, onCheckedChange }: CheckboxProps) => (
		<label>
			<input
				type="checkbox"
				aria-label={label}
				checked={checked}
				onChange={(e) => onCheckedChange(e.target.checked)}
			/>
			{label}
		</label>
	),
	Input: ({ label, value, onChange, ...props }: InputProps) => (
		<label>
			{label && <span>{label}</span>}
			<input aria-label={label ?? "input"} value={value ?? ""} onChange={onChange} {...props} />
		</label>
	),
	InputArea: ({ label, value, onChange, ...props }: InputAreaProps) => (
		<label>
			{label && <span>{label}</span>}
			<textarea aria-label={label ?? "input"} value={value ?? ""} onChange={onChange} {...props} />
		</label>
	),
	Loader: () => <span role="status" />,
	Select: ({ label, value, onValueChange, items }: SelectProps) => (
		<label>
			{label && <span>{label}</span>}
			<select
				aria-label={label ?? "select"}
				value={value ?? ""}
				onChange={(e) => onValueChange(e.target.value)}
			>
				{items.map((item) => (
					<option key={item.value} value={item.value}>
						{item.label}
					</option>
				))}
			</select>
		</label>
	),
}));

beforeEach(() => {
	requests = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(
			(url: string, init: RequestInit) =>
				new Promise<Response>((resolve) => {
					requests.push({
						route: url.split("/emdash-forms/")[1] ?? url,
						body: typeof init.body === "string" ? JSON.parse(init.body) : {},
						resolve,
					});
				}),
		),
	);
});
afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

const page = pages["/"]!;
const testI18n = setupI18n({ locale: "en", messages: { en: {} } });

function renderPage(withProvider = true) {
	expect(page).toBeTypeOf("function");
	return render(
		withProvider ? (
			<I18nProvider i18n={testI18n}>{React.createElement(page)}</I18nProvider>
		) : (
			React.createElement(page)
		),
	);
}
const ok = (data: unknown) =>
	new Response(JSON.stringify({ success: true, data }), { status: 200 });

async function respond(index: number, data: unknown) {
	requests[index]!.resolve(ok(data));
	await waitFor(() => expect(requests[index]).toBeTruthy());
}
async function openEditor(forms: unknown[] = [], withProvider = true) {
	renderPage(withProvider);
	await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalled());
	await waitFor(() => expect(requests[0]?.route).toBe("forms/list"));
	await respond(0, { items: forms });
	if (forms.length === 0) {
		await waitFor(() => expect(screen.getByRole("button", { name: "New Form" })).toBeTruthy());
		fireEvent.click(screen.getByRole("button", { name: "New Form" }));
	} else {
		await waitFor(() => expect(screen.getByRole("button", { name: "Edit" })).toBeTruthy());
		fireEvent.click(screen.getByRole("button", { name: "Edit" }));
	}
}
function change(label: string, value: string) {
	fireEvent.change(screen.getByLabelText(label), { target: { value } });
}
function field(id: string, name: string, extra: Record<string, unknown> = {}) {
	return { id, type: "text", label: name, name, required: false, width: "full", ...extra };
}
const existing = {
	id: "form-1",
	name: "Existing",
	slug: "existing",
	status: "active",
	submissionCount: 0,
	lastSubmissionAt: null,
	createdAt: "2026-01-01",
	updatedAt: "2026-01-01",
	pages: [
		{
			fields: [
				field("controller", "choice"),
				field("dependent", "details", {
					placeholder: "old placeholder",
					helpText: "old help",
					defaultValue: "old default",
					condition: { field: "choice", op: "eq", value: "yes" },
				}),
			],
		},
	],
	settings: {
		confirmationMessage: "Thanks",
		notifyEmails: ["old@example.com"],
		digestEnabled: true,
		digestHour: 14,
		autoresponder: { subject: "Old subject", body: "Old body" },
		webhookUrl: "https://old.example/hook",
		retentionDays: 30,
		spamProtection: "honeypot",
		submitLabel: "Send",
	},
};

async function addConditionalFields() {
	fireEvent.click(screen.getByRole("button", { name: "Add Field" }));
	fireEvent.click(screen.getByRole("button", { name: "Add Field" }));
	const labels = screen.getAllByLabelText("Label");
	const names = screen.getAllByLabelText("Name");
	fireEvent.change(labels[0]!, { target: { value: "Choice" } });
	fireEvent.change(names[1]!, { target: { value: "choice" } });
	fireEvent.change(labels[1]!, { target: { value: "Details" } });
	fireEvent.change(names[2]!, { target: { value: "details" } });
	const conditionField = screen.getAllByLabelText("Show when field")[1]!;
	const choiceOption = screen.getByRole("option", { name: "Choice (choice)" });
	fireEvent.change(conditionField, { target: { value: choiceOption.getAttribute("value") } });
}

describe("forms editor", () => {
	it.each([
		["eq", true],
		["neq", true],
		["filled", false],
		["empty", false],
	] as const)(
		"creates each %s condition operator with the right value control",
		async (op, hasValue) => {
			await openEditor();
			change("Name", "Contact");
			await addConditionalFields();
			fireEvent.change(screen.getByLabelText("Condition operator"), { target: { value: op } });
			if (hasValue) change("Condition value", "yes");
			if (hasValue) {
				expect(screen.getByLabelText("Condition value")).toBeTruthy();
			} else {
				expect(screen.queryByLabelText("Condition value")).toBeNull();
			}
			fireEvent.click(screen.getByRole("button", { name: "Create Form" }));
			await waitFor(() => expect(requests[1]?.route).toBe("forms/create"));
			const body = formCreateSchema.parse(requests[1]!.body);
			expect(body.pages[0]!.fields[1]!.condition).toEqual(
				hasValue ? { field: "choice", op, value: "yes" } : { field: "choice", op, value: "" },
			);
		},
	);

	it("starts a newly selected condition with Is filled and no comparison input", async () => {
		await openEditor();
		change("Name", "Contact");
		await addConditionalFields();
		expect((screen.getByLabelText("Condition operator") as HTMLSelectElement).value).toBe("filled");
		expect(screen.queryByLabelText("Condition value")).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "Create Form" }));
		await waitFor(() => expect(requests[1]?.route).toBe("forms/create"));
		const body = formCreateSchema.parse(requests[1]!.body);
		expect(body.pages[0]!.fields[1]!.condition).toMatchObject({ field: "choice", op: "filled" });
	});

	it("preserves an existing condition's operator and value when changing its controller", async () => {
		await openEditor([
			{
				...existing,
				pages: [{ fields: [...existing.pages[0]!.fields, field("other-controller", "other")] }],
			},
		]);
		fireEvent.change(screen.getAllByLabelText("Show when field")[1]!, {
			target: { value: "id:other-controller" },
		});
		expect((screen.getByLabelText("Condition operator") as HTMLSelectElement).value).toBe("eq");
		expect((screen.getByLabelText("Condition value") as HTMLInputElement).value).toBe("yes");
		fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));
		await waitFor(() => expect(requests[1]?.route).toBe("forms/update"));
		const body = formUpdateSchema.parse(requests[1]!.body);
		expect(body.pages?.[0]?.fields[1]?.condition).toEqual({
			field: "other",
			op: "eq",
			value: "yes",
		});
	});

	it("creates settings and field metadata, and clearing a condition omits it", async () => {
		await openEditor();
		change("Name", "Contact");
		await addConditionalFields();
		fireEvent.change(screen.getAllByLabelText("Placeholder")[1]!, {
			target: { value: "Enter details" },
		});
		fireEvent.change(screen.getAllByLabelText("Help text")[1]!, {
			target: { value: "Shown below" },
		});
		fireEvent.change(screen.getAllByLabelText("Default value")[1]!, {
			target: { value: "default" },
		});
		fireEvent.change(screen.getByLabelText("Condition operator"), { target: { value: "neq" } });
		change("Condition value", "no");
		fireEvent.change(screen.getAllByLabelText("Show when field")[1]!, { target: { value: "" } });
		fireEvent.click(screen.getByLabelText("Daily digest"));
		change("Digest hour (UTC)", "18");
		fireEvent.click(screen.getByLabelText("Send an autoresponder"));
		change("Autoresponder subject", "Received");
		fireEvent.change(screen.getByLabelText("Autoresponder body"), {
			target: { value: "We got it" },
		});
		change("Webhook URL (optional)", "https://example.com/hook");
		fireEvent.click(screen.getByRole("button", { name: "Create Form" }));
		await waitFor(() => expect(requests[1]?.route).toBe("forms/create"));
		const body = formCreateSchema.parse(requests[1]!.body);
		expect(requests[1]!.body).not.toHaveProperty("pages.0.fields.1.conditionFieldId");
		expect(body.settings).toMatchObject({
			digestEnabled: true,
			digestHour: 18,
			webhookUrl: "https://example.com/hook",
			autoresponder: { subject: "Received", body: "We got it" },
		});
		expect(body.pages[0]!.fields[1]).toMatchObject({
			placeholder: "Enter details",
			helpText: "Shown below",
			defaultValue: "default",
		});
		expect(body.pages[0]!.fields[1]!.condition).toBeUndefined();
	});

	it("preserves recipients while disabling the autoresponder and clearing the webhook", async () => {
		await openEditor([existing]);
		fireEvent.click(screen.getByLabelText("Send an autoresponder"));
		change("Webhook URL (optional)", "");
		fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));
		await waitFor(() => expect(requests[1]?.route).toBe("forms/update"));
		const body = formUpdateSchema.parse(requests[1]!.body);
		expect(body.settings).toMatchObject({
			autoresponder: null,
			webhookUrl: "",
			notifyEmails: ["old@example.com"],
		});
	});

	it("updates loaded metadata and condition references when a controller is renamed or removed", async () => {
		await openEditor([existing]);
		fireEvent.change(screen.getAllByLabelText("Placeholder")[1]!, {
			target: { value: "new placeholder" },
		});
		fireEvent.change(screen.getAllByLabelText("Help text")[1]!, { target: { value: "new help" } });
		fireEvent.change(screen.getAllByLabelText("Default value")[1]!, {
			target: { value: "new default" },
		});
		fireEvent.change(screen.getAllByLabelText("Name")[1]!, { target: { value: "renamed" } });
		expect((screen.getAllByLabelText("Show when field")[1] as HTMLSelectElement).value).toBe(
			"id:controller",
		);
		fireEvent.click(screen.getAllByLabelText("Remove")[0]!);
		expect((screen.getAllByLabelText("Show when field")[0] as HTMLSelectElement).value).toBe("");
		fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));
		await waitFor(() => expect(requests[1]?.route).toBe("forms/update"));
		const body = formUpdateSchema.parse(requests[1]!.body);
		expect(body.pages?.[0]?.fields[0]).toMatchObject({
			placeholder: "new placeholder",
			helpText: "new help",
			defaultValue: "new default",
		});
		expect(body.pages?.[0]?.fields[0]?.condition).toBeUndefined();
	});

	it("falls back to English when an older host does not share the Lingui context", async () => {
		await openEditor([existing], false);
		expect(screen.getByLabelText("Daily digest")).toBeTruthy();
		expect(screen.getAllByLabelText("Show when field")).toHaveLength(2);
	});

	it("keeps a condition bound while its controller is cleared, retyped, or auto-renamed", async () => {
		await openEditor([existing]);
		const controllerName = screen.getAllByLabelText("Name")[1]!;
		const condition = screen.getAllByLabelText("Show when field")[1] as HTMLSelectElement;
		fireEvent.change(controllerName, { target: { value: "" } });
		fireEvent.change(controllerName, { target: { value: "choice" } });
		expect(condition.value).toBe("id:controller");
		fireEvent.change(screen.getAllByLabelText("Label")[0]!, { target: { value: "" } });
		expect(condition.value).toBe("id:controller");
		fireEvent.change(screen.getAllByLabelText("Label")[0]!, {
			target: { value: "Renamed Choice" },
		});
		expect(condition.value).toBe("id:controller");
		fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));
		await waitFor(() => expect(requests[1]?.route).toBe("forms/update"));
		const body = formUpdateSchema.parse(requests[1]!.body);
		expect(body.pages?.[0]?.fields[1]?.condition?.field).toBe("renamed_choice");
	});

	it("does not switch a condition during a duplicate-name edit", async () => {
		await openEditor([existing]);
		const controllerName = screen.getAllByLabelText("Name")[1]!;
		const condition = screen.getAllByLabelText("Show when field")[1] as HTMLSelectElement;
		fireEvent.change(controllerName, { target: { value: "details" } });
		expect(condition.value).toBe("id:controller");
		fireEvent.change(controllerName, { target: { value: "new_controller" } });
		expect(condition.value).toBe("id:controller");
		fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));
		await waitFor(() => expect(requests[1]?.route).toBe("forms/update"));
		const body = formUpdateSchema.parse(requests[1]!.body);
		expect(body.pages?.[0]?.fields[1]?.condition?.field).toBe("new_controller");
		expect(requests[1]!.body).not.toHaveProperty("pages.0.fields.1.conditionFieldId");
	});

	it("does not let an unnamed field steal dependents of an unnamed controller", async () => {
		await openEditor([existing]);
		const controllerName = screen.getAllByLabelText("Name")[1]!;
		fireEvent.change(controllerName, { target: { value: "" } });
		fireEvent.click(screen.getByRole("button", { name: "Add Field" }));
		fireEvent.change(screen.getAllByLabelText("Name")[3]!, { target: { value: "other" } });
		fireEvent.change(controllerName, { target: { value: "restored" } });
		expect((screen.getAllByLabelText("Show when field")[1] as HTMLSelectElement).value).toBe(
			"id:controller",
		);
		expect(
			screen.getAllByLabelText("Show when field")[1]!.querySelector("option:checked")?.textContent,
		).toBe("choice (restored)");
	});

	it("preserves an autoresponder draft when toggled off and back on", async () => {
		await openEditor([existing]);
		fireEvent.click(screen.getByLabelText("Send an autoresponder"));
		fireEvent.click(screen.getByLabelText("Send an autoresponder"));
		expect(screen.getByDisplayValue("Old subject")).toBeTruthy();
		expect(screen.getByDisplayValue("Old body")).toBeTruthy();
		change("Autoresponder subject", "Edited subject");
		fireEvent.change(screen.getByLabelText("Autoresponder body"), {
			target: { value: "Edited body" },
		});
		fireEvent.click(screen.getByLabelText("Send an autoresponder"));
		fireEvent.click(screen.getByLabelText("Send an autoresponder"));
		expect(screen.getByDisplayValue("Edited subject")).toBeTruthy();
		expect(screen.getByDisplayValue("Edited body")).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));
		await waitFor(() => expect(requests[1]?.route).toBe("forms/update"));
		const body = formUpdateSchema.parse(requests[1]!.body);
		expect(body.settings?.autoresponder).toEqual({
			subject: "Edited subject",
			body: "Edited body",
		});
	});

	it("hides default value for unsupported field types and preserves it when changed back", async () => {
		await openEditor([existing]);
		fireEvent.change(screen.getAllByLabelText("Default value")[0]!, { target: { value: "kept" } });
		const type = screen.getAllByLabelText("Type")[0]!;
		fireEvent.change(type, { target: { value: "file" } });
		expect(screen.getAllByLabelText("Default value")).toHaveLength(1);
		fireEvent.change(type, { target: { value: "checkbox-group" } });
		expect(screen.getAllByLabelText("Default value")).toHaveLength(1);
		fireEvent.change(type, { target: { value: "text" } });
		expect((screen.getAllByLabelText("Default value")[0] as HTMLInputElement).value).toBe("kept");
	});

	it("does not offer unsupported field types as new condition controllers", async () => {
		await openEditor();
		change("Name", "Contact");
		await addConditionalFields();
		fireEvent.change(screen.getAllByLabelText("Show when field")[1]!, { target: { value: "" } });
		for (const type of ["file", "checkbox-group"]) {
			fireEvent.change(screen.getAllByLabelText("Type")[0]!, { target: { value: type } });
			const options = screen.getAllByLabelText("Show when field")[1]!.querySelectorAll("option");
			expect([...options].some((option) => option.textContent === "Choice (choice)")).toBe(false);
		}
	});

	it.each(["radio", "checkbox", "checkbox-group", "file", "hidden", "date"])(
		"does not offer an ineffective placeholder for %s fields",
		async (type) => {
			await openEditor([existing]);
			fireEvent.change(screen.getAllByLabelText("Type")[0]!, { target: { value: type } });
			expect(screen.getAllByLabelText("Placeholder")).toHaveLength(1);
			expect(screen.getByDisplayValue("old placeholder")).toBeTruthy();
		},
	);

	it("shows a select placeholder only while Required is enabled and preserves its text", async () => {
		await openEditor([existing]);
		const type = screen.getAllByLabelText("Type")[1]!;
		const required = screen.getAllByLabelText("Required")[1]!;
		fireEvent.change(type, { target: { value: "select" } });
		expect(screen.queryByDisplayValue("old placeholder")).toBeNull();
		fireEvent.click(required);
		expect(screen.getByDisplayValue("old placeholder")).toBeTruthy();
		fireEvent.change(screen.getAllByLabelText("Placeholder")[1]!, {
			target: { value: "Choose a topic" },
		});
		fireEvent.click(required);
		expect(screen.queryByDisplayValue("Choose a topic")).toBeNull();
		fireEvent.click(required);
		expect(screen.getByDisplayValue("Choose a topic")).toBeTruthy();
		fireEvent.change(type, { target: { value: "date" } });
		expect(screen.queryByDisplayValue("Choose a topic")).toBeNull();
		fireEvent.change(type, { target: { value: "select" } });
		expect(screen.getByDisplayValue("Choose a topic")).toBeTruthy();
	});

	it("hides single-checkbox value editing and preserves API-configured values", async () => {
		await openEditor([
			{
				...existing,
				pages: [
					{ fields: [field("checkbox", "consent", { type: "checkbox", defaultValue: "yes" })] },
				],
			},
		]);
		expect(screen.queryByLabelText("Value when checked")).toBeNull();
		expect(screen.queryByLabelText("Default value")).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));
		await waitFor(() => expect(requests[1]?.route).toBe("forms/update"));
		const body = formUpdateSchema.parse(requests[1]!.body);
		expect(body.pages?.[0]?.fields[0]?.defaultValue).toBe("yes");
	});

	it("hides hidden-field help text editing and preserves API-configured text", async () => {
		await openEditor([
			{
				...existing,
				pages: [
					{
						fields: [
							field("hidden", "source", { type: "hidden", helpText: "Existing API help text" }),
						],
					},
				],
			},
		]);
		expect(screen.queryByLabelText("Help text")).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));
		await waitFor(() => expect(requests[1]?.route).toBe("forms/update"));
		const body = formUpdateSchema.parse(requests[1]!.body);
		expect(body.pages?.[0]?.fields[0]?.helpText).toBe("Existing API help text");
	});

	it("does not save an autoresponder with a missing subject or body", async () => {
		await openEditor([existing]);
		change("Autoresponder subject", "");
		fireEvent.change(screen.getByLabelText("Autoresponder body"), { target: { value: "" } });
		fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));
		await waitFor(() =>
			expect(screen.getByText("Autoresponder subject and body are required")).toBeTruthy(),
		);
		expect(requests).toHaveLength(1);
	});
});
