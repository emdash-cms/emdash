import { Toasty } from "@cloudflare/kumo";
import * as React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import "../../dist/styles.css";
import { ApiResponseError } from "../../src/lib/api/client";
import { UsersPage } from "../../src/routes/users";
import { render } from "../utils/render";

const mockInviteUser = vi.fn();

vi.mock("../../src/lib/api", async () => {
	const actual = await vi.importActual("../../src/lib/api");
	return {
		...actual,
		fetchUsers: vi.fn(async () => ({ items: [] })),
		fetchManifest: vi.fn(async () => ({})),
		inviteUser: (...args: unknown[]) => mockInviteUser(...args),
	};
});

async function openInvite() {
	const screen = await render(
		<Toasty>
			<UsersPage />
		</Toasty>,
	);
	await screen.getByRole("button", { name: "Invite User" }).first().click();
	const dialog = screen.getByRole("dialog", { name: "Invite User" });
	await expect.element(dialog).toBeVisible();
	return { screen, dialog, email: dialog.getByRole("textbox", { name: "Email address" }) };
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("UsersPage invitations", () => {
	it("confirms an emailed invitation once the dialog closes", async () => {
		mockInviteUser.mockResolvedValue({ success: true, message: "Invite sent" });
		const { screen, dialog, email } = await openInvite();
		await email.fill("new@example.com");
		await dialog.getByRole("button", { name: "Send Invite" }).click();

		await expect.element(dialog).not.toBeInTheDocument();
		await expect.element(screen.getByText("Invitation sent to new@example.com")).toBeVisible();
		expect(mockInviteUser).toHaveBeenCalledWith("new@example.com", 30);
	});

	it("leaves the address alone when Send Invite is pressed again after its refusal went to the banner", async () => {
		let refuse!: () => void;
		mockInviteUser
			.mockImplementationOnce(
				() =>
					new Promise((_, reject) => {
						refuse = () =>
							reject(
								new ApiResponseError(409, "USER_EXISTS", "A user with this email already exists"),
							);
					}),
			)
			.mockImplementationOnce(() => new Promise(() => {}));
		const { dialog, email } = await openInvite();
		await email.fill("dev@example.com");
		await dialog.getByRole("button", { name: "Send Invite" }).click();
		await expect.element(dialog.getByRole("button", { name: "Sending..." })).toBeVisible();
		await email.fill("other@example.com");
		refuse();
		await expect.element(dialog.getByText("A user with this email already exists")).toBeVisible();

		await dialog.getByRole("button", { name: "Send Invite" }).click();
		await expect.element(dialog.getByRole("button", { name: "Sending..." })).toBeVisible();
		await expect.element(email).not.toHaveFocus();
	});

	it("opens again without the last invite's failure", async () => {
		mockInviteUser.mockRejectedValue(new Error("Email provider rejected the message"));
		const { screen, dialog, email } = await openInvite();
		await email.fill("new@example.com");
		await dialog.getByRole("button", { name: "Send Invite" }).click();
		await expect
			.element(dialog.getByRole("alert"))
			.toHaveTextContent("Email provider rejected the message");

		await dialog.getByRole("button", { name: "Cancel" }).click();
		await expect.element(dialog).not.toBeInTheDocument();
		await screen.getByRole("button", { name: "Invite User" }).first().click();
		await expect.element(dialog).toBeVisible();
		expect(dialog.getByRole("alert").query()).toBeNull();
	});
});
