import { Badge } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";

import { Sidebar } from "./Sidebar.js";

/**
 * Console header with the sidebar toggle. Operator identity (W9.1) and
 * session actions land with the auth PR — this scaffold has no user menu.
 */
export function Header() {
	const { t } = useLingui();
	return (
		<header className="sticky top-0 z-10 flex h-[58px] items-center justify-between border-b bg-kumo-elevated px-4">
			<Sidebar.Trigger className="cursor-pointer rtl:rotate-180" />
			<Badge variant="outline">{t`Fixture data`}</Badge>
		</header>
	);
}
