/**
 * Email settings page
 *
 * Shows current email pipeline status, provider info, and allows
 * configuring the active email provider and sending a test email.
 */

import { Banner, Button, Input, Loader, Select, useKumoToastManager } from "@cloudflare/kumo";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { CheckCircle, PaperPlaneTilt, PlugsConnected, WarningCircle } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";

import {
	fetchEmailSettings,
	saveEmailSettings,
	sendTestEmail,
	testCloudflareBinding,
	type EmailProviderChoice,
	type EmailSettings as EmailSettingsData,
} from "../../lib/api/email-settings.js";
import { getMutationError } from "../DialogError.js";
import { SettingRow, SettingsFrame, SettingsSection } from "./SettingsLayout.js";

const PROVIDER_OPTIONS: { value: EmailProviderChoice; label: MessageDescriptor }[] = [
	{ value: "none", label: msg`None` },
	{ value: "smtp", label: msg`SMTP` },
	{ value: "cloudflare", label: msg`Cloudflare Email` },
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
	// Track whether the user has manually overridden encryption — if not,
	// changing the port auto-suggests the matching security mode. Prevents
	// the classic "587 + implicit TLS" mismatch.
	const [smtpSecureTouched, setSmtpSecureTouched] = React.useState(false);
	const [smtpFromName, setSmtpFromName] = React.useState("");
	const [smtpFromEmail, setSmtpFromEmail] = React.useState("");
	const [smtpReplyTo, setSmtpReplyTo] = React.useState("");
	// Cloudflare form state
	const [cfFromName, setCfFromName] = React.useState("");
	const [cfFromEmail, setCfFromEmail] = React.useState("");
	const [cfReplyTo, setCfReplyTo] = React.useState("");

	const {
		data: settings,
		isLoading,
		error: fetchError,
	} = useQuery({
		queryKey: ["email-settings"],
		queryFn: fetchEmailSettings,
	});

	// Sync form state from fetched settings. Saved transport config is
	// prefilled regardless of which provider is selected, so switching back
	// to a previously configured provider does not require retyping.
	React.useEffect(() => {
		if (!settings) return;
		if (settings.selectedProviderId === "emdash-smtp") {
			setProvider("smtp");
		} else if (settings.selectedProviderId === "emdash-cloudflare-email") {
			setProvider("cloudflare");
		} else {
			setProvider("none");
		}
		if (settings.smtp.configured) {
			if (settings.smtp.host) setSmtpHost(settings.smtp.host);
			if (settings.smtp.port) setSmtpPort(String(settings.smtp.port));
			if (settings.smtp.secure) setSmtpSecure(settings.smtp.secure);
			if (settings.smtp.user) setSmtpUser(settings.smtp.user);
			if (settings.smtp.fromName) setSmtpFromName(settings.smtp.fromName);
			if (settings.smtp.fromEmail) setSmtpFromEmail(settings.smtp.fromEmail);
			if (settings.smtp.replyTo) setSmtpReplyTo(settings.smtp.replyTo);
		}
		if (settings.cloudflare.configured) {
			if (settings.cloudflare.fromName) setCfFromName(settings.cloudflare.fromName);
			if (settings.cloudflare.fromEmail) setCfFromEmail(settings.cloudflare.fromEmail);
			if (settings.cloudflare.replyTo) setCfReplyTo(settings.cloudflare.replyTo);
		}
	}, [settings]);

	const saveMutation = useMutation({
		mutationFn: saveEmailSettings,
		onSuccess: () => {
			toastManager.add({ title: t`Email settings saved`, variant: "success", timeout: 5000 });
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
		onSuccess: () => {
			toastManager.add({ title: t`Test email sent`, variant: "success", timeout: 5000 });
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

	const bindingMutation = useMutation({
		mutationFn: testCloudflareBinding,
		onSuccess: (result) => {
			if (result.available) {
				toastManager.add({
					title: t`Cloudflare Email binding is available`,
					variant: "success",
					timeout: 5000,
				});
			} else {
				toastManager.add({
					title: t`Binding not available`,
					description: result.message,
					variant: "warning",
					timeout: 8000,
				});
			}
		},
		onError: (error) => {
			toastManager.add({
				title: t`Failed to test binding`,
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
					...(smtpFromName.trim() ? { fromName: smtpFromName.trim() } : {}),
					...(smtpFromEmail.trim() ? { fromEmail: smtpFromEmail.trim() } : {}),
					...(smtpReplyTo.trim() ? { replyTo: smtpReplyTo.trim() } : {}),
				},
			});
		} else if (provider === "cloudflare") {
			if (!cfFromName.trim() || !cfFromEmail.trim()) {
				toastManager.add({
					title: t`Missing Cloudflare Email configuration`,
					description: t`Sender name and email are required.`,
					variant: "error",
					timeout: 5000,
				});
				return;
			}
			saveMutation.mutate({
				provider: "cloudflare",
				cloudflare: {
					fromName: cfFromName.trim(),
					fromEmail: cfFromEmail.trim(),
					...(cfReplyTo.trim() ? { replyTo: cfReplyTo.trim() } : {}),
				},
			});
		} else {
			saveMutation.mutate({ provider });
		}
	};

	const handleTestSubmit = (event: React.FormEvent) => {
		event.preventDefault();
		if (!testEmail) return;
		testMutation.mutate(testEmail);
	};

	const title = t`Email Settings`;
	const description = t`Configure the email provider, view pipeline status, and send test emails`;

	if (isLoading) {
		return (
			<SettingsFrame title={title} description={description}>
				<div
					className="flex items-center gap-2 rounded-xl border border-kumo-line bg-kumo-base px-4 py-4 text-sm text-kumo-subtle"
					role="status"
				>
					<Loader size="sm" />
					<span>{t`Loading...`}</span>
				</div>
			</SettingsFrame>
		);
	}

	if (fetchError) {
		return (
			<SettingsFrame title={title} description={description}>
				<Banner
					variant="error"
					title={t`Failed to load email settings`}
					description={getMutationError(fetchError) || t`Failed to load email settings`}
					role="alert"
				/>
			</SettingsFrame>
		);
	}

	const hasCloudflareProvider = settings?.providers.some(
		(p) => p.pluginId === "emdash-cloudflare-email",
	);

	return (
		<SettingsFrame title={title} description={description}>
			<div className="grid gap-8">
				<SettingsSection
					title={t`Email Provider`}
					description={t`Select and configure the provider that delivers all outgoing email.`}
				>
					<SettingRow>
						<div className="grid gap-4">
							<Select
								label={t`Provider`}
								value={provider}
								onValueChange={(value) => setProvider(value as EmailProviderChoice)}
								items={PROVIDER_OPTIONS.map((opt) => ({
									value: opt.value,
									label: t(opt.label),
									disabled: opt.value === "cloudflare" && !hasCloudflareProvider,
								}))}
							/>

							{provider === "smtp" && (
								<div className="grid gap-4">
									<div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
										<Input
											label={t`SMTP Host`}
											value={smtpHost}
											onChange={(event) => setSmtpHost(event.target.value)}
											placeholder="smtp-relay.brevo.com"
											required
										/>
										<Input
											label={t`Port`}
											type="number"
											value={smtpPort}
											onChange={(event) => {
												setSmtpPort(event.target.value);
												if (!smtpSecureTouched) {
													const port = Number.parseInt(event.target.value, 10);
													if (port === 465) setSmtpSecure("tls");
													else if (port === 587) setSmtpSecure("starttls");
												}
											}}
											placeholder="465"
											required
										/>
										<Select
											label={t`Security`}
											value={smtpSecure}
											onValueChange={(value) => {
												setSmtpSecureTouched(true);
												setSmtpSecure(value as "starttls" | "tls");
											}}
											items={[
												{ value: "starttls", label: t`STARTTLS (port 587)` },
												{ value: "tls", label: t`Implicit TLS (port 465)` },
											]}
										/>
										<Input
											label={t`Username`}
											value={smtpUser}
											onChange={(event) => setSmtpUser(event.target.value)}
											placeholder="you@example.com"
											required
										/>
										<Input
											label={t`Password`}
											type="password"
											value={smtpPass}
											onChange={(event) => setSmtpPass(event.target.value)}
											placeholder={
												settings?.smtp.configured && settings.smtp.source === "db"
													? t`Leave empty to keep current password`
													: t`Enter SMTP password`
											}
										/>
										<Input
											label={t`Sender name (optional)`}
											value={smtpFromName}
											onChange={(event) => setSmtpFromName(event.target.value)}
											placeholder={t`Site Name`}
										/>
										<Input
											label={t`Sender email (optional)`}
											type="email"
											value={smtpFromEmail}
											onChange={(event) => setSmtpFromEmail(event.target.value)}
											placeholder="noreply@example.com"
										/>
										<Input
											label={t`Reply-to email (optional)`}
											type="email"
											value={smtpReplyTo}
											onChange={(event) => setSmtpReplyTo(event.target.value)}
											placeholder="support@example.com"
										/>
									</div>
									<p className="text-sm leading-5 text-kumo-subtle">
										{t`465 (implicit TLS) is recommended on Cloudflare Workers. 587 (STARTTLS) works on Node but is unreliable on Workers.`}
									</p>
									<p className="text-xs text-kumo-subtle">
										{t`SMTP credentials are encrypted and stored in the database. The password field is write-only — leave it empty to keep the current password.`}
									</p>
								</div>
							)}

							{provider === "cloudflare" && (
								<div className="grid gap-4">
									<div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
										<Input
											label={t`Sender name`}
											value={cfFromName}
											onChange={(event) => setCfFromName(event.target.value)}
											placeholder={t`Jane Doe`}
											required
										/>
										<Input
											label={t`Sender email`}
											type="email"
											value={cfFromEmail}
											onChange={(event) => setCfFromEmail(event.target.value)}
											placeholder="noreply@example.com"
											required
										/>
										<Input
											label={t`Reply-to email (optional)`}
											type="email"
											value={cfReplyTo}
											onChange={(event) => setCfReplyTo(event.target.value)}
											placeholder="support@example.com"
										/>
									</div>
									<p className="text-xs text-kumo-subtle">
										{t`Cloudflare Email uses the native send_email binding. Add the EMAIL binding to wrangler.jsonc. The sender must be a verified address on your Cloudflare account.`}
									</p>
								</div>
							)}

							<div className="flex flex-wrap items-center gap-3">
								<Button
									onClick={handleSave}
									loading={saveMutation.isPending}
									disabled={saveMutation.isPending}
								>
									{saveMutation.isPending ? t`Saving...` : t`Save Settings`}
								</Button>
								{provider === "cloudflare" && (
									<Button
										variant="secondary"
										onClick={() => bindingMutation.mutate()}
										loading={bindingMutation.isPending}
										disabled={bindingMutation.isPending}
									>
										{bindingMutation.isPending ? t`Testing...` : t`Test Binding`}
									</Button>
								)}
							</div>
						</div>
					</SettingRow>
				</SettingsSection>

				<SettingsSection title={t`Email Pipeline`}>
					<PipelineStatus settings={settings} />
				</SettingsSection>

				{settings?.smtp.configured && settings.selectedProviderId === "emdash-smtp" && (
					<SettingsSection title={t`SMTP Transport`}>
						<SettingRow>
							<div className="grid gap-3">
								<div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
									<div className="grid gap-1">
										<p className="text-sm font-medium text-kumo-subtle">{t`Host`}</p>
										<p className="font-mono text-sm break-all">{settings.smtp.host}</p>
									</div>
									<div className="grid gap-1">
										<p className="text-sm font-medium text-kumo-subtle">{t`Port`}</p>
										<p className="font-mono text-sm">{settings.smtp.port}</p>
									</div>
									<div className="grid gap-1">
										<p className="text-sm font-medium text-kumo-subtle">{t`Security`}</p>
										<p className="font-mono text-sm">
											{settings.smtp.secure === "tls" ? t`Implicit TLS` : t`STARTTLS`}
										</p>
									</div>
									{settings.smtp.fromEmail && (
										<div className="grid gap-1">
											<p className="text-sm font-medium text-kumo-subtle">{t`Sender email`}</p>
											<p className="font-mono text-sm break-all">
												{settings.smtp.fromName
													? `${settings.smtp.fromName} <${settings.smtp.fromEmail}>`
													: settings.smtp.fromEmail}
											</p>
										</div>
									)}
									{settings.smtp.replyTo && (
										<div className="grid gap-1">
											<p className="text-sm font-medium text-kumo-subtle">{t`Reply-to`}</p>
											<p className="font-mono text-sm break-all">{settings.smtp.replyTo}</p>
										</div>
									)}
								</div>
								<p className="text-xs text-kumo-subtle">
									{settings.smtp.source === "db"
										? t`SMTP is configured in the admin UI. Credentials are encrypted in the database.`
										: t`SMTP is configured via environment variables on the server.`}
								</p>
							</div>
						</SettingRow>
					</SettingsSection>
				)}

				{settings?.available && (
					<SettingsSection
						title={t`Send Test Email`}
						description={t`Send a test email through the full pipeline to verify your email configuration.`}
					>
						<SettingRow>
							<form
								onSubmit={handleTestSubmit}
								className="flex flex-col gap-4 sm:flex-row sm:items-end"
							>
								<div className="min-w-0 flex-1">
									<Input
										label={t`Recipient email`}
										type="email"
										value={testEmail}
										onChange={(event) => setTestEmail(event.target.value)}
										placeholder={t`test@example.com`}
										required
									/>
								</div>
								<Button
									type="submit"
									icon={<PaperPlaneTilt />}
									loading={testMutation.isPending}
									disabled={testMutation.isPending || !testEmail}
									className="w-full self-end sm:w-auto"
								>
									{testMutation.isPending ? t`Sending...` : t`Send Test`}
								</Button>
							</form>
						</SettingRow>
					</SettingsSection>
				)}
			</div>
		</SettingsFrame>
	);
}

function PipelineStatus({ settings }: { settings: EmailSettingsData | undefined }) {
	const { t } = useLingui();

	if (!settings) return null;

	if (!settings.available) {
		return (
			<SettingRow>
				<Banner
					variant="alert"
					icon={<WarningCircle />}
					title={t`No email provider configured`}
					description={
						<div className="grid gap-1.5">
							<p>{t`Install and activate an email provider plugin to enable email features like invitations, magic links, and password recovery.`}</p>
							<p>{t`Without an email provider, invite links must be shared manually.`}</p>
						</div>
					}
					role="status"
				/>
			</SettingRow>
		);
	}

	return (
		<>
			<SettingRow>
				<div className="flex items-start gap-3">
					<span className="flex h-5 shrink-0 items-center text-kumo-success" aria-hidden="true">
						<CheckCircle className="h-5 w-5" />
					</span>
					<div className="min-w-0 grid gap-1">
						<p className="text-sm font-medium">{t`Email provider active`}</p>
						<p className="text-sm leading-5 text-kumo-subtle">
							{t`Provider:`}{" "}
							<code className="rounded bg-kumo-tint px-1.5 py-0.5 text-[0.9em] break-all">
								{settings.selectedProviderId || t`Unknown`}
							</code>
						</p>
					</div>
				</div>
			</SettingRow>

			{(settings.middleware.beforeSend.length > 0 || settings.middleware.afterSend.length > 0) && (
				<SettingRow>
					<div className="flex items-start gap-3">
						<span className="flex h-5 shrink-0 items-center text-kumo-subtle" aria-hidden="true">
							<PlugsConnected className="h-5 w-5" />
						</span>
						<div className="min-w-0 grid gap-1">
							<p className="text-sm font-medium">{t`Email Middleware`}</p>
							{settings.middleware.beforeSend.length > 0 && (
								<p className="text-sm leading-5 text-kumo-subtle break-words">
									{t`Before send:`} {settings.middleware.beforeSend.join(", ")}
								</p>
							)}
							{settings.middleware.afterSend.length > 0 && (
								<p className="text-sm leading-5 text-kumo-subtle break-words">
									{t`After send:`} {settings.middleware.afterSend.join(", ")}
								</p>
							)}
						</div>
					</div>
				</SettingRow>
			)}

			{settings.providers.length > 1 && (
				<SettingRow>
					<div className="grid gap-1">
						<p className="text-sm font-medium">{t`Available Providers`}</p>
						<p className="text-sm leading-5 text-kumo-subtle break-words">
							{settings.providers.map((provider) => provider.pluginId).join(", ")}
						</p>
					</div>
				</SettingRow>
			)}
		</>
	);
}
