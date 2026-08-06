/**
 * Dynamic Plugins Unavailable
 *
 * Shown in place of the marketplace / registry browse UI when the deployment
 * has no sandbox runner (`manifest.sandboxAvailable === false`). Dynamic
 * plugins run sandboxed — on Cloudflare that is Worker Loader, a Workers
 * paid-plan feature — so a free-tier site with `worker_loaders` absent can't
 * install them. Rather than let the user browse and hit a 503 at install time,
 * we explain what's needed and how to enable it.
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
						Installing plugins at runtime runs them in a sandbox. On Cloudflare that uses Worker
						Loader, which needs the Workers paid plan. Add the binding below to your{" "}
						<code className="rounded bg-kumo-tint px-1 py-0.5 font-mono text-xs">
							wrangler.jsonc
						</code>{" "}
						and redeploy to enable it.
					</Trans>
				</p>

				<pre
					dir="ltr"
					className="mt-4 w-full overflow-x-auto rounded bg-kumo-tint p-3 text-start font-mono text-xs"
				>
					<code>{`"worker_loaders": [{ "binding": "LOADER" }]`}</code>
				</pre>

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
