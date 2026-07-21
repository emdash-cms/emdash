/**
 * Email settings page
 *
 * Shows current email pipeline status, provider info, and allows
 * configuring the active email provider and sending a test email.
 */

import { Button, Input, Loader, Select, useKumoToastManager } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import {
	CheckCircle,
	Envelope,
	Gear,
	PaperPlaneTilt,
	PlugsConnected,
	WarningCircle,
} from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";

import {
	fetchEmailSettings,
	saveEmailSettings,
	sendTestEmail,
	type EmailProviderChoice,
	type EmailSettings as EmailSettingsData,
} from "../../lib/api/email-settings.js";
import { getMutationError } from "../DialogError.js";
import { BackToSettingsLink } from "./BackToSettingsLink.js";

const PROVIDER_OPTIONS: { value: EmailProviderChoice; label: string }[] = [
	{ value: "none", label: "None" },
	{ value: "smtp", label: "SMTP" },
	{ value: "cloudflare", label: "Cloudflare Email" },
];

export function EmailSettings() {
	const { t } = useLingui();
	const toastManager = useKumoToastManager();
	const queryClient = useQueryClient();
	const [testEmail, setTestEmail] = React.useState("");

	// Provider selection + SMTP form state
	const [provider, setProvider] = React.useState<EmailProviderChoice>("none");
	const [smtpHost, setSmtpHost] = React.useState("");
	const [smtpPort, setSmtpPort] = React.useState("587");
	const [smtpSecure, setSmtpSecure] = React.useState<"starttls" | "tls">("starttls");
	const [smtpUser, setSmtpUser] = React.useState("");
	const [smtpPass, setSmtpPass] = React.useState("");
	const [smtpFrom, setSmtpFrom] = React.useState("");

	const {
		data: settings,
		isLoading,
		error: fetchError,
	} = useQuery({
		queryKey: ["email-settings"],
		queryFn: fetchEmailSettings,
	});

	// Sync form state from fetched settings
	React.useEffect(() => {
		if (!settings) return;
		if (settings.selectedProviderId === "emdash-smtp") {
			setProvider("smtp");
			if (settings.smtp.host) setSmtpHost(settings.smtp.host);
			if (settings.smtp.port) setSmtpPort(String(settings.smtp.port));
			if (settings.smtp.secure) setSmtpSecure(settings.smtp.secure);
			if (settings.smtp.from) setSmtpFrom(settings.smtp.from);
		} else if (settings.selectedProviderId === "emdash-cloudflare-email") {
			setProvider("cloudflare");
		} else {
			setProvider("none");
		}
	}, [settings]);

	const saveMutation = useMutation({
		mutationFn: saveEmailSettings,
		onSuccess: (result) => {
			toastManager.add({ title: result.message, variant: "success", timeout: 5000 });
			setSmtpPass(""); // clear password field after save
			void queryClient.invalidateQueries({ queryKey: ["email-settings"] });
		},
		onError: (error) => {
			toastManager.add({
				title: t`Failed to save email settings`,
				description: getMutationError(error) || t`An error occurred`,
				variant: "error",
				timeout: 5000,
			});
		},
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

	const handleSave = () => {
		if (provider === "smtp") {
			if (!smtpHost || !smtpUser) {
				toastManager.add({
					title: t`Missing SMTP configuration`,
					description: t`Host and user are required.`,
					variant: "error",
					timeout: 5000,
				});
				return;
			}
			const port = Number.parseInt(smtpPort, 10);
			if (Number.isNaN(port) || port < 1 || port > 65535) {
				toastManager.add({
					title: t`Invalid port`,
					description: t`Port must be between 1 and 65535.`,
					variant: "error",
					timeout: 5000,
				});
				return;
			}
			saveMutation.mutate({
				provider: "smtp",
				smtp: {
					host: smtpHost,
					port,
					secure: smtpSecure,
					user: smtpUser,
					...(smtpPass ? { pass: smtpPass } : {}),
					...(smtpFrom ? { from: smtpFrom } : {}),
				},
			});
		} else {
			saveMutation.mutate({ provider });
		}
	};

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

	const hasCloudflareProvider = settings?.providers.some(
		(p) => p.pluginId === "emdash-cloudflare-email",
	);

	return (
		<div className="space-y-6">
			{/* Header */}
			<div className="flex items-center gap-3">
				<BackToSettingsLink />
				<h1 className="text-2xl font-bold">{t`Email Settings`}</h1>
			</div>

			{/* Provider configuration */}
			<div className="rounded-lg border bg-kumo-base p-6">
				<div className="flex items-center gap-2 mb-4">
					<Envelope className="h-5 w-5 text-kumo-subtle" />
					<h2 className="text-lg font-semibold">{t`Email Provider`}</h2>
				</div>

				<div className="space-y-4">
					<Select
						label={t`Provider`}
						value={provider}
						onValueChange={(value) => setProvider(value as EmailProviderChoice)}
						items={PROVIDER_OPTIONS.map((opt) => ({
							value: opt.value,
							label: opt.label,
							disabled: opt.value === "cloudflare" && !hasCloudflareProvider,
						}))}
					/>

					{provider === "smtp" && (
						<div className="space-y-4 pt-2 border-t">
							<div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
								<Input
									label={t`SMTP Host`}
									value={smtpHost}
									onChange={(e) => setSmtpHost(e.target.value)}
									placeholder="smtp-relay.brevo.com"
									required
								/>
								<Input
									label={t`Port`}
									type="number"
									value={smtpPort}
									onChange={(e) => setSmtpPort(e.target.value)}
									placeholder="587"
									required
								/>
								<Select
									label={t`Security`}
									value={smtpSecure}
									onValueChange={(value) => setSmtpSecure(value as "starttls" | "tls")}
									items={[
										{ value: "starttls", label: "STARTTLS (port 587)" },
										{ value: "tls", label: "Implicit TLS (port 465)" },
									]}
								/>
								<Input
									label={t`Username`}
									value={smtpUser}
									onChange={(e) => setSmtpUser(e.target.value)}
									placeholder="you@example.com"
									required
								/>
								<Input
									label={t`Password`}
									type="password"
									value={smtpPass}
									onChange={(e) => setSmtpPass(e.target.value)}
									placeholder={
										settings?.smtp.configured && settings.smtp.source === "db"
											? t`Leave empty to keep current password`
											: t`Enter SMTP password`
									}
								/>
								<Input
									label={t`Default Sender (optional)`}
									value={smtpFrom}
									onChange={(e) => setSmtpFrom(e.target.value)}
									placeholder="Site Name <noreply@example.com>"
								/>
							</div>
							<p className="text-xs text-kumo-subtle">
								{t`SMTP credentials are encrypted and stored in the database. The password field is write-only — leave it empty to keep the current password.`}
							</p>
						</div>
					)}

					{provider === "cloudflare" && (
						<div className="rounded-lg border border-kumo-info/50 bg-kumo-info-tint p-4">
							<p className="text-sm text-kumo-subtle">
								{t`Cloudflare Email uses the native send_email binding. Configure the sender address in your astro.config.mjs and add the EMAIL binding to wrangler.jsonc.`}
							</p>
						</div>
					)}

					<Button onClick={handleSave} disabled={saveMutation.isPending}>
						{saveMutation.isPending ? t`Saving...` : t`Save Settings`}
					</Button>
				</div>
			</div>

			{/* Pipeline status */}
			<div className="rounded-lg border bg-kumo-base p-6">
				<div className="flex items-center gap-2 mb-4">
					<Envelope className="h-5 w-5 text-kumo-subtle" />
					<h2 className="text-lg font-semibold">{t`Email Pipeline`}</h2>
				</div>

				<PipelineStatus settings={settings} />
			</div>

			{/* SMTP transport status */}
			{settings?.smtp.configured && (
				<div className="rounded-lg border bg-kumo-base p-6">
					<div className="flex items-center gap-2 mb-4">
						<Gear className="h-5 w-5 text-kumo-subtle" />
						<h2 className="text-lg font-semibold">{t`SMTP Transport`}</h2>
					</div>
					<div className="space-y-3">
						<div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
							<div>
								<p className="text-sm font-medium text-kumo-subtle">{t`Host`}</p>
								<p className="text-sm font-mono">{settings.smtp.host}</p>
							</div>
							<div>
								<p className="text-sm font-medium text-kumo-subtle">{t`Port`}</p>
								<p className="text-sm font-mono">{settings.smtp.port}</p>
							</div>
							<div>
								<p className="text-sm font-medium text-kumo-subtle">{t`Security`}</p>
								<p className="text-sm font-mono">
									{settings.smtp.secure === "tls" ? t`Implicit TLS` : t`STARTTLS`}
								</p>
							</div>
							{settings.smtp.from && (
								<div>
									<p className="text-sm font-medium text-kumo-subtle">{t`Default sender`}</p>
									<p className="text-sm font-mono">{settings.smtp.from}</p>
								</div>
							)}
						</div>
						<p className="text-xs text-kumo-subtle">
							{settings.smtp.source === "db"
								? t`SMTP is configured in the admin UI. Credentials are encrypted in the database.`
								: t`SMTP is configured via environment variables on the server.`}
						</p>
					</div>
				</div>
			)}

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
