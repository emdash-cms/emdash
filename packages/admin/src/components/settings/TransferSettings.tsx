/**
 * Site transfer settings page
 *
 * Export this site as a portable `.emdash` package, import a package into an
 * empty site, and decide MCP approval requests for either.
 */

import { Banner, Loader } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import { useQuery } from "@tanstack/react-query";
import * as React from "react";

import { useCurrentUser } from "../../lib/api/current-user.js";
import {
	fetchTransferCapabilities,
	TRANSFER_CAPABILITIES_QUERY_KEY,
} from "../../lib/api/transfer.js";
import { getMutationError } from "../DialogError.js";
import { SettingRow, SettingsFrame, SettingsSection } from "./SettingsLayout.js";
import { ApprovalsSection } from "./transfer/ApprovalsSection.js";
import { ExportSection } from "./transfer/ExportSection.js";
import { ImportSection } from "./transfer/ImportSection.js";

const ROLE_ADMIN = 50;

export function TransferSettings({ focusImport = false }: { focusImport?: boolean }) {
	const { t } = useLingui();
	const importRef = React.useRef<HTMLDivElement>(null);
	const { data: currentUser, isLoading: userLoading } = useCurrentUser();
	const isAdmin = !!currentUser && currentUser.role >= ROLE_ADMIN;
	const capabilitiesQuery = useQuery({
		queryKey: TRANSFER_CAPABILITIES_QUERY_KEY,
		queryFn: fetchTransferCapabilities,
		enabled: isAdmin,
	});

	const ready = isAdmin && !!capabilitiesQuery.data;
	React.useEffect(() => {
		if (!focusImport || !ready) return;
		const target = importRef.current;
		if (!target) return;
		target.scrollIntoView({ block: "start" });
		target.focus({ preventScroll: true });
	}, [focusImport, ready]);

	const title = t`Transfer`;
	const description = t`Move this site to another EmDash installation, or import a site package into this one.`;

	if (userLoading || (isAdmin && capabilitiesQuery.isPending)) {
		return (
			<SettingsFrame title={title} description={description}>
				<div
					className="flex items-center gap-2 rounded-xl border border-kumo-line bg-kumo-base px-4 py-4 text-sm text-kumo-subtle"
					role="status"
				>
					<Loader size="sm" />
					<span>{t`Loading...`}</span>
				</div>
			</SettingsFrame>
		);
	}

	if (!isAdmin) {
		return (
			<SettingsFrame title={title} description={description}>
				<Banner
					variant="error"
					role="alert"
					title={t`Access denied`}
					description={t`You need Admin permissions to transfer this site.`}
				/>
			</SettingsFrame>
		);
	}

	if (capabilitiesQuery.error || !capabilitiesQuery.data) {
		return (
			<SettingsFrame title={title} description={description}>
				<SettingsSection title={t`Transfer`}>
					<SettingRow>
						<Banner
							variant="error"
							role="alert"
							title={t`Failed to load transfer settings`}
							description={getMutationError(capabilitiesQuery.error) || t`An error occurred`}
						/>
					</SettingRow>
				</SettingsSection>
			</SettingsFrame>
		);
	}

	return (
		<SettingsFrame title={title} description={description}>
			<div className="grid gap-8">
				<ExportSection />
				<div ref={importRef} tabIndex={-1} className="scroll-mt-6 outline-none">
					<ImportSection capabilities={capabilitiesQuery.data} />
				</div>
				<ApprovalsSection />
			</div>
		</SettingsFrame>
	);
}
