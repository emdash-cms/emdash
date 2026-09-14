import { Banner } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";

import type { AdminManifest } from "../lib/api/client.js";

type RegistryConfigurationError = NonNullable<AdminManifest["registryConfigurationError"]>;

export function RegistryConfigurationBanner({ error }: { error: RegistryConfigurationError }) {
	const { t } = useLingui();
	let description: string;

	switch (error.field) {
		case "experimental.registry.aggregatorUrl":
			description = t`Check experimental.registry.aggregatorUrl in astro.config.mjs, then restart EmDash.`;
			break;
		case "experimental.registry.policy.minimumReleaseAge":
			description = t`Check experimental.registry.policy.minimumReleaseAge in astro.config.mjs, then restart EmDash.`;
			break;
		case "experimental.registry.policy.minimumReleaseAgeExclude":
			description = t`Check experimental.registry.policy.minimumReleaseAgeExclude in astro.config.mjs, then restart EmDash.`;
			break;
		default:
			description = t`Check experimental.registry in astro.config.mjs, then restart EmDash.`;
	}

	return (
		<Banner
			variant="error"
			role="alert"
			aria-label={t`Plugin registry configuration error`}
			title={t`Plugin registry configuration error`}
			description={description}
		/>
	);
}
