import { Banner, Button, LinkButton } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import { ArrowCircleUp } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { fetchCoreUpdateStatus } from "../lib/api/core-update";
import { useCurrentUser } from "../lib/api/current-user";

/** Matches Role.ADMIN in @emdash-cms/auth (same constant as Sidebar). */
const ROLE_ADMIN = 50;

const DISMISS_KEY = "emdash:core-update-dismissed";

function readDismissedVersion(): string | null {
	try {
		return localStorage.getItem(DISMISS_KEY);
	} catch {
		return null;
	}
}

/**
 * WordPress-style "a new version is available" notice (Discussion #1889).
 *
 * Shown to admins on the dashboard when the npm registry reports a newer
 * `emdash` version than the one running. Dismissible per version: hiding
 * 0.24 re-arms the banner when 0.25 ships. The admin can't trigger the
 * update itself — an EmDash update is an npm bump + redeploy — so the
 * banner links to the release notes instead.
 */
export function CoreUpdateBanner() {
	const { t } = useLingui();
	const { data: user } = useCurrentUser();
	const isAdmin = (user?.role ?? 0) >= ROLE_ADMIN;

	const { data: status } = useQuery({
		queryKey: ["core-update"],
		queryFn: fetchCoreUpdateStatus,
		enabled: isAdmin,
		staleTime: 60 * 60 * 1000,
		retry: false,
	});

	const [dismissedVersion, setDismissedVersion] = useState(readDismissedVersion);

	if (!isAdmin || !status?.updateAvailable || !status.latest) return null;
	if (dismissedVersion === status.latest) return null;

	const latest = status.latest;
	const dismiss = () => {
		try {
			localStorage.setItem(DISMISS_KEY, latest);
		} catch {
			// Storage unavailable (private mode) — hide for this render only.
		}
		setDismissedVersion(latest);
	};

	return (
		<Banner
			variant="default"
			icon={<ArrowCircleUp />}
			title={t`EmDash ${latest} is available (you're running ${status.current})`}
			description={t`Update the emdash package in your project and redeploy to get the latest fixes.`}
			action={
				<div className="flex items-center gap-2">
					<LinkButton
						size="sm"
						href="https://github.com/emdash-cms/emdash/releases"
						external
					>{t`Release notes`}</LinkButton>
					<Button size="sm" variant="ghost" onClick={dismiss}>{t`Dismiss`}</Button>
				</div>
			}
		/>
	);
}
