/**
 * Dynamic Plugins Unavailable
 *
 * Shown in place of the marketplace / registry browse UI when the deployment
 * has no available sandbox runner (`manifest.sandboxAvailable === false`).
 * Rather than let the user browse and hit an error at install time, direct
 * them to the platform-specific setup instructions.
 */

import { LinkButton } from "@cloudflare/kumo";
import { Trans, useLingui } from "@lingui/react/macro";
import { ArrowSquareOut, ShieldWarning } from "@phosphor-icons/react";

/** Docs page covering sandbox runner setup (Cloudflare Worker Loader + Node workerd). */
const INSTALL_DOCS_URL = "https://docs.emdashcms.com/plugins/installing/";

export function DynamicPluginsUnavailable() {
	const { t } = useLingui();

	return (
		<div className="mx-auto max-w-2xl">
			<div className="flex flex-col items-center rounded-lg border bg-kumo-base p-8 text-center">
				<div className="flex h-12 w-12 items-center justify-center rounded-full bg-kumo-warning/10 text-kumo-warning">
					<ShieldWarning className="h-6 w-6" aria-hidden="true" />
				</div>

				<h2 className="mt-4 text-lg font-medium">
					<Trans>Dynamic plugins aren't available on this deployment</Trans>
				</h2>

				<p className="mt-2 text-sm text-kumo-subtle">
					<Trans>
						Installing plugins at runtime requires an available sandbox runner. Configure one for
						your deployment platform and redeploy to enable dynamic plugins.
					</Trans>
				</p>

				<LinkButton
					href={INSTALL_DOCS_URL}
					external
					variant="outline"
					icon={<ArrowSquareOut />}
					className="mt-4"
				>
					{t`Learn how to enable dynamic plugins`}
				</LinkButton>
			</div>
		</div>
	);
}
