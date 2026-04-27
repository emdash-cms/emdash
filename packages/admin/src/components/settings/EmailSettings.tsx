/**
 * Email settings page
 *
 * Shows current email pipeline status, provider info, and allows
 * sending a test email through the full pipeline.
 */

import { Button, Input, Loader } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import {
	ArrowLeft,
	CheckCircle,
	Envelope,
	PaperPlaneTilt,
	PlugsConnected,
	WarningCircle,
} from "@phosphor-icons/react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import * as React from "react";

import {
	fetchEmailSettings,
	sendTestEmail,
	type EmailSettings as EmailSettingsData,
} from "../../lib/api/email-settings.js";
import { getMutationError } from "../DialogError.js";

export function EmailSettings() {
	const { t } = useLingui();
	const [testEmail, setTestEmail] = React.useState("");
	const [status, setStatus] = React.useState<{
		type: "success" | "error";
		message: string;
	} | null>(null);

	// Clear status after 5 seconds
	React.useEffect(() => {
		if (!status) return;
		const timer = setTimeout(setStatus, 5000, null);
		return () => clearTimeout(timer);
	}, [status]);

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
			setStatus({ type: "success", message: result.message });
			setTestEmail("");
		},
		onError: (error) => {
			setStatus({
				type: "error",
				message: getMutationError(error) || t`Failed to send test email`,
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
					<Link to="/settings">
						<Button variant="ghost" shape="square" aria-label={t`Back to settings`}>
							<ArrowLeft className="h-4 w-4" />
						</Button>
					</Link>
					<h1 className="text-2xl font-bold">{t`Email Settings`}</h1>
				</div>
				<div className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800 dark:border-red-800 dark:bg-red-950/30 dark:text-red-200">
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
				<Link to="/settings">
					<Button variant="ghost" shape="square" aria-label={t`Back to settings`}>
						<ArrowLeft className="h-4 w-4" />
					</Button>
				</Link>
				<h1 className="text-2xl font-bold">{t`Email Settings`}</h1>
			</div>

			{/* Status banner */}
			{status && (
				<div
					className={`flex items-center gap-2 rounded-lg border p-3 text-sm ${
						status.type === "success"
							? "border-green-200 bg-green-50 text-green-800 dark:border-green-800 dark:bg-green-950/30 dark:text-green-200"
							: "border-red-200 bg-red-50 text-red-800 dark:border-red-800 dark:bg-red-950/30 dark:text-red-200"
					}`}
				>
					{status.type === "success" ? (
						<CheckCircle className="h-4 w-4 flex-shrink-0" />
					) : (
						<WarningCircle className="h-4 w-4 flex-shrink-0" />
					)}
					{status.message}
				</div>
			)}

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
			<div className="rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/30 p-4">
				<div className="flex items-start gap-3">
					<WarningCircle className="h-5 w-5 text-amber-600 dark:text-amber-400 mt-0.5 flex-shrink-0" />
					<div>
						<p className="text-sm font-medium text-amber-800 dark:text-amber-200">
							{t`No email provider configured`}
						</p>
						<p className="text-sm text-amber-700 dark:text-amber-300 mt-1">
							{t`Install and activate an email provider plugin to enable email features like invitations, magic links, and password recovery.`}
						</p>
						<p className="text-sm text-amber-700 dark:text-amber-300 mt-2">
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
			<div className="flex items-center gap-3 p-3 rounded-md bg-green-50 dark:bg-green-950/20 border border-green-200 dark:border-green-800">
				<CheckCircle className="h-5 w-5 text-green-600 dark:text-green-400 flex-shrink-0" />
				<div>
					<p className="text-sm font-medium text-green-800 dark:text-green-200">
						{t`Email provider active`}
					</p>
					<p className="text-sm text-green-700 dark:text-green-300">
						{t`Provider:`}{" "}
						<code className="rounded bg-green-100 dark:bg-green-900/40 px-1.5 py-0.5 text-xs">
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
