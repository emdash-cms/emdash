/**
 * Email settings page
 *
 * Shows current email pipeline status, provider info, and allows
 * sending a test email through the full pipeline.
 */

import { Button, Input, Loader, useKumoToastManager } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import {
	CheckCircle,
	Envelope,
	PaperPlaneTilt,
	PlugsConnected,
	WarningCircle,
} from "@phosphor-icons/react";
import { useMutation, useQuery } from "@tanstack/react-query";
import * as React from "react";

import {
	fetchEmailSettings,
	sendTestEmail,
	type EmailSettings as EmailSettingsData,
} from "../../lib/api/email-settings.js";
import { getMutationError } from "../DialogError.js";
import { BackToSettingsLink } from "./BackToSettingsLink.js";

export function EmailSettings() {
	const { t } = useLingui();
	const toastManager = useKumoToastManager();
	const [testEmail, setTestEmail] = React.useState("");

	const {
		data: settings,
		isLoading,
		error: fetchError,
	} = useQuery({
		queryKey: ["email-settings"],
		queryFn: fetchEmailSettings,
	});

	const testMutation = useMutation({
		mutationFn: (to: string) => sendTestEmail(to),
		onSuccess: (result) => {
			toastManager.add({ title: result.message, variant: "success", timeout: 5000 });
			setTestEmail("");
		},
		onError: (error) => {
			toastManager.add({
				title: t`Failed to send test email`,
				description: getMutationError(error) || t`An error occurred`,
				variant: "error",
				timeout: 5000,
			});
		},
	});

	const handleTestSubmit = (e: React.FormEvent) => {
		e.preventDefault();
		if (!testEmail) return;
		testMutation.mutate(testEmail);
	};

	if (isLoading) {
		return (
			<div className="flex items-center justify-center py-12">
				<Loader size="lg" />
			</div>
		);
	}

	if (fetchError) {
		return (
			<div className="space-y-6">
				<div className="flex items-center gap-3">
					<BackToSettingsLink />
					<h1 className="text-2xl font-bold">{t`Email Settings`}</h1>
				</div>
				<div className="flex items-center gap-2 rounded-lg border border-kumo-danger/50 bg-kumo-danger/10 p-3 text-sm text-kumo-danger">
					<WarningCircle className="h-4 w-4 flex-shrink-0" />
					{getMutationError(fetchError) || t`Failed to load email settings`}
				</div>
			</div>
		);
	}

	return (
		<div className="space-y-6">
			{/* Header */}
			<div className="flex items-center gap-3">
				<BackToSettingsLink />
				<h1 className="text-2xl font-bold">{t`Email Settings`}</h1>
			</div>

			{/* Pipeline status */}
			<div className="rounded-lg border bg-kumo-base p-6">
				<div className="flex items-center gap-2 mb-4">
					<Envelope className="h-5 w-5 text-kumo-subtle" />
					<h2 className="text-lg font-semibold">{t`Email Pipeline`}</h2>
				</div>

				<PipelineStatus settings={settings} />
			</div>

			{/* Test email */}
			{settings?.available && (
				<div className="rounded-lg border bg-kumo-base p-6">
					<div className="flex items-center gap-2 mb-4">
						<PaperPlaneTilt className="h-5 w-5 text-kumo-subtle" />
						<h2 className="text-lg font-semibold">{t`Send Test Email`}</h2>
					</div>
					<p className="text-sm text-kumo-subtle mb-4">
						{t`Send a test email through the full pipeline to verify your email configuration.`}
					</p>
					<form onSubmit={handleTestSubmit} className="flex items-end gap-3">
						<div className="flex-1">
							<Input
								label={t`Recipient email`}
								type="email"
								value={testEmail}
								onChange={(e) => setTestEmail(e.target.value)}
								placeholder={t`test@example.com`}
								required
							/>
						</div>
						<Button type="submit" disabled={testMutation.isPending || !testEmail}>
							{testMutation.isPending ? t`Sending...` : t`Send Test`}
						</Button>
					</form>
				</div>
			)}
		</div>
	);
}

// =============================================================================
// Pipeline status display
// =============================================================================

function PipelineStatus({ settings }: { settings: EmailSettingsData | undefined }) {
	const { t } = useLingui();

	if (!settings) return null;

	if (!settings.available) {
		return (
			<div className="rounded-lg border border-kumo-warning/50 bg-kumo-warning-tint p-4">
				<div className="flex items-start gap-3">
					<WarningCircle className="h-5 w-5 text-kumo-warning mt-0.5 flex-shrink-0" />
					<div>
						<p className="text-sm font-medium text-kumo-warning">
							{t`No email provider configured`}
						</p>
						<p className="text-sm text-kumo-subtle mt-1">
							{t`Install and activate an email provider plugin to enable email features like invitations, magic links, and password recovery.`}
						</p>
						<p className="text-sm text-kumo-subtle mt-2">
							{t`Without an email provider, invite links must be shared manually.`}
						</p>
					</div>
				</div>
			</div>
		);
	}

	return (
		<div className="space-y-4">
			{/* Provider */}
			<div className="flex items-center gap-3 p-3 rounded-md bg-kumo-success-tint border border-kumo-success/50">
				<CheckCircle className="h-5 w-5 text-kumo-success flex-shrink-0" />
				<div>
					<p className="text-sm font-medium text-kumo-success">{t`Email provider active`}</p>
					<p className="text-sm text-kumo-subtle">
						{t`Provider:`}{" "}
						<code className="rounded bg-kumo-tint px-1.5 py-0.5 text-xs">
							{settings.selectedProviderId || "default"}
						</code>
					</p>
				</div>
			</div>

			{/* Middleware */}
			{(settings.middleware.beforeSend.length > 0 || settings.middleware.afterSend.length > 0) && (
				<div className="p-3 rounded-md bg-kumo-tint/50 border">
					<div className="flex items-center gap-2 mb-2">
						<PlugsConnected className="h-4 w-4 text-kumo-subtle" />
						<p className="text-sm font-medium">{t`Email Middleware`}</p>
					</div>
					{settings.middleware.beforeSend.length > 0 && (
						<p className="text-sm text-kumo-subtle">
							{t`Before send:`} {settings.middleware.beforeSend.join(", ")}
						</p>
					)}
					{settings.middleware.afterSend.length > 0 && (
						<p className="text-sm text-kumo-subtle">
							{t`After send:`} {settings.middleware.afterSend.join(", ")}
						</p>
					)}
				</div>
			)}

			{/* Available providers (if multiple) */}
			{settings.providers.length > 1 && (
				<div className="p-3 rounded-md bg-kumo-tint/50 border">
					<p className="text-sm font-medium mb-1">{t`Available Providers`}</p>
					<p className="text-sm text-kumo-subtle">
						{settings.providers.map((p) => p.pluginId).join(", ")}
					</p>
				</div>
			)}
		</div>
	);
}
