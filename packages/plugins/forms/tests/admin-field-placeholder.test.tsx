// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { pages } from "../src/admin.js";

vi.mock("@cloudflare/kumo", () => ({
	Badge: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
	Button: ({
		children,
		onClick,
		disabled,
		"aria-label": ariaLabel,
	}: {
		children?: React.ReactNode;
		onClick?: React.MouseEventHandler;
		disabled?: boolean;
		"aria-label"?: string;
	}) => (
		<button type="button" onClick={onClick} disabled={disabled} aria-label={ariaLabel}>
			{children}
		</button>
	),
	Checkbox: () => null,
	Input: ({
		label,
		value,
		onChange,
	}: {
		label?: string;
		value?: string;
		onChange?: React.ChangeEventHandler<HTMLInputElement>;
	}) => (
		<label>
			{label}
			<input value={value} onChange={onChange} />
		</label>
	),
	Loader: () => <div role="status" aria-label="Loading" />,
	Select: () => null,
}));

interface Request {
	route: string;
	body: Record<string, unknown>;
}

let requests: Request[] = [];

function respond(route: string): unknown {
	if (route === "forms/list") {
		return {
			items: [
				{
					id: "f1",
					name: "Apply",
					slug: "apply",
					status: "active",
					submissionCount: 0,
					lastSubmissionAt: null,
					createdAt: "2026-10-01T00:00:00.000Z",
					updatedAt: "2026-10-01T00:00:00.000Z",
					pages: [
						{
							fields: [
								{
									id: "position",
									type: "select",
									label: "Position",
									name: "position",
									required: true,
									width: "full",
									options: [{ label: "Pharmacist", value: "pharmacist" }],
								},
								{
									id: "shift",
									type: "radio",
									label: "Shift",
									name: "shift",
									required: false,
									width: "full",
									options: [{ label: "Day", value: "day" }],
								},
							],
						},
					],
					settings: { spamProtection: "none", submitLabel: "Submit" },
				},
			],
		};
	}
	return {};
}

beforeEach(() => {
	requests = [];
	vi.stubGlobal(
		"fetch",
		vi.fn((url: string, init?: RequestInit) => {
			const route = url.split("/emdash-forms/")[1] ?? url;
			requests.push({ route, body: JSON.parse((init?.body as string) || "{}") });
			return Promise.resolve(
				new Response(JSON.stringify({ success: true, data: respond(route) }), { status: 200 }),
			);
		}),
	);
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

async function editForm() {
	const FormsListPage = pages!["/"]!;
	render(<FormsListPage />);
	fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
}

describe("form editor placeholder", () => {
	it("saves the placeholder typed for a select field", async () => {
		await editForm();
		fireEvent.change(screen.getByRole("textbox", { name: "Placeholder" }), {
			target: { value: "Choose a position" },
		});
		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));
		});

		const update = requests.find((r) => r.route === "forms/update");
		expect(update).toBeDefined();
		const [position, shift] = (update!.body.pages as { fields: Record<string, unknown>[] }[])[0]!
			.fields;
		expect(position).toMatchObject({ name: "position", placeholder: "Choose a position" });
		expect(shift).not.toHaveProperty("placeholder");
	});

	it("offers the input only for fields that show a placeholder", async () => {
		await editForm();
		expect(screen.getAllByRole("textbox", { name: "Placeholder" })).toHaveLength(1);
	});
});
