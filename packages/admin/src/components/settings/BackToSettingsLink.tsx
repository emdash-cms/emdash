import { useLingui } from "@lingui/react/macro";

import { ArrowPrev } from "../ArrowIcons.js";
import { RouterLinkButton } from "../RouterLinkButton.js";

/**
 * Shared "Back to settings" link, used in the header of each settings sub-page.
 *
 * Renders as a single anchor element styled as a Kumo ghost square button.
 * Routes through TanStack Router (client-side navigation, no full page reload).
 */
export function BackToSettingsLink() {
	const { t } = useLingui();
	return (
		<RouterLinkButton
			to="/settings"
			variant="ghost"
			shape="square"
			aria-label={t`Back to settings`}
			icon={<ArrowPrev />}
		/>
	);
}
