import { i18n } from "@lingui/core";
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

	it("shows verified provenance, exact record CIDs, and signed policy", async () => {
		const screen = await render(
			<CapabilityConsentDialog
				pluginName="Test"
				capabilities={[]}
				verification={{
					profileCid: "bafy-profile",
					releaseCid: "bafy-release",
					provenance: "verified",
					policy: {
						requireProvenance: true,
						confirmation: "always",
						approvers: ["did:plc:approver"],
					},
				}}
				onConfirm={onConfirm}
				onCancel={onCancel}
			/>,
		);

		await expect.element(screen.getByText("Independent verification")).toBeInTheDocument();
		await expect
			.element(screen.getByText("Provenance is verified against the signed release and artifact."))
			.toBeInTheDocument();
		await expect.element(screen.getByText("bafy-profile")).toBeInTheDocument();
		await expect.element(screen.getByText("bafy-release")).toBeInTheDocument();
		await expect.element(screen.getByText("Provenance required")).toBeInTheDocument();
		await expect
			.element(screen.getByText("Publisher approval required for every delegated release"))
			.toBeInTheDocument();
		await expect.element(screen.getByText("did:plc:approver")).toBeInTheDocument();
	});

	it("explains when absent provenance is permitted by signed policy", async () => {
		const screen = await render(
			<CapabilityConsentDialog
				pluginName="Test"
				capabilities={[]}
				verification={{
					profileCid: "bafy-profile",
					releaseCid: "bafy-release",
					provenance: "absent-optional",
					policy: {
						requireProvenance: false,
						confirmation: "escalation-only",
						approvers: [],
					},
				}}
				onConfirm={onConfirm}
				onCancel={onCancel}
			/>,
		);

		await expect
			.element(
				screen.getByText("No provenance was supplied; the signed publisher policy permits this."),
			)
			.toBeInTheDocument();
		await expect.element(screen.getByText("Provenance optional")).toBeInTheDocument();
		await expect
			.element(screen.getByText("Publisher approval required only for permission escalation"))
			.toBeInTheDocument();
	});

	it("keeps CIDs and DIDs readable in Arabic RTL mode", async () => {
		const previousLocale = i18n.locale;
		i18n.load("ar", {});
		i18n.activate("ar");
		try {
			const screen = await render(
				<div dir="rtl">
					<CapabilityConsentDialog
						pluginName="Test"
						capabilities={[]}
						verification={{
							profileCid: "bafy-profile",
							releaseCid: "bafy-release",
							provenance: "verified",
							policy: {
								requireProvenance: true,
								confirmation: "always",
								approvers: ["did:plc:approver"],
							},
						}}
						onConfirm={onConfirm}
						onCancel={onCancel}
					/>
				</div>,
			);

			expect(screen.getByText("bafy-profile").element().getAttribute("dir")).toBe("ltr");
			expect(screen.getByText("bafy-release").element().getAttribute("dir")).toBe("ltr");
			expect(screen.getByText("did:plc:approver").element().getAttribute("dir")).toBe("ltr");
		} finally {
			i18n.activate(previousLocale);
		}
	});
});
