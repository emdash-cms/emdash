import { Banner, Button, Loader } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import * as React from "react";

import {
	decideTransferApproval,
	fetchTransferApprovals,
	TRANSFER_APPROVALS_QUERY_KEY,
	type TransferApproval,
} from "../../../lib/api/transfer.js";
import { ConfirmDialog } from "../../ConfirmDialog.js";
import { getMutationError } from "../../DialogError.js";
import { SettingRow, SettingsSection } from "../SettingsLayout.js";
import { shortDigest } from "./labels.js";
import { useTransferUsers } from "./useTransferUsers.js";

const APPROVALS_REFRESH_MS = 30_000;

export function ApprovalsSection() {
	const { t, i18n } = useLingui();
	const queryClient = useQueryClient();
	const [approving, setApproving] = React.useState<TransferApproval | null>(null);
	const approvalsQuery = useInfiniteQuery({
		queryKey: TRANSFER_APPROVALS_QUERY_KEY,
		queryFn: ({ pageParam }) => fetchTransferApprovals({ status: "pending", cursor: pageParam }),
		initialPageParam: undefined as string | undefined,
		getNextPageParam: (lastPage) => lastPage.nextCursor,
		refetchInterval: APPROVALS_REFRESH_MS,
	});
	const usersQuery = useTransferUsers();
	const userNames = new Map(
		(usersQuery.data ?? []).map((user) => [user.id, user.name || user.email]),
	);

	const decideMutation = useMutation({
		mutationFn: (input: { id: string; decision: "approve" | "deny" }) =>
			decideTransferApproval(input.id, input.decision),
		onSuccess: () => {
			setApproving(null);
			void queryClient.invalidateQueries({ queryKey: TRANSFER_APPROVALS_QUERY_KEY });
		},
	});

	const now = Date.now();
	const pending = (approvalsQuery.data?.pages.flatMap((page) => page.items) ?? []).filter(
		(approval) => Date.parse(approval.expiresAt) > now,
	);

	return (
		<SettingsSection
			title={t`Approval requests`}
			description={t`Assistants connected through MCP need an admin’s approval to start an export or import unless their token was given a transfer scope. Requests expire after 15 minutes.`}
		>
			{approvalsQuery.isPending ? (
				<SettingRow>
					<div className="flex items-center gap-2 text-sm text-kumo-subtle" role="status">
						<Loader size="sm" />
						{t`Loading approval requests…`}
					</div>
				</SettingRow>
			) : approvalsQuery.error ? (
				<SettingRow>
					<Banner
						variant="error"
						role="alert"
						title={t`Couldn’t load approval requests`}
						description={getMutationError(approvalsQuery.error) ?? undefined}
					/>
				</SettingRow>
			) : pending.length === 0 ? (
				<SettingRow className="py-6 text-center text-sm text-kumo-subtle">
					{t`No pending requests`}
				</SettingRow>
			) : (
				pending.map((approval) => {
					const requester = userNames.get(approval.userId) ?? approval.userId;
					const expires = i18n.date(new Date(approval.expiresAt), { timeStyle: "short" });
					return (
						<SettingRow key={approval.id}>
							<div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
								<div className="min-w-0 text-sm leading-5">
									<p className="font-medium">
										{approval.action === "export"
											? t`Export requested by ${requester}`
											: t`Import requested by ${requester}`}
									</p>
									<p className="text-kumo-subtle">
										{approval.requestedByTokenId
											? t`Token ${approval.requestedByTokenId.slice(0, 8)} · expires ${expires}`
											: t`Expires ${expires}`}
									</p>
									{approval.packageDigest || approval.planDigest ? (
										<p className="font-mono text-xs text-kumo-subtle" dir="ltr">
											{[shortDigest(approval.packageDigest), shortDigest(approval.planDigest)]
												.filter(Boolean)
												.join("  ")}
										</p>
									) : null}
								</div>
								<div className="flex shrink-0 gap-2 self-end sm:self-center">
									<Button
										size="sm"
										variant="secondary"
										disabled={decideMutation.isPending}
										onClick={() => decideMutation.mutate({ id: approval.id, decision: "deny" })}
									>
										{t`Deny`}
									</Button>
									<Button
										size="sm"
										disabled={decideMutation.isPending}
										onClick={() => {
											decideMutation.reset();
											setApproving(approval);
										}}
									>
										{t`Approve`}
									</Button>
								</div>
							</div>
						</SettingRow>
					);
				})
			)}
			{approvalsQuery.hasNextPage ? (
				<SettingRow className="flex justify-center">
					<Button
						variant="outline"
						size="sm"
						disabled={approvalsQuery.isFetchingNextPage}
						onClick={() => void approvalsQuery.fetchNextPage()}
					>
						{approvalsQuery.isFetchingNextPage ? t`Loading…` : t`Load more`}
					</Button>
				</SettingRow>
			) : null}
			{decideMutation.error && approving === null ? (
				<SettingRow>
					<Banner
						variant="error"
						role="alert"
						title={t`Couldn’t update the request`}
						description={getMutationError(decideMutation.error) ?? undefined}
					/>
				</SettingRow>
			) : null}

			<ConfirmDialog
				open={approving !== null}
				onClose={() => {
					setApproving(null);
					decideMutation.reset();
				}}
				title={approving?.action === "import" ? t`Approve this import?` : t`Approve this export?`}
				description={
					approving?.action === "import"
						? t`The assistant can start this exact import once, within 15 minutes. It replaces this site’s starter content with the package it analyzed.`
						: t`The assistant can start one export of this site, within 15 minutes. The package includes all content and authors’ names and email addresses.`
				}
				confirmLabel={t`Approve`}
				pendingLabel={t`Approving…`}
				variant="primary"
				isPending={decideMutation.isPending}
				error={decideMutation.error}
				onConfirm={() =>
					approving && decideMutation.mutate({ id: approving.id, decision: "approve" })
				}
			/>
		</SettingsSection>
	);
}
