import { Select } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import {
	Gear,
	ShareNetwork,
	MagnifyingGlass,
	Shield,
	Globe,
	Key,
	Envelope,
	DownloadSimple,
} from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";

import { fetchManifest } from "../lib/api";
import { SUPPORTED_LOCALES } from "../locales/index.js";
import { useLocale } from "../locales/useLocale.js";
import { SettingRow, SettingsFrame, SettingsNavRow, SettingsSection } from "./settings/SettingsLayout.js";

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
		<SettingsFrame title={t`Settings`}>
			<div className="space-y-8">
				<SettingsSection title={t`Site`}>
					<div className="space-y-3">
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
					</div>
				</SettingsSection>

				{showSecuritySettings && (
					<SettingsSection title={t`Access`}>
						<div className="space-y-3">
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
						</div>
					</SettingsSection>
				)}

				<SettingsSection title={t`Developer`}>
					<div className="space-y-3">
						<SettingsNavRow
							to="/settings/api-tokens"
							icon={<Key className="h-5 w-5" />}
							title={t`API Tokens`}
							description={t`Create personal access tokens for programmatic API access`}
						/>
					</div>
				</SettingsSection>

				<SettingsSection title={t`Operations`}>
					<div className="space-y-3">
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
					</div>
				</SettingsSection>

				{SUPPORTED_LOCALES.length > 1 && (
					<SettingsSection title={t`Preferences`}>
						<SettingRow
							label={t`Language`}
							description={t`Choose your preferred admin language`}
							control={
								<Select
									aria-label={t`Language`}
									className="w-full sm:w-45"
									value={locale}
									onValueChange={(v) => v && setLocale(v)}
									items={Object.fromEntries(SUPPORTED_LOCALES.map((l) => [l.code, l.label]))}
								/>
							}
						/>
					</SettingsSection>
				)}
			</div>
		</SettingsFrame>
	);
}

export default Settings;
