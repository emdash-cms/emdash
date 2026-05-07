import { buttonVariants } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import { Link } from "@tanstack/react-router";

import { ArrowPrev } from "../ArrowIcons.js";

/**
 * Shared "Back to settings" link, used in the header of each settings sub-page.
 *
 * Renders as a single anchor element styled as a Kumo ghost square button.
 * Avoids the invalid `<a><button>` HTML produced by `<Link><Button>`.
 */
export function BackToSettingsLink() {
	const { t } = useLingui();
	return (
		<Link
			to="/settings"
			aria-label={t`Back to settings`}
			className={buttonVariants({ variant: "ghost", shape: "square" })}
		>
			<ArrowPrev className="h-4 w-4" />
		</Link>
	);
}
