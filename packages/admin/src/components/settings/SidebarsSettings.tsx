import { useLingui } from "@lingui/react/macro";

import { SettingsFrame } from "./SettingsLayout";

export type SidebarsSettingsTab = "navigation" | "editor";

interface SidebarsSettingsProps {
	tab: SidebarsSettingsTab;
}

export function SidebarsSettings({ tab }: SidebarsSettingsProps) {
	const { t } = useLingui();
	return (
		<SettingsFrame
			title={t`Sidebars`}
			description={t`Choose what the navigation and the editor sidebar show, and in what order.`}
		>
			<div data-tab={tab} />
		</SettingsFrame>
	);
}
