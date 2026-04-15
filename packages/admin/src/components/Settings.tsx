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
	CaretRight,
} from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import * as React from "react";

import { fetchManifest } from "../lib/api";
import { SUPPORTED_LOCALES } from "../locales/index.js";
import { useLocale } from "../locales/useLocale.js";

interface SettingsLinkProps {
	to: string;
	icon: React.ReactNode;
	title: string;
	description: string;
}

function SettingsLink({ to, icon, title, description }: SettingsLinkProps) {
	return (
		<Link
			to={to}
			className="flex items-center justify-between p-4 rounded-lg border bg-kumo-base hover:bg-kumo-tint transition-colors"
		>
			<div className="flex items-center gap-3">
				<div className="text-kumo-subtle">{icon}</div>
				<div>
					<div className="font-medium">{title}</div>
					<div className="text-sm text-kumo-subtle">{description}</div>
				</div>
			</div>
			<CaretRight className="h-5 w-5 text-kumo-subtle" />
		</Link>
	);
}

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
		<div className="space-y-6">
			<h1 className="text-2xl font-bold">{t`Settings`}</h1>

			{/* Site settings */}
			<div className="space-y-2">
				<SettingsLink
					to="/settings/general"
					icon={<Gear className="h-5 w-5" />}
					title={t`General`}
					description={t`Site identity, logo, favicon, and reading preferences`}
				/>
				<SettingsLink
					to="/settings/social"
					icon={<ShareNetwork className="h-5 w-5" />}
					title={t`Social Links`}
					description={t`Social media profile links`}
				/>
				<SettingsLink
					to="/settings/seo"
					icon={<MagnifyingGlass className="h-5 w-5" />}
					title={t`SEO`}
					description={t`Search engine optimization and verification`}
				/>
			</div>

			{/* Security & access — only for passkey auth */}
			{showSecuritySettings && (
				<div className="space-y-2">
					<SettingsLink
						to="/settings/security"
						icon={<Shield className="h-5 w-5" />}
						title={t`Security`}
						description={t`Manage your passkeys and authentication`}
					/>
					<SettingsLink
						to="/settings/allowed-domains"
						icon={<Globe className="h-5 w-5" />}
						title={t`Self-Signup Domains`}
						description={t`Allow users from specific domains to sign up`}
					/>
				</div>
			)}

			{/* Always visible for admins */}
			<div className="space-y-2">
				<SettingsLink
					to="/settings/api-tokens"
					icon={<Key className="h-5 w-5" />}
					title={t`API Tokens`}
					description={t`Create personal access tokens for programmatic API access`}
				/>
				<SettingsLink
					to="/settings/email"
					icon={<Envelope className="h-5 w-5" />}
					title={t`Email`}
					description={t`View email provider status and send test emails`}
				/>
			</div>

			{/* Language */}
			{SUPPORTED_LOCALES.length > 1 && (
				<div className="space-y-2">
					<div className="flex items-center justify-between p-4 rounded-lg border bg-kumo-base">
						<div className="flex items-center gap-3">
							<div className="text-kumo-subtle">
								<GlobeSimple className="h-5 w-5" />
							</div>
							<div>
								<div className="font-medium">{t`Language`}</div>
								<div className="text-sm text-kumo-subtle">{t`Choose your preferred admin language`}</div>
							</div>
						</div>
						<Select
							aria-label={t`Language`}
							className="w-45"
							value={locale}
							onValueChange={(v) => v && setLocale(v)}
							items={Object.fromEntries(SUPPORTED_LOCALES.map((l) => [l.code, l.label]))}
						/>
					</div>
				</div>
			)}
		</div>
	);
}

export default Settings;
