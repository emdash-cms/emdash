import { Badge, Button, Input, Popover, Surface, Table } from "@cloudflare/kumo";
import {
	ReleaseServiceClient,
	ReleaseServiceError,
	createReleaseIdempotencyKey,
	type CreateWorkflowPairingResult,
	type PublisherApproverStatusResult,
	type PublisherAuditEventResource,
	type PublisherResource,
	type ReleaseIntentResource,
	type WorkloadPolicyResource,
} from "@emdash-cms/registry-client/release-service";
import { type FormEvent, useCallback, useEffect, useMemo, useState } from "react";

import { beginPublisherDelegation, publisherCsrfToken } from "./api.js";
import { ErrorBanner, LoadingPanel, LoginPanel } from "./components.js";
import { useT } from "./i18n.js";

const GIT_REF_PREFIX_PATTERN = /^refs\/(?:heads|tags)\//;

interface PublisherData {
	publisher: PublisherResource;
	workloads: WorkloadPolicyResource[];
	intents: ReleaseIntentResource[];
	audit: PublisherAuditEventResource[];
	auditCursor?: string;
}

function stateVariant(state: string): "error" | "neutral" | "success" | "warning" {
	if (state === "published" || state === "active") return "success";
	if (state === "failed" || state === "conflict" || state === "invalid" || state === "revoked") {
		return "error";
	}
	if (state === "awaiting_approval" || state === "reconciling") return "warning";
	return "neutral";
}

function stateLabel(t: ReturnType<typeof useT>, state: string): string {
	switch (state) {
		case "active":
			return t("status.active", "Active");
		case "awaiting_approval":
			return t("status.awaitingApproval", "Awaiting approval");
		case "cancelled":
			return t("status.cancelled", "Cancelled");
		case "conflict":
			return t("status.conflict", "Conflict");
		case "expired":
			return t("status.expired", "Expired");
		case "failed":
			return t("status.failed", "Failed");
		case "invalid":
			return t("status.invalid", "Invalid");
		case "published":
			return t("status.published", "Published");
		case "publishing":
			return t("status.publishing", "Publishing");
		case "ready":
			return t("status.ready", "Ready");
		case "reauthorization_required":
			return t("status.reauthorizationRequired", "Reauthorization required");
		case "received":
			return t("status.received", "Received");
		case "reconciling":
			return t("status.reconciling", "Reconciling");
		case "rejected":
			return t("status.rejected", "Rejected");
		case "revoked":
			return t("status.revoked", "Revoked");
		case "verified":
			return t("status.verified", "Verified");
		case "verifying":
			return t("status.verifying", "Verifying");
		default:
			return t("status.unknown", "Unknown");
	}
}

function activityEventLabel(t: ReturnType<typeof useT>, eventType: string): string {
	if (eventType === "publisher-session-created") return t("activity.signedIn", "Signed in");
	if (eventType === "publisher-session-revoked") return t("activity.signedOut", "Signed out");
	if (eventType === "publisher-sessions-revoked")
		return t("activity.sessionsEnded", "Account sessions ended");
	if (eventType === "oauth-state-created")
		return t("activity.signInStarted", "Account connection started");
	if (eventType === "oauth-state-consumed")
		return t("activity.signInCompleted", "Account connection completed");
	if (eventType === "oauth-state-expired")
		return t("activity.signInExpired", "Account connection expired");
	if (eventType === "workload-policy-stored")
		return t("activity.workflowConnected", "GitHub workflow connected");
	if (eventType === "delegation-stored")
		return t("activity.publishingEnabled", "Automated publishing enabled");
	if (eventType === "delegation-revoked")
		return t("activity.publishingDisabled", "Automated publishing turned off");
	if (eventType === "publisher-suspension-changed")
		return t("activity.accountAccessChanged", "Account access changed");
	if (eventType === "delegation-reauthorization-required")
		return t("activity.publishingReconnectNeeded", "Publishing account needs reconnecting");
	if (eventType === "delegation-refresh-started")
		return t("activity.publishingRefreshStarted", "Publishing account refresh started");
	if (eventType === "delegation-refresh-completed")
		return t("activity.publishingRefreshCompleted", "Publishing account refreshed");
	if (eventType === "delegation-refresh-released")
		return t("activity.publishingRefreshReleased", "Publishing account refresh released");
	if (eventType === "intent-received") return t("activity.releaseSubmitted", "Release submitted");
	if (eventType === "intent-transitioned")
		return t("activity.releaseStatusChanged", "Release status changed");
	if (eventType === "intent-restored") return t("activity.releaseRestored", "Release restored");
	if (eventType === "verification-step-recorded")
		return t("activity.releaseChecksUpdated", "Release checks updated");
	if (eventType === "publication-operation-started")
		return t("activity.releasePublishingStarted", "Release publishing started");
	if (eventType === "publication-operation-completed")
		return t("activity.releasePublished", "Release published");
	if (
		eventType === "publication-operation-recovery-required" ||
		eventType === "publication-operation-retry-required"
	) {
		return t("activity.releaseRecoveryNeeded", "Release publishing needs attention");
	}
	if (eventType === "publisher-restore-prepared")
		return t("activity.restorePrepared", "Account recovery prepared");
	if (eventType === "publisher-restore-started")
		return t("activity.restoreStarted", "Account recovery started");
	if (eventType === "publisher-restore-completed")
		return t("activity.restoreCompleted", "Account recovery completed");
	if (eventType === "publisher-restore-aborted")
		return t("activity.restoreCancelled", "Account recovery cancelled");
	if (eventType === "encryption-rotated")
		return t("activity.securityUpdated", "Account security updated");
	return t("activity.recorded", "Account activity recorded");
}

function workflowPairingStep(
	pairing: CreateWorkflowPairingResult,
	publisherDid: string,
	stepName: string,
): string {
	return [
		`- name: ${stepName}`,
		"  run: |",
		"    npx @emdash-cms/plugin-cli release connect \\",
		`      --service-url ${location.origin} \\`,
		`      --publisher-did ${publisherDid} \\`,
		`      --pairing-id ${pairing.pairing.id} \\`,
		`      --pairing-token ${pairing.pairingToken}`,
	].join("\n");
}

function activityActorLabel(t: ReturnType<typeof useT>, item: PublisherAuditEventResource): string {
	if (item.actorHandle) return formatHandle(item.actorHandle);
	if (item.actorRealm === "system") return t("activity.actor.service", "EmDash release service");
	if (item.actorIdentity.startsWith("did:"))
		return t("activity.actor.atmosphere", "Atmosphere account");
	return item.actorIdentity;
}

function formatHandle(handle: string): string {
	return handle.startsWith("@") ? handle : `@${handle}`;
}

function ActivityDetails({
	action,
	item,
	t,
}: {
	action: string;
	item: PublisherAuditEventResource;
	t: ReturnType<typeof useT>;
}) {
	return (
		<Popover>
			<Popover.Trigger
				render={
					<Button
						aria-label={t("publisher.audit.viewDetails", "View details for {action}", {
							action,
						})}
						icon={
							<span aria-hidden="true" className="text-base leading-none">
								•••
							</span>
						}
						shape="square"
						size="sm"
						variant="ghost"
					/>
				}
			/>
			<Popover.Content align="end" className="w-80 max-w-[calc(100vw-2rem)] p-4">
				<Popover.Title>{t("publisher.audit.detailsTitle", "Activity details")}</Popover.Title>
				<dl className="mt-3 grid gap-3 text-sm">
					<div>
						<dt className="text-kumo-subtle">{t("publisher.audit.eventType", "Event type")}</dt>
						<dd>
							<code className="break-all">{item.eventType}</code>
						</dd>
					</div>
					<div>
						<dt className="text-kumo-subtle">{t("publisher.audit.actorId", "Actor ID")}</dt>
						<dd>
							<code className="break-all">{item.actorIdentity}</code>
						</dd>
					</div>
					<div>
						<dt className="text-kumo-subtle">{t("publisher.audit.subject", "Subject")}</dt>
						<dd>
							<code className="break-all">{item.subject}</code>
						</dd>
					</div>
					{item.reasonCode ? (
						<div>
							<dt className="text-kumo-subtle">{t("publisher.audit.reason", "Reason")}</dt>
							<dd>
								<code className="break-all">{item.reasonCode}</code>
							</dd>
						</div>
					) : null}
				</dl>
			</Popover.Content>
		</Popover>
	);
}

function AccountIdentifier({
	did,
	handle,
	t,
}: {
	did: string;
	handle: string | null;
	t: ReturnType<typeof useT>;
}) {
	if (handle) return formatHandle(handle);
	return (
		<span className="flex items-center gap-1">
			{t("publisher.approvers.account", "Atmosphere account")}
			<Popover>
				<Popover.Trigger
					render={
						<Button
							aria-label={t("publisher.approvers.viewAccountId", "View account ID")}
							icon={<span aria-hidden="true">•••</span>}
							shape="square"
							size="xs"
							variant="ghost"
						/>
					}
				/>
				<Popover.Content align="start" className="w-72 max-w-[calc(100vw-2rem)] p-4">
					<Popover.Title>{t("publisher.approvers.accountId", "Account ID")}</Popover.Title>
					<code className="mt-2 block break-all text-sm">{did}</code>
				</Popover.Content>
			</Popover>
		</span>
	);
}

function workflowFile(repository: string, workflowRef: string): string {
	return workflowRef.slice(`${repository}/`.length).split("@", 1)[0] ?? workflowRef;
}

function friendlyRef(ref: string): string {
	return ref.replace(GIT_REF_PREFIX_PATTERN, "");
}

export function PublisherPage() {
	const t = useT();
	const client = useMemo(
		() =>
			new ReleaseServiceClient({
				serviceUrl: location.origin,
				csrfToken: publisherCsrfToken,
			}),
		[],
	);
	const [data, setData] = useState<PublisherData | null>(null);
	const [approverStatus, setApproverStatus] = useState<PublisherApproverStatusResult | null>(null);
	const [loginRequired, setLoginRequired] = useState(false);
	const [error, setError] = useState<unknown>(null);
	const [busy, setBusy] = useState(false);
	const [packageSlug, setPackageSlug] = useState("");
	const [workflowPairing, setWorkflowPairing] = useState<CreateWorkflowPairingResult | null>(null);

	const refresh = useCallback(async () => {
		setError(null);
		try {
			const [publisher, workloads, intents, audit] = await Promise.all([
				client.getPublisher(),
				client.listWorkloads({ limit: 100 }),
				client.listPublisherIntents({ limit: 100 }),
				client.listPublisherAudit({ limit: 50 }),
			]);
			setData({
				publisher,
				workloads: workloads.items,
				intents: intents.items,
				audit: audit.items,
				...(audit.nextCursor ? { auditCursor: audit.nextCursor } : {}),
			});
			setApproverStatus(null);
			setLoginRequired(false);
		} catch (cause) {
			if (
				cause instanceof ReleaseServiceError &&
				(cause.code === "PUBLISHER_SESSION_INVALID" || cause.code === "AUTH_INVALID")
			) {
				setLoginRequired(true);
				return;
			}
			setError(cause);
		}
	}, [client]);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	async function authorizeDelegation() {
		setBusy(true);
		setError(null);
		try {
			location.assign(await beginPublisherDelegation("/publisher"));
		} catch (cause) {
			setError(cause);
			setBusy(false);
		}
	}

	async function revokeDelegation() {
		setBusy(true);
		setError(null);
		try {
			await client.revokeDelegation({ idempotencyKey: createReleaseIdempotencyKey("web-revoke") });
			await refresh();
		} catch (cause) {
			setError(cause);
		} finally {
			setBusy(false);
		}
	}

	async function startWorkflowPairing(event: FormEvent) {
		event.preventDefault();
		if (data?.publisher.delegation?.status !== "active") return;
		setBusy(true);
		setError(null);
		try {
			setWorkflowPairing(
				await client.createWorkflowPairing(packageSlug, {
					idempotencyKey: createReleaseIdempotencyKey("web-workflow-pairing"),
				}),
			);
		} catch (cause) {
			setError(cause);
		} finally {
			setBusy(false);
		}
	}

	async function checkWorkflowPairing() {
		if (!workflowPairing) return;
		setBusy(true);
		setError(null);
		try {
			setWorkflowPairing({
				...workflowPairing,
				pairing: await client.getWorkflowPairing(workflowPairing.pairing.id),
			});
		} catch (cause) {
			setError(cause);
		} finally {
			setBusy(false);
		}
	}

	async function confirmWorkflowPairing() {
		if (!workflowPairing) return;
		setBusy(true);
		setError(null);
		try {
			await client.confirmWorkflowPairing(workflowPairing.pairing.id, {
				idempotencyKey: createReleaseIdempotencyKey("web-workflow-confirm"),
			});
			setWorkflowPairing(null);
			setPackageSlug("");
			await refresh();
		} catch (cause) {
			setError(cause);
		} finally {
			setBusy(false);
		}
	}

	async function loadNextAuditPage() {
		if (!data?.auditCursor) return;
		setBusy(true);
		setError(null);
		try {
			const audit = await client.listPublisherAudit({ cursor: data.auditCursor, limit: 50 });
			setData((current) =>
				current
					? {
							...current,
							audit: [...current.audit, ...audit.items],
							...(audit.nextCursor
								? { auditCursor: audit.nextCursor }
								: { auditCursor: undefined }),
						}
					: current,
			);
		} catch (cause) {
			setError(cause);
		} finally {
			setBusy(false);
		}
	}

	async function loadApproverStatus(workloadPackageSlug: string) {
		setBusy(true);
		setError(null);
		try {
			setApproverStatus(await client.getPublisherApproverStatus(workloadPackageSlug));
		} catch (cause) {
			setError(cause);
		} finally {
			setBusy(false);
		}
	}

	if (loginRequired) return <LoginPanel realm="publisher" />;
	if (!data && !error) return <LoadingPanel />;
	if (!data) return <ErrorBanner error={error} />;
	const delegation = data.publisher.delegation;
	const publishingEnabled = delegation?.status === "active";
	const publisherHandle = data.publisher.handle ? formatHandle(data.publisher.handle) : null;

	return (
		<div className="flex flex-col gap-6">
			{error ? <ErrorBanner error={error} /> : null}
			<Surface className="rounded-xl border bg-kumo-base p-6">
				<div className="flex flex-wrap items-start justify-between gap-4">
					<div>
						<h2 className="text-xl font-semibold text-kumo-strong">
							{publishingEnabled
								? t("publisher.authority.title", "Automated publishing")
								: t("publisher.authority.setupTitle", "1. Allow EmDash to publish releases")}
						</h2>
						<p className="mt-1 text-sm text-kumo-subtle">
							{publisherHandle
								? t("publisher.signedInAs", "Signed in as {handle}", {
										handle: publisherHandle,
									})
								: t("publisher.signedIn", "Signed in with Atmosphere")}
						</p>
					</div>
					<Badge variant={publishingEnabled ? "success" : "warning"}>
						{publishingEnabled
							? t("status.active", "Active")
							: t("publisher.delegation.missing", "Setup needed")}
					</Badge>
				</div>
				<p className="mt-4 text-sm text-kumo-subtle">
					{t(
						"publisher.authority.description",
						"EmDash may create new plugin release records and upload their files. It cannot change or delete existing records.",
					)}
				</p>
				<div className="mt-5 flex flex-wrap gap-2">
					<Button disabled={busy} onClick={authorizeDelegation} variant="primary">
						{publishingEnabled
							? t("publisher.delegation.replace", "Reconnect publishing")
							: t("publisher.delegation.authorize", "Authorize publishing")}
					</Button>
					{delegation && delegation.status !== "revoked" ? (
						<Button disabled={busy} onClick={revokeDelegation} variant="secondary-destructive">
							{t("publisher.delegation.revoke", "Turn off automated publishing")}
						</Button>
					) : null}
				</div>
			</Surface>

			<Surface className="rounded-xl border bg-kumo-base p-6">
				<h2 className="text-xl font-semibold text-kumo-strong">
					{data.workloads.length === 0
						? t("publisher.workload.setupTitle", "2. Connect a GitHub Actions workflow")
						: t("publisher.workload.addTitle", "Connect another GitHub Actions workflow")}
				</h2>
				{publishingEnabled ? (
					<p className="mt-1 text-sm text-kumo-subtle">
						{t(
							"publisher.workload.description",
							"Choose which workflow may publish releases for one of your plugin packages. GitHub proves the repository, workflow file, and branch when you run it.",
						)}
					</p>
				) : (
					<p className="mt-1 text-sm text-kumo-subtle">
						{t(
							"publisher.workload.authorizationRequired",
							"Authorize publishing before connecting a GitHub workflow.",
						)}
					</p>
				)}
				{!workflowPairing ? (
					<form className="mt-5 max-w-2xl" onSubmit={startWorkflowPairing}>
						<div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
							<Input
								aria-describedby="workflow-plugin-id-description"
								disabled={!publishingEnabled || busy}
								label={t("publisher.workload.package", "Plugin ID")}
								placeholder={t("publisher.workload.packagePlaceholder", "gallery")}
								required
								value={packageSlug}
								onChange={(event) => setPackageSlug(event.currentTarget.value)}
							/>
							<Button disabled={!publishingEnabled || busy} type="submit" variant="primary">
								{t("publisher.workload.start", "Start connection")}
							</Button>
						</div>
						<p id="workflow-plugin-id-description" className="mt-2 text-sm text-kumo-subtle">
							{t(
								"publisher.workload.packageDescription",
								"Use the plugin ID from emdash-plugin.jsonc for the plugin this workflow will publish.",
							)}
						</p>
					</form>
				) : workflowPairing.pairing.state === "pending" ? (
					<div className="mt-5">
						<h3 className="font-semibold text-kumo-strong">
							{t("publisher.pairing.runTitle", "Run the workflow once to identify it")}
						</h3>
						<p className="mt-1 text-sm text-kumo-subtle">
							{t(
								"publisher.pairing.runDescription",
								"Add a temporary connection step to the GitHub Actions job that should publish this plugin. EmDash will show you what GitHub identifies before you approve anything.",
							)}
						</p>
						<p className="mt-4 text-sm font-medium text-kumo-strong">
							{t(
								"publisher.pairing.permissionTitle",
								"Grant the job permission to identify itself",
							)}
						</p>
						<pre className="mt-4 overflow-x-auto rounded-lg bg-kumo-tint p-4 text-sm text-kumo-default">
							<code>{"permissions:\n  id-token: write"}</code>
						</pre>
						<p className="mt-4 text-sm font-medium text-kumo-strong">
							{t("publisher.pairing.stepTitle", "Add this temporary step and run the workflow")}
						</p>
						<pre className="mt-4 overflow-x-auto rounded-lg bg-kumo-tint p-4 text-sm text-kumo-default">
							<code>
								{workflowPairingStep(
									workflowPairing,
									data.publisher.did,
									t("publisher.pairing.stepName", "Connect EmDash publishing"),
								)}
							</code>
						</pre>
						<p className="mt-3 text-sm text-kumo-subtle">
							{t(
								"publisher.pairing.removeStep",
								"You can remove the temporary step after you confirm the connection.",
							)}
						</p>
						<div className="mt-4 flex flex-wrap gap-2">
							<Button disabled={busy} onClick={checkWorkflowPairing} variant="primary">
								{t("publisher.pairing.check", "I've run the workflow")}
							</Button>
							<Button onClick={() => setWorkflowPairing(null)} variant="outline">
								{t("publisher.pairing.cancel", "Cancel")}
							</Button>
						</div>
					</div>
				) : workflowPairing.pairing.state === "claimed" && workflowPairing.pairing.claim ? (
					<div className="mt-5">
						<h3 className="font-semibold text-kumo-strong">
							{t("publisher.pairing.confirmTitle", "Confirm this GitHub workflow")}
						</h3>
						<dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
							<div>
								<dt className="text-kumo-subtle">
									{t("publisher.pairing.repository", "Repository")}
								</dt>
								<dd className="font-medium text-kumo-strong">
									{workflowPairing.pairing.claim.repository}
								</dd>
							</div>
							<div>
								<dt className="text-kumo-subtle">
									{t("publisher.pairing.workflow", "Workflow file")}
								</dt>
								<dd className="font-medium text-kumo-strong">
									{workflowFile(
										workflowPairing.pairing.claim.repository,
										workflowPairing.pairing.claim.workflowRef,
									)}
								</dd>
							</div>
							<div>
								<dt className="text-kumo-subtle">
									{t("publisher.pairing.branch", "Branch or tag")}
								</dt>
								<dd className="font-medium text-kumo-strong">
									{friendlyRef(workflowPairing.pairing.claim.ref)}
								</dd>
							</div>
							{workflowPairing.pairing.claim.environment ? (
								<div>
									<dt className="text-kumo-subtle">
										{t("publisher.pairing.environment", "Environment")}
									</dt>
									<dd className="font-medium text-kumo-strong">
										{workflowPairing.pairing.claim.environment}
									</dd>
								</div>
							) : null}
						</dl>
						<div className="mt-5 flex flex-wrap gap-2">
							<Button disabled={busy} onClick={confirmWorkflowPairing} variant="primary">
								{t("publisher.pairing.confirm", "Allow this workflow")}
							</Button>
							<Button onClick={() => setWorkflowPairing(null)} variant="outline">
								{t("publisher.pairing.cancel", "Cancel")}
							</Button>
						</div>
					</div>
				) : (
					<div className="mt-5">
						<p className="text-sm text-kumo-subtle">
							{t(
								"publisher.pairing.expired",
								"This connection has expired. Start again to create a new one.",
							)}
						</p>
						<Button className="mt-4" onClick={() => setWorkflowPairing(null)} variant="primary">
							{t("publisher.pairing.restart", "Start again")}
						</Button>
					</div>
				)}
			</Surface>

			{data.workloads.length > 0 ? (
				<Surface className="overflow-x-auto rounded-xl border bg-kumo-base p-0">
					<div className="p-6 pb-0">
						<h2 className="text-xl font-semibold text-kumo-strong">
							{t("publisher.workloads.title", "Connected GitHub workflows")}
						</h2>
					</div>
					<Table>
						<Table.Header>
							<Table.Row>
								<Table.Head>{t("publisher.workloads.package", "Package")}</Table.Head>
								<Table.Head>{t("publisher.workloads.repository", "Repository")}</Table.Head>
								<Table.Head>{t("publisher.workloads.workflow", "Workflow")}</Table.Head>
								<Table.Head>{t("publisher.workloads.status", "Status")}</Table.Head>
								<Table.Head>{t("publisher.workloads.approvers", "Approval setup")}</Table.Head>
							</Table.Row>
						</Table.Header>
						<Table.Body>
							{data.workloads.map((workload) => (
								<Table.Row key={workload.packageSlug}>
									<Table.Cell>{workload.packageSlug}</Table.Cell>
									<Table.Cell>{workload.repository}</Table.Cell>
									<Table.Cell>{workflowFile(workload.repository, workload.workflowRef)}</Table.Cell>
									<Table.Cell>
										<Badge variant={workload.active ? "success" : "neutral"}>
											{workload.active
												? t("status.active", "Active")
												: t("status.disabled", "Disabled")}
										</Badge>
									</Table.Cell>
									<Table.Cell>
										<Button
											disabled={busy}
											onClick={() => loadApproverStatus(workload.packageSlug)}
											variant="outline"
										>
											{t("publisher.workloads.checkApprovers", "Check approval readiness")}
										</Button>
									</Table.Cell>
								</Table.Row>
							))}
						</Table.Body>
					</Table>
				</Surface>
			) : null}

			{approverStatus ? (
				<Surface className="rounded-xl border bg-kumo-base p-6">
					<div>
						<h2 className="text-xl font-semibold text-kumo-strong">
							{t("publisher.approvers.title", "Approval readiness")}
						</h2>
						<p className="mt-1 text-sm text-kumo-subtle">
							{t(
								"publisher.approvers.description",
								"Security-key setup for the accounts allowed to approve {packageSlug} releases.",
								{ packageSlug: approverStatus.packageSlug },
							)}
						</p>
						<details className="mt-3 text-sm text-kumo-subtle">
							<summary>{t("publisher.profileReference", "Show profile reference")}</summary>
							<code className="mt-2 block break-all">{approverStatus.profileCid}</code>
						</details>
					</div>
					{approverStatus.items.length > 0 ? (
						<div className="mt-5 overflow-x-auto">
							<Table>
								<Table.Header>
									<Table.Row>
										<Table.Head>{t("publisher.approvers.did", "Account")}</Table.Head>
										<Table.Head>{t("publisher.approvers.status", "Status")}</Table.Head>
									</Table.Row>
								</Table.Header>
								<Table.Body>
									{approverStatus.items.map((item) => (
										<Table.Row key={item.did}>
											<Table.Cell>
												<AccountIdentifier did={item.did} handle={item.handle} t={t} />
											</Table.Cell>
											<Table.Cell>
												<Badge variant={item.status === "enrolled" ? "success" : "warning"}>
													{item.status === "enrolled"
														? t("publisher.approvers.enrolled", "Enrolled")
														: item.status === "revoked"
															? t("publisher.approvers.revoked", "Credentials revoked")
															: t("publisher.approvers.notEnrolled", "Not enrolled")}
												</Badge>
											</Table.Cell>
										</Table.Row>
									))}
								</Table.Body>
							</Table>
						</div>
					) : (
						<p className="mt-5 text-sm text-kumo-subtle">
							{t("publisher.approvers.empty", "No accounts are configured to approve this plugin.")}
						</p>
					)}
				</Surface>
			) : null}

			{data.intents.length > 0 ? (
				<Surface className="overflow-x-auto rounded-xl border bg-kumo-base p-0">
					<div className="p-6 pb-0">
						<h2 className="text-xl font-semibold text-kumo-strong">
							{t("publisher.intents.title", "Recent releases")}
						</h2>
					</div>
					<Table>
						<Table.Header>
							<Table.Row>
								<Table.Head>{t("publisher.intents.package", "Package")}</Table.Head>
								<Table.Head>{t("publisher.intents.version", "Version")}</Table.Head>
								<Table.Head>{t("publisher.intents.state", "Status")}</Table.Head>
								<Table.Head>{t("publisher.intents.updated", "Updated")}</Table.Head>
							</Table.Row>
						</Table.Header>
						<Table.Body>
							{data.intents.map((intent) => (
								<Table.Row key={intent.id}>
									<Table.Cell>{intent.packageSlug}</Table.Cell>
									<Table.Cell>{intent.version}</Table.Cell>
									<Table.Cell>
										<Badge variant={stateVariant(intent.state)}>
											{stateLabel(t, intent.state)}
										</Badge>
									</Table.Cell>
									<Table.Cell>
										{new Intl.DateTimeFormat(document.documentElement.lang, {
											dateStyle: "medium",
											timeStyle: "short",
										}).format(intent.updatedAt)}
									</Table.Cell>
								</Table.Row>
							))}
						</Table.Body>
					</Table>
				</Surface>
			) : null}

			<Surface className="rounded-xl border bg-kumo-base p-6">
				<div className="flex flex-wrap items-start justify-between gap-4">
					<div>
						<h2 className="text-xl font-semibold text-kumo-strong">
							{t("publisher.audit.title", "Account activity")}
						</h2>
					</div>
				</div>
				{data.audit.length > 0 ? (
					<div className="mt-5 overflow-x-auto">
						<Table>
							<Table.Header>
								<Table.Row>
									<Table.Head>{t("publisher.audit.event", "Action")}</Table.Head>
									<Table.Head>{t("publisher.audit.actor", "By")}</Table.Head>
									<Table.Head>{t("publisher.audit.time", "When")}</Table.Head>
									<Table.Head>
										<span className="sr-only">{t("publisher.audit.details", "Details")}</span>
									</Table.Head>
								</Table.Row>
							</Table.Header>
							<Table.Body>
								{data.audit.map((item) => (
									<Table.Row key={item.sequence}>
										<Table.Cell>{activityEventLabel(t, item.eventType)}</Table.Cell>
										<Table.Cell>{activityActorLabel(t, item)}</Table.Cell>
										<Table.Cell>
											{new Intl.DateTimeFormat(document.documentElement.lang, {
												dateStyle: "medium",
												timeStyle: "short",
											}).format(item.createdAt)}
										</Table.Cell>
										<Table.Cell>
											<ActivityDetails
												action={activityEventLabel(t, item.eventType)}
												item={item}
												t={t}
											/>
										</Table.Cell>
									</Table.Row>
								))}
							</Table.Body>
						</Table>
					</div>
				) : (
					<p className="mt-5 text-sm text-kumo-subtle">
						{t("publisher.audit.empty", "No account activity yet")}
					</p>
				)}
				{data.auditCursor ? (
					<div className="mt-4 flex justify-end">
						<Button disabled={busy} onClick={loadNextAuditPage} variant="outline">
							{t("publisher.audit.next", "Show older activity")}
						</Button>
					</div>
				) : null}
			</Surface>
		</div>
	);
}
