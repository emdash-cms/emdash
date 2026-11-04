import { Toasty } from "@cloudflare/kumo";
import * as React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";

import type { EmailSettings as EmailSettingsData } from "../../../src/lib/api/email-settings";
import { render } from "../../utils/render";

const mockFetchEmailSettings = vi.fn<() => Promise<EmailSettingsData>>();
const mockSendTestEmail = vi.fn<(to: string) => Promise<{ success: boolean; message: string }>>();

vi.mock("@tanstack/react-router", async () => {
	const actual = await vi.importActual("@tanstack/react-router");
	return {
		...actual,
		Link: ({ children, to, ...props }: any) => (
			<a href={to} {...props}>
				{children}
			</a>
		),
	};
});

vi.mock("../../../src/lib/api/email-settings", async () => {
	const actual = await vi.importActual("../../../src/lib/api/email-settings");
	return {
		...actual,
		fetchEmailSettings: () => mockFetchEmailSettings(),
		sendTestEmail: (to: string) => mockSendTestEmail(to),
	};
});

const { EmailSettings } = await import("../../../src/components/settings/EmailSettings");

const availableSettings: EmailSettingsData = {
	available: true,
	providers: [{ pluginId: "resend" }, { pluginId: "postmark" }],
	selectedProviderId: "resend",
	middleware: {
		beforeSend: ["audit-log"],
		afterSend: ["delivery-metrics"],
	},
};

function Wrapper({ children }: { children: React.ReactNode }) {
	return <Toasty>{children}</Toasty>;
}

async function renderEmailSettings() {
	return render(<EmailSettings />, { wrapper: Wrapper });
}

beforeEach(() => {
	vi.clearAllMocks();
	mockFetchEmailSettings.mockResolvedValue(availableSettings);
	mockSendTestEmail.mockResolvedValue({ success: true, message: "Test email sent" });
});

describe("EmailSettings", () => {
	it("shows the shared frame while email settings load", async () => {
		mockFetchEmailSettings.mockReturnValue(new Promise(() => undefined));
		const screen = await renderEmailSettings();

		await expect
			.element(screen.getByRole("heading", { name: "Email Settings", level: 1 }))
			.toBeInTheDocument();
		await expect.element(screen.getByText("Loading...")).toBeInTheDocument();
		expect(screen.getByLabelText("Recipient email").query()).toBeNull();
	});

	it("shows a persistent load failure without test-email actions", async () => {
		mockFetchEmailSettings.mockRejectedValue(new Error("Email service unavailable"));
		const screen = await renderEmailSettings();

		await expect
			.element(screen.getByRole("alert"))
			.toHaveTextContent("Failed to load email settings");
		await expect.element(screen.getByRole("alert")).toHaveTextContent("Email service unavailable");
		expect(screen.getByLabelText("Recipient email").query()).toBeNull();
		expect(screen.getByRole("button", { name: "Send Test" }).query()).toBeNull();
	});

	it("explains when no email provider is available", async () => {
		mockFetchEmailSettings.mockResolvedValue({
			available: false,
			providers: [],
			selectedProviderId: null,
			middleware: { beforeSend: [], afterSend: [] },
		});
		const screen = await renderEmailSettings();

		await expect
			.element(screen.getByRole("heading", { name: "Email Pipeline", level: 2 }))
			.toBeInTheDocument();
		await expect.element(screen.getByText("No email provider configured")).toBeInTheDocument();
		await expect
			.element(screen.getByText(/invite links must be shared manually/i))
			.toBeInTheDocument();
		expect(screen.getByLabelText("Recipient email").query()).toBeNull();
	});

	it("shows the active provider, middleware, and additional providers", async () => {
		const screen = await renderEmailSettings();

		await expect.element(screen.getByText("Email provider active")).toBeInTheDocument();
		await expect.element(screen.getByText("resend", { exact: true })).toBeInTheDocument();
		await expect.element(screen.getByText(/audit-log/)).toBeInTheDocument();
		await expect.element(screen.getByText(/delivery-metrics/)).toBeInTheDocument();
		await expect.element(screen.getByText("Available Providers")).toBeInTheDocument();
		await expect.element(screen.getByText("resend, postmark")).toBeInTheDocument();
		await expect.element(screen.getByLabelText("Recipient email")).toBeInTheDocument();
	});

	it("sends a test email and clears the recipient after success", async () => {
		const screen = await renderEmailSettings();
		const recipient = screen.getByLabelText("Recipient email");
		await recipient.fill("editor@example.com");
		await userEvent.click(screen.getByRole("button", { name: "Send Test" }));

		await vi.waitFor(() => {
			expect(mockSendTestEmail).toHaveBeenCalledWith("editor@example.com");
		});
		await expect.element(screen.getByText("Test email sent")).toBeInTheDocument();
		await expect.element(recipient).toHaveValue("");
	});

	it("reports a test-email failure and preserves the recipient", async () => {
		mockSendTestEmail.mockRejectedValue(new Error("Provider rejected the message"));
		const screen = await renderEmailSettings();
		const recipient = screen.getByLabelText("Recipient email");
		await recipient.fill("editor@example.com");
		await userEvent.click(screen.getByRole("button", { name: "Send Test" }));

		await expect.element(screen.getByText("Failed to send test email")).toBeInTheDocument();
		await expect.element(screen.getByText("Provider rejected the message")).toBeInTheDocument();
		await expect.element(recipient).toHaveValue("editor@example.com");
	});
});
