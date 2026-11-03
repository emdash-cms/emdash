import * as React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";

import "../../../dist/styles.css";
import { ChangeDomainDialog } from "../../../src/components/settings/ChangeDomainDialog";
import { ApiResponseError } from "../../../src/lib/api";
import { pressOutside } from "../../utils/mouse.ts";
import { render } from "../../utils/render";

const mockChangeSiteDomain = vi.fn<(domain: string) => Promise<{ url: string }>>();
const mockUpdateSettings = vi.fn();

vi.mock("../../../src/lib/api", async () => {
	const actual = await vi.importActual("../../../src/lib/api");
	return {
		...actual,
		changeSiteDomain: (domain: string) => mockChangeSiteDomain(domain),
		updateSettings: (...args: unknown[]) => mockUpdateSettings(...args),
	};
});

const FORMAT_HINT = "Enter a domain such as example.com, without a path or port";

function Harness() {
	const [open, setOpen] = React.useState(false);
	return (
		<>
			<button type="button" onClick={() => setOpen(true)}>
				Open
			</button>
			<ChangeDomainDialog
				open={open}
				currentUrl="https://example.com"
				onClose={() => setOpen(false)}
				onChanged={() => setOpen(false)}
			/>
		</>
	);
}

async function openDialog() {
	const screen = await render(<Harness />);
	await screen.getByRole("button", { name: "Open" }).click();
	const dialog = screen.getByRole("dialog", { name: "Change domain" });
	await expect.element(dialog).toBeVisible();
	return { screen, dialog, input: dialog.getByRole("textbox", { name: "New domain" }) };
}

beforeEach(() => {
	vi.clearAllMocks();
	mockChangeSiteDomain.mockResolvedValue({ url: "https://new.example" });
	mockUpdateSettings.mockResolvedValue({});
});

describe("ChangeDomainDialog", () => {
	it("points at an empty domain when submitted, and sends nothing", async () => {
		const { dialog, input } = await openDialog();
		const action = dialog.getByRole("button", { name: "Check and switch" });
		await expect.element(action).toBeEnabled();
		expect(dialog.getByText(FORMAT_HINT).query()).toBeNull();

		await action.click();

		await expect.element(input).toHaveAccessibleDescription(FORMAT_HINT);
		await expect.element(input).toHaveAttribute("aria-invalid", "true");
		await expect.element(input).toHaveFocus();
		expect(mockChangeSiteDomain).not.toHaveBeenCalled();

		await input.fill("new.example");
		await expect.element(input).not.toHaveAttribute("aria-invalid");
	});

	it("checks a domain once on a double click", async () => {
		let finish: (value: { url: string }) => void = () => {};
		mockChangeSiteDomain.mockReturnValue(
			new Promise((resolve) => {
				finish = resolve;
			}),
		);
		const { dialog, input } = await openDialog();
		await input.fill("new.example");
		const action = dialog.getByRole("button", { name: "Check and switch" });

		action.element().click();
		action.element().click();
		await vi.waitFor(() => expect(mockChangeSiteDomain).toHaveBeenCalledTimes(1));
		finish({ url: "https://new.example" });
		await expect.element(dialog).not.toBeInTheDocument();
		expect(mockChangeSiteDomain).toHaveBeenCalledTimes(1);
	});

	it("shows a domain the server refuses on the field and returns focus to it", async () => {
		mockChangeSiteDomain.mockRejectedValue(
			new ApiResponseError(422, "DOMAIN_CHECK_FAILED", "English server message", {
				reason: "NOT_SERVING",
				origin: "https://new.example",
			}),
		);
		const { dialog, input } = await openDialog();
		await input.fill("new.example");
		await userEvent.keyboard("{Enter}");

		const reason = "https://new.example does not serve this site yet";
		await expect.element(input).toHaveAccessibleDescription(reason);
		await expect.element(input).toHaveAttribute("aria-invalid", "true");
		await expect.element(input).toHaveFocus();
		expect(dialog.getByText("English server message").query()).toBeNull();
		await expect
			.element(dialog.getByRole("button", { name: "Use https://new.example anyway" }))
			.toBeVisible();

		await input.fill("other.example");
		await expect.element(input).not.toHaveAttribute("aria-invalid");
	});

	it("keeps a typed domain through a press outside, and closes when nothing was typed", async () => {
		const { screen, dialog, input } = await openDialog();

		await pressOutside();
		await expect.element(dialog).not.toBeInTheDocument();

		await screen.getByRole("button", { name: "Open" }).click();
		await expect.element(dialog).toBeVisible();
		await input.fill("new.example");
		await pressOutside();
		await expect.element(dialog).toBeVisible();
		await expect.element(input).toHaveValue("new.example");

		await dialog.getByRole("button", { name: "Cancel" }).click();
		await expect.element(dialog).not.toBeInTheDocument();
	});
});
