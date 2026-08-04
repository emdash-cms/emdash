import { Select } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import {
	Gear,
	ShareNetwork,
	MagnifyingGlass,
	Shield,
	Globe,
	GlobeSimple,
	Key,
	Envelope,
	DownloadSimple,
} from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import * as React from "react";

import { fetchManifest } from "../lib/api";
import { SUPPORTED_LOCALES } from "../locales/index.js";
import { useLocale } from "../locales/useLocale.js";
import { SettingsNavRow, SettingsSection } from "./settings/SettingsLayout.js";

/**
 * Settings hub page — links to all settings sub-pages.
 */
export function Settings() {
	const { data: manifest } = useQuery({
		queryKey: ["manifest"],
		queryFn: fetchManifest,
	});

	const { t } = useLingui();
	const { locale, setLocale } = useLocale();
	const showSecuritySettings = manifest?.authMode === "passkey";

	return (
		<div className="max-w-4xl pb-6">
			<header>
				<h1 className="text-2xl font-semibold leading-tight text-balance">{t`Settings`}</h1>
				<p className="mt-1.5 max-w-2xl text-base leading-5 text-pretty text-kumo-subtle">
					{t`Configure your site, access, integrations, and admin preferences.`}
				</p>
			</header>

			<div className="mt-6 grid gap-8">
				<SettingsSection title={t`Site`}>
					<SettingsNavRow
						to="/settings/general"
						icon={<Gear className="h-5 w-5" />}
						title={t`General`}
						description={t`Set your site name, logo, favicon, and reading defaults.`}
					/>
					<SettingsNavRow
						to="/settings/social"
						icon={<ShareNetwork className="h-5 w-5" />}
						title={t`Social links`}
						description={t`Add links to your social profiles.`}
					/>
					<SettingsNavRow
						to="/settings/seo"
						icon={<MagnifyingGlass className="h-5 w-5" />}
						title={t`SEO`}
						description={t`Control search appearance, social sharing, and site verification.`}
					/>
				</SettingsSection>

				{showSecuritySettings && (
					<SettingsSection title={t`Security and access`}>
						<SettingsNavRow
							to="/settings/security"
							icon={<Shield className="h-5 w-5" />}
							title={t`Security`}
							description={t`Manage passkeys and sign-in settings.`}
						/>
						<SettingsNavRow
							to="/settings/allowed-domains"
							icon={<Globe className="h-5 w-5" />}
							title={t`Self-signup domains`}
							description={t`Choose which email domains can create accounts.`}
						/>
					</SettingsSection>
				)}

				<SettingsSection title={t`Developer tools`}>
					<SettingsNavRow
						to="/settings/api-tokens"
						icon={<Key className="h-5 w-5" />}
						title={t`API tokens`}
						description={t`Create and revoke tokens for API access.`}
					/>
				</SettingsSection>

				<SettingsSection title={t`Email and backups`}>
					<SettingsNavRow
						to="/settings/email"
						icon={<Envelope className="h-5 w-5" />}
						title={t`Email`}
						description={t`Check email delivery and send a test message.`}
					/>
					<SettingsNavRow
						to="/settings/backups"
						icon={<DownloadSimple className="h-5 w-5" />}
						title={t`Backups`}
						description={t`Download, schedule, restore, and manage backups.`}
					/>
				</SettingsSection>

				{SUPPORTED_LOCALES.length > 1 && (
					<SettingsSection title={t`Preferences`}>
						<div className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
							<div className="flex min-w-0 items-center gap-3">
								<span
									className="flex h-5 w-5 shrink-0 items-center justify-center text-kumo-subtle"
									aria-hidden="true"
								>
									<GlobeSimple className="h-5 w-5" />
								</span>
								<div className="min-w-0">
									<p className="text-base font-medium leading-5">{t`Language`}</p>
									<p className="mt-0.5 text-sm leading-5 text-pretty text-kumo-subtle">
										{t`Choose the language used in the admin.`}
									</p>
								</div>
							</div>
							<Select
								aria-label={t`Language`}
								className="w-full sm:w-48"
								value={locale}
								onValueChange={(v) => v && setLocale(v)}
								items={Object.fromEntries(SUPPORTED_LOCALES.map((l) => [l.code, l.label]))}
							/>
						</div>
					</SettingsSection>
				)}
			</div>
		</div>
	);
}

export default Settings;
