/**
 * Email settings page
 *
 * Shows current email pipeline status, provider info, and allows
 * sending a test email through the full pipeline.
 */

import { Banner, Button, Input, Loader, useKumoToastManager } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import { CheckCircle, PaperPlaneTilt, PlugsConnected, WarningCircle } from "@phosphor-icons/react";
import { useMutation, useQuery } from "@tanstack/react-query";
import * as React from "react";

import {
	fetchEmailSettings,
	sendTestEmail,
	type EmailSettings as EmailSettingsData,
} from "../../lib/api/email-settings.js";
import { getMutationError } from "../DialogError.js";
import { SettingRow, SettingsFrame, SettingsSection } from "./SettingsLayout.js";

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

	const handleTestSubmit = (event: React.FormEvent) => {
		event.preventDefault();
		if (!testEmail) return;
		testMutation.mutate(testEmail);
	};

	const title = t`Email Settings`;
	const description = t`View email provider status and send test emails`;

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

	return (
		<SettingsFrame title={title} description={description}>
			<div className="grid gap-8">
				<SettingsSection title={t`Email Pipeline`}>
					<PipelineStatus settings={settings} />
				</SettingsSection>

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
