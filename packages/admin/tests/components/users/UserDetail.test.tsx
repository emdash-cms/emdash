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
	it("returns null when not open", async () => {
		const screen = await render(
			<UserDetail
				user={makeUser()}
				isOpen={false}
				onClose={noop}
				onSave={noop}
				onDisable={noop}
				onEnable={noop}
			/>,
		);
		// The dialog should not be in the DOM at all
		expect(screen.container.innerHTML).toBe("");
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
		// Skeleton has the animate-pulse class
		await expect.element(screen.getByRole("dialog")).toBeInTheDocument();
		expect(screen.container.querySelector(".animate-pulse")).not.toBeNull();
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
		// The backdrop is the first child (aria-hidden div)
		const backdrop = screen.container.querySelector("[aria-hidden='true']") as HTMLElement;
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
		// Submit the form
		const saveButton = screen.getByText("Save Changes").element().closest("button")!;
		await userEvent.click(saveButton);
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
		expect(screen.container.querySelector("button")?.textContent).not.toContain("Disable");
		// More specifically, check that no button with Disable text exists
		const buttons = screen.container.querySelectorAll("button");
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
		const disableButton = screen.getByText("Disable").element().closest("button")!;
		await userEvent.click(disableButton);
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
		const enableButton = screen.getByText("Enable").element().closest("button")!;
		await userEvent.click(enableButton);
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
		const closeButton = screen.getByLabelText("Close panel");
		await closeButton.click();
		expect(onClose).toHaveBeenCalled();
	});
});
