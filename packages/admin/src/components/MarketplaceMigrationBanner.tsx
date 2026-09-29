import { Banner, LinkButton } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";

export const MARKETPLACE_MIGRATION_GUIDE_URL =
	"https://docs.emdashcms.com/plugins/migrate-from-marketplace/";

export function MarketplaceMigrationBanner() {
	const { t } = useLingui();

	return (
		<Banner
			variant="alert"
			role="status"
			title={t`Marketplace configuration is deprecated`}
			description={t`New plugin discovery uses the registry. Existing marketplace plugins can still be updated or uninstalled while you switch over.`}
			action={
				<LinkButton href={MARKETPLACE_MIGRATION_GUIDE_URL} external variant="secondary" size="sm">
					{t`Migration guide`}
				</LinkButton>
			}
		/>
	);
}
