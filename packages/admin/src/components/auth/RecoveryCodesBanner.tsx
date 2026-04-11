import { Button } from "@cloudflare/kumo";
import { Trans, useLingui } from "@lingui/react/macro";
import * as React from "react";

import { REMAINING_RECOVERY_CODES_KEY } from "./TotpLoginForm";

/**
 * Shown when the user just logged in with a TOTP recovery code.
 * The login handler stashes the remaining-count in sessionStorage
 * and this banner reads it once on mount. Dismissing clears the
 * key, so the banner is one-shot per recovery-code login.
 */
export function RecoveryCodesBanner() {
	const { t } = useLingui();
	const [remaining, setRemaining] = React.useState<number | null>(null);

	React.useEffect(() => {
		try {
			const raw = window.sessionStorage.getItem(REMAINING_RECOVERY_CODES_KEY);
			if (raw === null) return;
			const parsed = Number(raw);
			if (Number.isFinite(parsed)) setRemaining(parsed);
		} catch {
			/* sessionStorage unavailable — skip */
		}
	}, []);

	if (remaining === null) return null;

	const dismiss = () => {
		try {
			window.sessionStorage.removeItem(REMAINING_RECOVERY_CODES_KEY);
		} catch {
			/* noop */
		}
		setRemaining(null);
	};

	const urgent = remaining <= 3;

	return (
		<div
			role="status"
			className={`flex items-start justify-between gap-4 border-b px-6 py-3 text-sm ${
				urgent
					? "border-kumo-danger/30 bg-kumo-danger/10 text-kumo-default"
					: "border-kumo-warning/30 bg-kumo-warning/10 text-kumo-default"
			}`}
		>
			<div className="flex-1">
				<p className="font-medium">
					{urgent
						? t`You're running low on recovery codes.`
						: t`You just used a recovery code.`}
				</p>
				<p className="mt-0.5 text-kumo-subtle">
					<Trans>
						You have <strong>{remaining}</strong>{" "}
						{remaining === 1 ? "recovery code" : "recovery codes"} left. Set up a new authenticator
						or regenerate your codes from your account settings.
					</Trans>
				</p>
			</div>
			<Button variant="ghost" size="sm" onClick={dismiss} aria-label={t`Dismiss`}>
				{t`Dismiss`}
			</Button>
		</div>
	);
}
