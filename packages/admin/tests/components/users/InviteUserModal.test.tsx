import * as React from "react";
import { describe, it, expect, vi } from "vitest";
import { page, userEvent } from "vitest/browser";

import { InviteUserModal } from "../../../src/components/users/InviteUserModal";
import { render } from "../../utils/render";

const noop = () => {};

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
				page.getByText("The invited user will have this role once they complete registration."),
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

	it("submit button disabled when email is empty", async () => {
		const screen = await render(
			<InviteUserModal open={true} onOpenChange={noop} onInvite={noop} />,
		);
		const submitButton = screen.getByText("Send Invite").element().closest("button")!;
		expect(submitButton.disabled).toBe(true);
	});

	it("submit button disabled when isSending", async () => {
		const screen = await render(
			<InviteUserModal open={true} isSending={true} onOpenChange={noop} onInvite={noop} />,
		);
		const submitButton = screen.getByText("Sending...").element().closest("button")!;
		expect(submitButton.disabled).toBe(true);
	});

	it("shows error message when error prop provided", async () => {
		const screen = await render(
			<InviteUserModal
				open={true}
				error="Email already exists"
				onOpenChange={noop}
				onInvite={noop}
			/>,
		);
		await expect.element(screen.getByText("Email already exists")).toBeInTheDocument();
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
		expect(onOpenChange).toHaveBeenCalledWith(false, expect.anything());
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
			expect(onOpenChange).toHaveBeenCalledWith(false, expect.anything());
		} finally {
			writeText.mockRestore();
		}
	});
});
