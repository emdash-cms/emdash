import * as React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";

import { CapabilityConsentDialog } from "../../src/components/CapabilityConsentDialog";
import { render } from "../utils/render.tsx";

describe("CapabilityConsentDialog", () => {
	let onConfirm: ReturnType<typeof vi.fn>;
	let onCancel: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		onConfirm = vi.fn();
		onCancel = vi.fn();
	});

	it("renders dialog with plugin name and capabilities", async () => {
		const screen = await render(
			<CapabilityConsentDialog
				pluginName="SEO Helper"
				capabilities={["read:content", "write:content"]}
				onConfirm={onConfirm}
				onCancel={onCancel}
			/>,
		);

		await expect
			.element(screen.getByText("SEO Helper requires the following permissions:"))
			.toBeInTheDocument();
		await expect.element(screen.getByText("Read your content")).toBeInTheDocument();
		await expect
			.element(screen.getByText("Create, update, and delete content"))
			.toBeInTheDocument();
	});

	it("shows 'Plugin Permissions' title for fresh install", async () => {
		const screen = await render(
			<CapabilityConsentDialog
				pluginName="Test"
				capabilities={["read:content"]}
				onConfirm={onConfirm}
				onCancel={onCancel}
			/>,
		);

		await expect.element(screen.getByText("Plugin Permissions")).toBeInTheDocument();
	});

	it("shows 'Review New Permissions' title for update with new capabilities", async () => {
		const screen = await render(
			<CapabilityConsentDialog
				pluginName="Test"
				capabilities={["read:content", "write:content"]}
				newCapabilities={["write:content"]}
				onConfirm={onConfirm}
				onCancel={onCancel}
			/>,
		);

		await expect.element(screen.getByText("Review New Permissions")).toBeInTheDocument();
		await expect
			.element(screen.getByText("Test is requesting additional permissions:"))
			.toBeInTheDocument();
	});

	it("marks new capabilities with NEW badge", async () => {
		const screen = await render(
			<CapabilityConsentDialog
				pluginName="Test"
				capabilities={["read:content", "write:content", "network:fetch"]}
				newCapabilities={["network:fetch"]}
				onConfirm={onConfirm}
				onCancel={onCancel}
			/>,
		);

		// The NEW badge should appear for network:fetch (exact match to avoid matching "New" in header)
		const newBadges = screen.getByText("NEW", { exact: true }).all();
		expect(newBadges.length).toBeGreaterThanOrEqual(1);
	});

	it("shows 'Accept & Install' button for fresh install", async () => {
		const screen = await render(
			<CapabilityConsentDialog
				pluginName="Test"
				capabilities={["read:content"]}
				onConfirm={onConfirm}
				onCancel={onCancel}
			/>,
		);

		await expect.element(screen.getByText("Accept & Install")).toBeInTheDocument();
	});

	it("shows 'Accept & Update' button for update", async () => {
		const screen = await render(
			<CapabilityConsentDialog
				pluginName="Test"
				capabilities={["read:content"]}
				newCapabilities={["read:content"]}
				onConfirm={onConfirm}
				onCancel={onCancel}
			/>,
		);

		await expect.element(screen.getByText("Accept & Update")).toBeInTheDocument();
	});

	it("calls onConfirm when confirm button is clicked", async () => {
		const screen = await render(
			<CapabilityConsentDialog
				pluginName="Test"
				capabilities={["read:content"]}
				onConfirm={onConfirm}
				onCancel={onCancel}
			/>,
		);

		await screen.getByText("Accept & Install").click();
		expect(onConfirm).toHaveBeenCalledOnce();
	});

	it("calls onCancel when cancel button is clicked", async () => {
		const screen = await render(
			<CapabilityConsentDialog
				pluginName="Test"
				capabilities={["read:content"]}
				onConfirm={onConfirm}
				onCancel={onCancel}
			/>,
		);

		await screen.getByText("Cancel").click();
		expect(onCancel).toHaveBeenCalledOnce();
	});

	it("shows warning banner for 'warn' audit verdict", async () => {
		const screen = await render(
			<CapabilityConsentDialog
				pluginName="Test"
				capabilities={["read:content"]}
				auditVerdict="warn"
				onConfirm={onConfirm}
				onCancel={onCancel}
			/>,
		);

		await expect
			.element(screen.getByText("Security audit flagged potential concerns with this plugin."))
			.toBeInTheDocument();
	});

	it("shows danger banner for 'fail' audit verdict", async () => {
		const screen = await render(
			<CapabilityConsentDialog
				pluginName="Test"
				capabilities={["read:content"]}
				auditVerdict="fail"
				onConfirm={onConfirm}
				onCancel={onCancel}
			/>,
		);

		await expect
			.element(screen.getByText("Security audit flagged this plugin as potentially unsafe."))
			.toBeInTheDocument();
	});

	it("shows no audit banner for 'pass' verdict", async () => {
		const screen = await render(
			<CapabilityConsentDialog
				pluginName="Test"
				capabilities={["read:content"]}
				auditVerdict="pass"
				onConfirm={onConfirm}
				onCancel={onCancel}
			/>,
		);

		const warnText = screen.getByText(
			"Security audit flagged potential concerns with this plugin.",
		);
		await expect.element(warnText).not.toBeInTheDocument();
	});

	it("shows pending state during install", async () => {
		const screen = await render(
			<CapabilityConsentDialog
				pluginName="Test"
				capabilities={["read:content"]}
				isPending={true}
				onConfirm={onConfirm}
				onCancel={onCancel}
			/>,
		);

		await expect.element(screen.getByText("Installing...")).toBeInTheDocument();
	});

	it("shows pending state during update", async () => {
		const screen = await render(
			<CapabilityConsentDialog
				pluginName="Test"
				capabilities={["read:content"]}
				newCapabilities={["read:content"]}
				isPending={true}
				onConfirm={onConfirm}
				onCancel={onCancel}
			/>,
		);

		await expect.element(screen.getByText("Updating...")).toBeInTheDocument();
	});

	it("appends allowed hosts for network:fetch", async () => {
		const screen = await render(
			<CapabilityConsentDialog
				pluginName="Test"
				capabilities={["network:fetch"]}
				allowedHosts={["api.example.com"]}
				onConfirm={onConfirm}
				onCancel={onCancel}
			/>,
		);

		await expect
			.element(screen.getByText("Make network requests to: api.example.com"))
			.toBeInTheDocument();
	});

	it("renders raw capability string for unknown capabilities", async () => {
		const screen = await render(
			<CapabilityConsentDialog
				pluginName="Test"
				capabilities={["custom:magic"]}
				onConfirm={onConfirm}
				onCancel={onCancel}
			/>,
		);

		await expect.element(screen.getByText("custom:magic")).toBeInTheDocument();
	});

	it("has correct dialog role and aria attributes", async () => {
		const screen = await render(
			<CapabilityConsentDialog
				pluginName="Test"
				capabilities={["read:content"]}
				onConfirm={onConfirm}
				onCancel={onCancel}
			/>,
		);

		const dialog = screen.getByRole("dialog");
		await expect.element(dialog).toBeInTheDocument();
	});

	// -----------------------------------------------------------------------
	// Moderation warnings
	// -----------------------------------------------------------------------

	const suspiciousCodeWarning = {
		value: "suspicious-code",
		name: "Suspicious code",
		description: "Concerning behavior lacks enough evidence for a blocking security label.",
		issuerDid: "did:plc:labeler",
	};

	it("shows the dialog with only the warnings section when there are no capabilities", async () => {
		const screen = await render(
			<CapabilityConsentDialog
				pluginName="Test"
				capabilities={[]}
				moderationWarnings={[suspiciousCodeWarning]}
				onConfirm={onConfirm}
				onCancel={onCancel}
			/>,
		);

		await expect.element(screen.getByRole("dialog")).toBeInTheDocument();
		await expect
			.element(screen.getByText("Moderation warnings", { exact: true }))
			.toBeInTheDocument();
		await expect.element(screen.getByText("Suspicious code")).toBeInTheDocument();
		await expect.element(screen.getByText("Issued by did:plc:labeler")).toBeInTheDocument();
	});

	it("shows both the warnings section and the capabilities list together", async () => {
		const screen = await render(
			<CapabilityConsentDialog
				pluginName="Test"
				capabilities={["read:content"]}
				moderationWarnings={[suspiciousCodeWarning]}
				onConfirm={onConfirm}
				onCancel={onCancel}
			/>,
		);

		await expect
			.element(screen.getByText("Moderation warnings", { exact: true }))
			.toBeInTheDocument();
		await expect.element(screen.getByText("Suspicious code")).toBeInTheDocument();
		await expect.element(screen.getByText("Read your content")).toBeInTheDocument();
	});

	it("proceeds via onConfirm with warnings present", async () => {
		const screen = await render(
			<CapabilityConsentDialog
				pluginName="Test"
				capabilities={["read:content"]}
				moderationWarnings={[suspiciousCodeWarning]}
				onConfirm={onConfirm}
				onCancel={onCancel}
			/>,
		);

		await screen.getByText("Accept & Install").click();
		expect(onConfirm).toHaveBeenCalledOnce();
	});

	it("renders no warnings section when moderationWarnings is empty", async () => {
		const screen = await render(
			<CapabilityConsentDialog
				pluginName="Test"
				capabilities={["read:content"]}
				onConfirm={onConfirm}
				onCancel={onCancel}
			/>,
		);

		expect(screen.getByText("Moderation warnings", { exact: true }).query()).toBeNull();
	});
});
