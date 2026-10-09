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
	type EmailSettings as EmailSettingsData,
} from "../../lib/api/email-settings.js";
import { getMutationError } from "../DialogError.js";
import { SettingRow, SettingsFrame, SettingsSection } from "./SettingsLayout.js";

const SMTP_PROVIDER_ID = "emdash-builtin-smtp";
const PROVIDER_LABELS: Record<string, MessageDescriptor> = {
	[SMTP_PROVIDER_ID]: msg`SMTP`,
};

export function EmailSettings() {
	const { t } = useLingui();
	const toastManager = useKumoToastManager();
	const queryClient = useQueryClient();
	const [testEmail, setTestEmail] = React.useState("");

	// "smtp", a plugin ID verbatim, or "" while nothing is selected
	const [provider, setProvider] = React.useState("");
	const [smtpHost, setSmtpHost] = React.useState("");
	const [smtpPort, setSmtpPort] = React.useState("587");
	const [smtpSecure, setSmtpSecure] = React.useState<"starttls" | "tls">("starttls");
	const [smtpUser, setSmtpUser] = React.useState("");
	const [smtpPass, setSmtpPass] = React.useState("");
	// Once the user picks a security mode, port changes stop suggesting one.
	const [smtpSecureTouched, setSmtpSecureTouched] = React.useState(false);
	const [smtpFromName, setSmtpFromName] = React.useState("");
	const [smtpFromEmail, setSmtpFromEmail] = React.useState("");
	const [smtpReplyTo, setSmtpReplyTo] = React.useState("");

	const {
		data: settings,
		isLoading,
		error: fetchError,
	} = useQuery({
		queryKey: ["email-settings"],
		queryFn: fetchEmailSettings,
	});

	// Sync form state from fetched settings. Saved SMTP config is prefilled
	// regardless of which provider is selected, so switching back to SMTP
	// does not require retyping.
	React.useEffect(() => {
		if (!settings) return;
		if (settings.selectedProviderId === SMTP_PROVIDER_ID) {
			setProvider("smtp");
		} else {
			setProvider(settings.selectedProviderId ?? "");
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
	}, [settings]);

	const saveMutation = useMutation({
		mutationFn: saveEmailSettings,
		onSuccess: () => {
			toastManager.add({ title: t`Email settings saved`, variant: "success", timeout: 5000 });
			setSmtpPass("");
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
		onSuccess: (_result, to) => {
			toastManager.add({ title: t`Test email sent to ${to}`, variant: "success", timeout: 5000 });
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
			if (port === 25) {
				toastManager.add({
					title: t`Port 25 is not supported`,
					description: t`Use 587 (STARTTLS) or 465 (implicit TLS).`,
					variant: "error",
					timeout: 5000,
				});
				return;
			}
			const env = settings?.smtp.source === "env" ? settings.smtp : undefined;
			const usesEnvConfig =
				env &&
				!smtpPass &&
				smtpHost === env.host &&
				port === env.port &&
				smtpSecure === env.secure &&
				smtpUser === env.user &&
				smtpFromName.trim() === (env.fromName ?? "") &&
				smtpFromEmail.trim() === (env.fromEmail ?? "") &&
				smtpReplyTo.trim() === (env.replyTo ?? "");
			if (usesEnvConfig) {
				saveMutation.mutate({ provider: "smtp" });
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
		} else if (provider) {
			saveMutation.mutate({ provider: "plugin", pluginId: provider });
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

	// Plugin providers (resend, postmark, …) selectable alongside SMTP
	const pluginProviders = (settings?.providers ?? []).filter(
		(p) => p.pluginId !== SMTP_PROVIDER_ID,
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
								onValueChange={(value) => setProvider(value ?? "")}
								items={[
									{ value: "smtp", label: t`SMTP` },
									...pluginProviders.map((p) => ({ value: p.pluginId, label: p.pluginId })),
								]}
							/>

							{provider === "smtp" && (
								<div className="grid gap-4">
									<div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
										<Input
											label={t`SMTP Host`}
											value={smtpHost}
											onChange={(event) => setSmtpHost(event.target.value)}
											placeholder={t`smtp-relay.brevo.com`}
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
											placeholder="587"
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
											placeholder={t`you@example.com`}
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
											placeholder={t`noreply@example.com`}
										/>
										<Input
											label={t`Reply-to email (optional)`}
											type="email"
											value={smtpReplyTo}
											onChange={(event) => setSmtpReplyTo(event.target.value)}
											placeholder={t`support@example.com`}
										/>
									</div>
									<p className="text-xs text-kumo-subtle">
										{settings?.smtp.source === "db"
											? t`The SMTP password is encrypted before it is stored in the database. Leave the password empty to keep the saved one.`
											: t`The SMTP password is encrypted before it is stored in the database.`}
									</p>
								</div>
							)}

							<div className="flex flex-wrap items-center gap-3">
								<Button
									onClick={handleSave}
									loading={saveMutation.isPending}
									disabled={saveMutation.isPending || !provider}
								>
									{saveMutation.isPending ? t`Saving...` : t`Save Settings`}
								</Button>
							</div>
						</div>
					</SettingRow>
				</SettingsSection>

				<SettingsSection title={t`Email Pipeline`}>
					<PipelineStatus settings={settings} />
				</SettingsSection>

				{settings?.smtp.configured && settings.selectedProviderId === SMTP_PROVIDER_ID && (
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
										? t`SMTP is configured in the admin UI. The password is encrypted in the database.`
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
	const providerLabel = (id: string) => {
		const label = PROVIDER_LABELS[id];
		return label ? t(label) : id;
	};

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
							<p>{t`Choose SMTP above or install an email provider plugin to enable email features like invitations, magic links, and password recovery.`}</p>
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
								{settings.selectedProviderId
									? providerLabel(settings.selectedProviderId)
									: t`Unknown`}
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
							{settings.providers.map((provider) => providerLabel(provider.pluginId)).join(", ")}
						</p>
					</div>
				</SettingRow>
			)}
		</>
	);
}
