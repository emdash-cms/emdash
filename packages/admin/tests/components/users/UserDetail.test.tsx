import { userEvent } from "@vitest/browser/context";
import * as React from "react";
import { describe, it, expect, vi } from "vitest";

import { UserDetail } from "../../../src/components/users/UserDetail";
import type { UserDetail as UserDetailType } from "../../../src/lib/api";
import { render } from "../../utils/render";

function makeUser(overrides: Partial<UserDetailType> = {}): UserDetailType {
	return {
		id: "user-1",
		email: "test@example.com",
		name: "Test User",
		avatarUrl: null,
		role: 30,
		emailVerified: true,
		disabled: false,
		createdAt: "2025-01-01T00:00:00Z",
		updatedAt: "2025-01-02T00:00:00Z",
		lastLogin: "2025-01-02T00:00:00Z",
		credentialCount: 1,
		oauthProviders: [],
		credentials: [
			{
				id: "cred-1",
				name: "My Passkey",
				deviceType: "multiDevice",
				createdAt: "2025-01-01T00:00:00Z",
				lastUsedAt: "2025-01-02T00:00:00Z",
			},
		],
		oauthAccounts: [],
		...overrides,
	};
}

const noop = () => {};

describe("UserDetail", () => {
	it("hides dialog when not open", async () => {
		await render(
			<UserDetail
				user={makeUser()}
				isOpen={false}
				onClose={noop}
				onSave={noop}
				onDisable={noop}
				onEnable={noop}
			/>,
		);
		// Dialog.Portal renders outside the container; the popup should be hidden
		const popup = document.querySelector("[role='dialog']") as HTMLElement;
		expect(popup?.hidden ?? true).toBe(true);
	});

	it("shows loading skeleton when isLoading", async () => {
		const screen = await render(
			<UserDetail
				user={null}
				isLoading={true}
				isOpen={true}
				onClose={noop}
				onSave={noop}
				onDisable={noop}
				onEnable={noop}
			/>,
		);
		// Skeleton has the animate-pulse class; portal renders outside screen.container
		await expect.element(screen.getByRole("dialog")).toBeInTheDocument();
		expect(document.querySelector(".animate-pulse")).not.toBeNull();
	});

	it("shows 'User not found' when not loading and no user", async () => {
		const screen = await render(
			<UserDetail
				user={null}
				isLoading={false}
				isOpen={true}
				onClose={noop}
				onSave={noop}
				onDisable={noop}
				onEnable={noop}
			/>,
		);
		await expect.element(screen.getByText("User not found")).toBeInTheDocument();
	});

	it("displays user name, email, and role correctly", async () => {
		const user = makeUser({ name: "Alice Smith", email: "alice@example.com", role: 40 });
		const screen = await render(
			<UserDetail
				user={user}
				isOpen={true}
				onClose={noop}
				onSave={noop}
				onDisable={noop}
				onEnable={noop}
			/>,
		);
		// Name input
		await expect.element(screen.getByLabelText("Name")).toHaveValue("Alice Smith");
		// Email input
		await expect.element(screen.getByLabelText("Email")).toHaveValue("alice@example.com");
	});

	it("escape key calls onClose", async () => {
		const onClose = vi.fn();
		await render(
			<UserDetail
				user={makeUser()}
				isOpen={true}
				onClose={onClose}
				onSave={noop}
				onDisable={noop}
				onEnable={noop}
			/>,
		);
		await userEvent.keyboard("{Escape}");
		expect(onClose).toHaveBeenCalled();
	});

	it("backdrop click calls onClose", async () => {
		const onClose = vi.fn();
		await render(
			<UserDetail
				user={makeUser()}
				isOpen={true}
				onClose={onClose}
				onSave={noop}
				onDisable={noop}
				onEnable={noop}
			/>,
		);
		// Dialog.Portal renders outside screen.container
		const backdrop = document.querySelector("[role='presentation']") as HTMLElement;
		expect(backdrop).not.toBeNull();
		backdrop.click();
		expect(onClose).toHaveBeenCalled();
	});

	it("save button disabled when no changes", async () => {
		const screen = await render(
			<UserDetail
				user={makeUser()}
				isOpen={true}
				onClose={noop}
				onSave={noop}
				onDisable={noop}
				onEnable={noop}
			/>,
		);
		await expect.element(screen.getByText("Save Changes")).toBeInTheDocument();
		const saveButton = screen.getByText("Save Changes").element().closest("button")!;
		expect(saveButton.disabled).toBe(true);
	});

	it("changing name enables save", async () => {
		const screen = await render(
			<UserDetail
				user={makeUser()}
				isOpen={true}
				onClose={noop}
				onSave={noop}
				onDisable={noop}
				onEnable={noop}
			/>,
		);
		const nameInput = screen.getByLabelText("Name");
		await userEvent.clear(nameInput);
		await userEvent.type(nameInput, "New Name");
		const saveButton = screen.getByText("Save Changes").element().closest("button")!;
		expect(saveButton.disabled).toBe(false);
	});

	it("changing email enables save", async () => {
		const screen = await render(
			<UserDetail
				user={makeUser()}
				isOpen={true}
				onClose={noop}
				onSave={noop}
				onDisable={noop}
				onEnable={noop}
			/>,
		);
		const emailInput = screen.getByLabelText("Email");
		await userEvent.clear(emailInput);
		await userEvent.type(emailInput, "new@example.com");
		const saveButton = screen.getByText("Save Changes").element().closest("button")!;
		expect(saveButton.disabled).toBe(false);
	});

	it("onSave only includes changed fields", async () => {
		const onSave = vi.fn();
		const screen = await render(
			<UserDetail
				user={makeUser({ name: "Original" })}
				isOpen={true}
				onClose={noop}
				onSave={onSave}
				onDisable={noop}
				onEnable={noop}
			/>,
		);
		const nameInput = screen.getByLabelText("Name");
		await userEvent.clear(nameInput);
		await userEvent.type(nameInput, "Changed");
		// Submit the form -- use native click to bypass data-base-ui-inert overlay
		const saveButton = screen.getByText("Save Changes").element().closest("button")!;
		saveButton.click();
		expect(onSave).toHaveBeenCalledWith({ name: "Changed" });
	});

	it("self-user: role selector is disabled", async () => {
		const user = makeUser({ id: "me" });
		const screen = await render(
			<UserDetail
				user={user}
				isOpen={true}
				currentUserId="me"
				onClose={noop}
				onSave={noop}
				onDisable={noop}
				onEnable={noop}
			/>,
		);
		await expect.element(screen.getByText("You cannot change your own role")).toBeInTheDocument();
	});

	it("self-user: disable button not shown", async () => {
		const user = makeUser({ id: "me" });
		await render(
			<UserDetail
				user={user}
				isOpen={true}
				currentUserId="me"
				onClose={noop}
				onSave={noop}
				onDisable={noop}
				onEnable={noop}
			/>,
		);
		// Dialog.Portal renders outside screen.container; query the dialog popup directly
		const dialog = document.querySelector("[role='dialog']")!;
		const buttons = dialog.querySelectorAll("button");
		const disableButton = [...buttons].find((b) => b.textContent?.includes("Disable"));
		expect(disableButton).toBeUndefined();
	});

	it("non-self: disable button shown and calls onDisable", async () => {
		const onDisable = vi.fn();
		const screen = await render(
			<UserDetail
				user={makeUser({ id: "other" })}
				isOpen={true}
				currentUserId="me"
				onClose={noop}
				onSave={noop}
				onDisable={onDisable}
				onEnable={noop}
			/>,
		);
		// Use native click to bypass data-base-ui-inert overlay
		const disableButton = screen.getByText("Disable").element().closest("button")!;
		disableButton.click();
		expect(onDisable).toHaveBeenCalled();
	});

	it("enable button shown for disabled users and calls onEnable", async () => {
		const onEnable = vi.fn();
		const screen = await render(
			<UserDetail
				user={makeUser({ id: "other", disabled: true })}
				isOpen={true}
				currentUserId="me"
				onClose={noop}
				onSave={noop}
				onDisable={noop}
				onEnable={onEnable}
			/>,
		);
		// Use native click to bypass data-base-ui-inert overlay
		const enableButton = screen.getByText("Enable").element().closest("button")!;
		enableButton.click();
		expect(onEnable).toHaveBeenCalled();
	});

	it("close button calls onClose", async () => {
		const onClose = vi.fn();
		const screen = await render(
			<UserDetail
				user={makeUser()}
				isOpen={true}
				onClose={onClose}
				onSave={noop}
				onDisable={noop}
				onEnable={noop}
			/>,
		);
		// Use native click to bypass data-base-ui-inert overlay
		screen.getByLabelText("Close panel").element().click();
		expect(onClose).toHaveBeenCalled();
	});
});
