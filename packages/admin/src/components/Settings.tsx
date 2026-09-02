import { Combobox, inputVariants } from "@cloudflare/kumo";
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
	CaretDown,
	Images,
} from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import * as React from "react";

import { fetchManifest } from "../lib/api";
import { useCurrentUser } from "../lib/api/current-user.js";
import { SUPPORTED_LOCALES } from "../locales/index.js";
import { useLocale } from "../locales/useLocale.js";
import { SettingsNavRow, SettingsSection } from "./settings/SettingsLayout.js";

/**
 * Settings hub page — links to all settings sub-pages.
 */
export function Settings() {
	const { data: currentUser } = useCurrentUser();
	const { data: manifest } = useQuery({
		queryKey: ["manifest"],
		queryFn: fetchManifest,
	});

	const { t } = useLingui();
	const { locale, setLocale } = useLocale();
	const showSecuritySettings = manifest?.authMode === "passkey";
	const showMediaUsageSettings = (currentUser?.role ?? 0) >= 50;
	const selectedLocale = SUPPORTED_LOCALES.find((option) => option.code === locale) ?? null;

	return (
		<div className="max-w-4xl pb-6">
			<header>
				<h1 className="text-2xl font-semibold leading-tight text-balance">{t`Settings`}</h1>
			</header>

			<div className="mt-6 grid gap-8">
				<SettingsSection title={t`Site`}>
					<SettingsNavRow
						to="/settings/general"
						icon={<Gear className="h-5 w-5" />}
						title={t`General`}
						description={t`Site identity, logo, favicon, and reading preferences`}
					/>
					<SettingsNavRow
						to="/settings/social"
						icon={<ShareNetwork className="h-5 w-5" />}
						title={t`Social Links`}
						description={t`Social media profile links`}
					/>
					<SettingsNavRow
						to="/settings/seo"
						icon={<MagnifyingGlass className="h-5 w-5" />}
						title={t`SEO`}
						description={t`Search engine optimization and verification`}
					/>
				</SettingsSection>

				{showMediaUsageSettings ? (
					<SettingsSection title={t`Media`}>
						<SettingsNavRow
							to="/settings/media-usage"
							icon={<Images className="h-5 w-5" />}
							title={t`Media usage tracking`}
							description={t`Track where media is used across your content`}
						/>
					</SettingsSection>
				) : null}

				{showSecuritySettings && (
					<SettingsSection title={t`Security Settings`}>
						<SettingsNavRow
							to="/settings/security"
							icon={<Shield className="h-5 w-5" />}
							title={t`Security`}
							description={t`Manage your passkeys and authentication`}
						/>
						<SettingsNavRow
							to="/settings/allowed-domains"
							icon={<Globe className="h-5 w-5" />}
							title={t`Self-Signup Domains`}
							description={t`Allow users from specific domains to sign up`}
						/>
					</SettingsSection>
				)}

				<SettingsSection title={t`API Tokens`}>
					<SettingsNavRow
						to="/settings/api-tokens"
						icon={<Key className="h-5 w-5" />}
						title={t`API Tokens`}
						description={t`Create personal access tokens for programmatic API access`}
					/>
				</SettingsSection>

				<SettingsSection title={t`Email Settings`}>
					<SettingsNavRow
						to="/settings/email"
						icon={<Envelope className="h-5 w-5" />}
						title={t`Email`}
						description={t`View email provider status and send test emails`}
					/>
					<SettingsNavRow
						to="/settings/backups"
						icon={<DownloadSimple className="h-5 w-5" />}
						title={t`Backups`}
						description={t`Download backups and schedule automatic backups to storage`}
					/>
				</SettingsSection>

				{SUPPORTED_LOCALES.length > 1 && (
					<SettingsSection title={t`Language`}>
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
										{t`Choose your preferred admin language`}
									</p>
								</div>
							</div>
							<Combobox
								items={SUPPORTED_LOCALES}
								value={selectedLocale}
								isItemEqualToValue={(option, value) => option.code === value.code}
								itemToStringValue={(option) => option.label}
								onValueChange={(option) => option && setLocale(option.code)}
							>
								<Combobox.Trigger
									aria-label={t`Language`}
									className={`${inputVariants()} relative flex w-full items-center pe-8 text-start sm:w-48`}
								>
									<Combobox.Value>{(option) => option?.label ?? t`Select`}</Combobox.Value>
									<Combobox.Icon className="absolute end-2 top-1/2 flex -translate-y-1/2 items-center text-kumo-subtle">
										<CaretDown className="h-4 w-4" aria-hidden="true" />
									</Combobox.Icon>
								</Combobox.Trigger>
								<Combobox.Content>
									<Combobox.Input aria-label={t`Search`} placeholder={t`Search`} />
									<Combobox.Empty>{t`No results found`}</Combobox.Empty>
									<Combobox.List style={{ maxHeight: "16.5rem" }}>
										{(option) => (
											<Combobox.Item key={option.code} value={option}>
												{option.label}
											</Combobox.Item>
										)}
									</Combobox.List>
								</Combobox.Content>
							</Combobox>
						</div>
					</SettingsSection>
				)}
			</div>
		</div>
	);
}

export default Settings;
