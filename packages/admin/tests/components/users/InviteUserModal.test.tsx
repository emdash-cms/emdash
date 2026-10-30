import * as React from "react";
import { describe, it, expect, vi } from "vitest";
import { page, userEvent } from "vitest/browser";

import "../../../dist/styles.css";
import { InviteUserModal } from "../../../src/components/users/InviteUserModal";
import { ApiResponseError } from "../../../src/lib/api/client.js";
import { pressOutside } from "../../utils/mouse.ts";
import { render } from "../../utils/render";

const noop = () => {};

/** The invite route's part: opens the modal and answers each invite with `respond`. */
function Harness({
	respond = () => ({}),
}: {
	respond?: (email: string) => { error?: unknown; inviteUrl?: string };
}) {
	const [open, setOpen] = React.useState(false);
	const [error, setError] = React.useState<unknown>(null);
	const [inviteUrl, setInviteUrl] = React.useState<string | null>(null);
	return (
		<>
			<button type="button" onClick={() => setOpen(true)}>
				Open
			</button>
			<InviteUserModal
				open={open}
				error={error}
				inviteUrl={inviteUrl}
				onOpenChange={(next) => {
					setOpen(next);
					if (!next) {
						setError(null);
						setInviteUrl(null);
					}
				}}
				onInvite={(email) => {
					const result = respond(email);
					setError(result.error ?? null);
					setInviteUrl(result.inviteUrl ?? null);
				}}
			/>
		</>
	);
}

describe("InviteUserModal", () => {
	it("shows email input and role select when open", async () => {
		const screen = await render(
			<InviteUserModal open={true} onOpenChange={noop} onInvite={noop} />,
		);
		await expect.element(screen.getByLabelText("Email address")).toBeInTheDocument();
		await expect.element(screen.getByLabelText("Role", { exact: true })).toBeInTheDocument();
	});

	it("explains the role in a tooltip", async () => {
		const screen = await render(
			<InviteUserModal open={true} onOpenChange={noop} onInvite={noop} />,
		);
		await screen.getByRole("button", { name: "More information about Role" }).hover();
		await expect
			.element(
				page.getByRole("tooltip", {
					name: "The invited user will have this role once they complete registration.",
				}),
			)
			.toBeVisible();
	});

	it("default role is Author (30)", async () => {
		const screen = await render(
			<InviteUserModal open={true} onOpenChange={noop} onInvite={noop} />,
		);
		// The select should display "Author" as the selected value
		await expect.element(screen.getByText("Author")).toBeInTheDocument();
	});

	it("submit calls onInvite with email and role", async () => {
		const onInvite = vi.fn();
		const screen = await render(
			<InviteUserModal open={true} onOpenChange={noop} onInvite={onInvite} />,
		);
		const emailInput = screen.getByLabelText("Email address");
		await userEvent.type(emailInput, "new@example.com");
		const submitButton = screen.getByText("Send Invite").element().closest("button")!;
		submitButton.click();
		expect(onInvite).toHaveBeenCalledWith("new@example.com", 30);
	});

	it("points at a missing or invalid email when sent, and sends nothing", async () => {
		const onInvite = vi.fn();
		const screen = await render(
			<InviteUserModal open={true} onOpenChange={noop} onInvite={onInvite} />,
		);
		const email = screen.getByRole("textbox", { name: "Email address" });
		const send = screen.getByRole("button", { name: "Send Invite" });
		await expect.element(send).toBeEnabled();
		expect(screen.getByText("Enter an email address.").query()).toBeNull();

		await send.click();
		await expect.element(email).toHaveAccessibleDescription("Enter an email address.");
		await expect.element(email).toHaveAttribute("aria-invalid", "true");
		await expect.element(email).toHaveFocus();

		await email.fill("not-an-email");
		await userEvent.keyboard("{Enter}");
		await expect
			.element(email)
			.toHaveAccessibleDescription("Enter a valid email address, such as name@example.com.");
		expect(onInvite).not.toHaveBeenCalled();

		await email.fill(" new@example.com ");
		await expect.element(email).not.toHaveAttribute("aria-invalid");
		await userEvent.keyboard("{Enter}");
		expect(onInvite).toHaveBeenCalledWith("new@example.com", 30);
	});

	it("shows an address that already has an account on the email field", async () => {
		const taken = "Another user already uses this email address. Enter a different one.";
		const screen = await render(
			<Harness
				respond={() => ({
					error: new ApiResponseError(409, "USER_EXISTS", "A user with this email already exists"),
				})}
			/>,
		);
		await screen.getByRole("button", { name: "Open" }).click();
		const dialog = screen.getByRole("dialog", { name: "Invite User" });
		const email = dialog.getByRole("textbox", { name: "Email address" });
		await email.fill("dev@example.com");
		await dialog.getByRole("button", { name: "Send Invite" }).click();

		await expect.element(email).toHaveAccessibleDescription(taken);
		await expect.element(email).toHaveAttribute("aria-invalid", "true");
		await expect.element(email).toHaveFocus();
		expect(dialog.getByText("A user with this email already exists").query()).toBeNull();

		await email.fill("other@example.com");
		await expect.element(email).not.toHaveAttribute("aria-invalid");
		expect(dialog.getByText(taken).query()).toBeNull();
	});

	it("keeps a typed email through a press outside, and closes when nothing was typed", async () => {
		const screen = await render(<Harness />);
		await screen.getByRole("button", { name: "Open" }).click();
		const dialog = screen.getByRole("dialog", { name: "Invite User" });
		await expect.element(dialog).toBeVisible();

		await pressOutside();
		await expect.element(dialog).not.toBeInTheDocument();

		await screen.getByRole("button", { name: "Open" }).click();
		await expect.element(dialog).toBeVisible();
		await dialog.getByRole("textbox", { name: "Email address" }).fill("new@example.com");
		await pressOutside();
		await expect.element(dialog).toBeVisible();
		await expect
			.element(dialog.getByRole("textbox", { name: "Email address" }))
			.toHaveValue("new@example.com");
	});

	it("keeps the one-time invite link through a press outside, and closes with Done", async () => {
		const screen = await render(
			<Harness respond={() => ({ inviteUrl: "https://example.com/_emdash/admin/invite/abc" })} />,
		);
		await screen.getByRole("button", { name: "Open" }).click();
		const form = screen.getByRole("dialog", { name: "Invite User" });
		await form.getByRole("textbox", { name: "Email address" }).fill("new@example.com");
		await form.getByRole("button", { name: "Send Invite" }).click();

		const linkView = screen.getByRole("dialog", { name: "Invite Link Created" });
		await expect.element(linkView).toBeVisible();
		await pressOutside();
		await expect.element(linkView).toBeVisible();
		await expect
			.element(linkView.getByText("https://example.com/_emdash/admin/invite/abc"))
			.toBeVisible();

		await linkView.getByRole("button", { name: "Done" }).click();
		await expect.element(linkView).not.toBeInTheDocument();
	});

	it("moves focus to the copy button when the link replaces the form", async () => {
		const screen = await render(
			<InviteUserModal open={true} onOpenChange={noop} onInvite={noop} />,
		);
		await screen.getByRole("textbox", { name: "Email address" }).fill("new@example.com");
		await screen.getByRole("button", { name: "Send Invite" }).click();
		await screen.rerender(
			<InviteUserModal open={true} isSending onOpenChange={noop} onInvite={noop} />,
		);
		await screen.rerender(
			<InviteUserModal
				open={true}
				inviteUrl="https://example.com/_emdash/admin/invite/abc"
				onOpenChange={noop}
				onInvite={noop}
			/>,
		);

		await expect.element(screen.getByRole("button", { name: "Copy invite link" })).toHaveFocus();
	});

	it("submit button disabled when isSending", async () => {
		const screen = await render(
			<InviteUserModal open={true} isSending={true} onOpenChange={noop} onInvite={noop} />,
		);
		const submitButton = screen.getByText("Sending...").element().closest("button")!;
		expect(submitButton.disabled).toBe(true);
	});

	it("shows a failed invite that no field caused in the dialog's error banner", async () => {
		const screen = await render(
			<InviteUserModal
				open={true}
				error={new Error("Email provider rejected the message")}
				onOpenChange={noop}
				onInvite={noop}
			/>,
		);
		await expect
			.element(screen.getByRole("alert"))
			.toHaveTextContent("Email provider rejected the message");
	});

	it("form resets when modal opens", async () => {
		const result = await render(
			<InviteUserModal open={false} onOpenChange={noop} onInvite={noop} />,
		);
		// Open the modal - the effect should reset email to "" and role to 30
		await result.rerender(<InviteUserModal open={true} onOpenChange={noop} onInvite={noop} />);
		await expect.element(result.getByLabelText("Email address")).toHaveValue("");
	});

	it("cancel button closes modal", async () => {
		const onOpenChange = vi.fn();
		const screen = await render(
			<InviteUserModal open={true} onOpenChange={onOpenChange} onInvite={noop} />,
		);
		const cancelButton = screen.getByText("Cancel").element().closest("button")!;
		cancelButton.click();
		expect(onOpenChange).toHaveBeenCalledWith(false);
	});

	it("copies the invite link and closes with Done when there is no email provider", async () => {
		const onOpenChange = vi.fn();
		const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
		try {
			const screen = await render(
				<InviteUserModal
					open
					inviteUrl="https://example.com/_emdash/admin/invite/abc"
					onOpenChange={onOpenChange}
					onInvite={noop}
				/>,
			);

			const copy = screen.getByRole("button", { name: "Copy invite link" });
			await expect.element(copy).toBeEnabled();
			copy.element().click();
			await vi.waitFor(() =>
				expect(writeText).toHaveBeenCalledWith("https://example.com/_emdash/admin/invite/abc"),
			);
			await expect.element(screen.getByText("Copied to clipboard")).toBeInTheDocument();

			screen.getByRole("button", { name: "Done" }).element().click();
			expect(onOpenChange).toHaveBeenCalledWith(false);
		} finally {
			writeText.mockRestore();
		}
	});
});
