import { Trans } from "@lingui/react/macro";

export function InsecurePasskeyContextMessage() {
	return (
		<Trans>
			Passkeys require a <strong className="text-kumo-default">secure context</strong>: use{" "}
			<strong className="text-kumo-default">HTTPS</strong>, or open the admin at{" "}
			<strong className="text-kumo-default">http://localhost</strong> (with your dev port). Plain{" "}
			<code className="text-xs">http://</code> on a custom hostname is not treated as secure, even
			on loopback.
		</Trans>
	);
}
