import { Banner, Button } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";

/** Shown once the tab has left its room for good. The edits stay in the form for copying. */
export function KeptNotice({ onReload }: { onReload: () => void }) {
	const { t } = useLingui();
	return (
		<Banner
			variant="alert"
			role="alert"
			title={t`These edits can no longer be saved`}
			description={t`Copy anything you need from this page, then reload to get the latest version.`}
			action={
				<Button size="sm" variant="secondary" type="button" onClick={onReload}>
					{t`Reload`}
				</Button>
			}
		/>
	);
}
