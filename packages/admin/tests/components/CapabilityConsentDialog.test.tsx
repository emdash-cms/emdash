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

	it("states the combined unsaved-content and network egress boundary", async () => {
		const screen = await render(
			<CapabilityConsentDialog
				pluginName="Translator"
				capabilities={["admin.editor-draft:read", "network:request"]}
				allowedHosts={["translate.example"]}
				onConfirm={onConfirm}
				onCancel={onCancel}
			/>,
		);
		await expect.element(screen.getByText("Unsaved content may leave your site")).toBeVisible();
		await expect
			.element(
				screen.getByText(
					"After you explicitly invoke this plugin, it can send selected unsaved editor content to: translate.example",
				),
			)
			.toBeVisible();
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
			.element(
				screen.getByText(
					"Connect to network hosts and load external plugin admin images to: api.example.com",
				),
			)
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

	it("summarizes verified provenance and hides technical identifiers by default", async () => {
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

		await expect.element(screen.getByText("Build provenance verified")).toBeInTheDocument();
		await expect
			.element(screen.getByText("The build provenance matches this release and its package."))
			.toBeInTheDocument();
		expect(screen.getByText("bafy-profile").query()).toBeNull();
		expect(screen.getByText("bafy-release").query()).toBeNull();

		await screen.getByRole("button", { name: "Technical verification details" }).click();

		await expect.element(screen.getByText("bafy-profile")).toBeInTheDocument();
		await expect.element(screen.getByText("bafy-release")).toBeInTheDocument();
		await expect.element(screen.getByText("Provenance required")).toBeInTheDocument();
		await expect
			.element(screen.getByText("Publisher approval required for every delegated release"))
			.toBeInTheDocument();
		await expect.element(screen.getByText("did:plc:approver")).toBeInTheDocument();
	});

	it("uses a neutral summary when provenance is absent", async () => {
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

		await expect.element(screen.getByText("Signed release verified")).toBeInTheDocument();
		await expect
			.element(
				screen.getByText(
					"The signed publisher records and package are valid. Build provenance was not provided.",
				),
			)
			.toBeInTheDocument();
		expect(screen.getByText("Provenance optional").query()).toBeNull();
		expect(screen.getByText("bafy-profile").query()).toBeNull();
	});

	it("shows the permission total and a scroll cue for long lists", async () => {
		const screen = await render(
			<CapabilityConsentDialog
				pluginName="Test"
				capabilities={[
					"content:read",
					"content:write",
					"content:publish",
					"content:restore",
					"comments:read",
					"comments:moderate",
				]}
				onConfirm={onConfirm}
				onCancel={onCancel}
			/>,
		);

		await expect.element(screen.getByText("6 permissions requested")).toBeInTheDocument();
		await expect.element(screen.getByText("Scroll to review all")).toBeInTheDocument();
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
			await screen.getByRole("button", { name: "Technical verification details" }).click();

			expect(screen.getByText("bafy-profile").element().getAttribute("dir")).toBe("ltr");
			expect(screen.getByText("bafy-release").element().getAttribute("dir")).toBe("ltr");
			expect(screen.getByText("did:plc:approver").element().getAttribute("dir")).toBe("ltr");
		} finally {
			i18n.activate(previousLocale);
		}
	});
});
