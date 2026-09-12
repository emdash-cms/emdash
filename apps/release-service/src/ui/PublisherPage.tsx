import { Badge, Button, LinkButton, Popover, Select, Surface, Table } from "@cloudflare/kumo";
import {
	ReleaseServiceClient,
	ReleaseServiceError,
	createReleaseIdempotencyKey,
	type PublisherApproverStatusResult,
	type PublisherAuditEventResource,
	type PublisherResource,
	type ReleaseIntentResource,
	type WorkloadPolicyResource,
	type WorkflowConnectionRefScope,
	type WorkflowConnectionRequestResource,
} from "@emdash-cms/registry-client/release-service";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { beginPublisherDelegation, publisherCsrfToken } from "./api.js";
import { ErrorBanner, LoadingPanel, LoginPanel } from "./components.js";
import { useT } from "./i18n.js";

const GIT_REF_PREFIX_PATTERN = /^refs\/(?:heads|tags)\//;
const WORKFLOW_CONNECTION_POLL_INTERVAL_MS = 5_000;
const RELEASE_SETUP_COMMAND = "pnpm exec emdash-plugin release setup";

interface PublisherData {
	publisher: PublisherResource;
	connections: WorkflowConnectionRequestResource[];
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
	if (eventType === "workflow-connection-invitation-created")
		return t("activity.workflowInvitationCreated", "Workflow invitation created");
	if (eventType === "workflow-connection-rejected")
		return t("activity.workflowConnectionRejected", "Workflow connection rejected");
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

function defaultRefScope(request: WorkflowConnectionRequestResource): WorkflowConnectionRefScope {
	return request.claim.ref.startsWith("refs/tags/") ? "version_tags" : "current_ref";
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

interface RepositoryConnectionGroup {
	key: string;
	packages: WorkloadPolicyResource[];
	policy: WorkloadPolicyResource;
	repositoryConnection: boolean;
}

function repositoryConnectionGroups(
	workloads: WorkloadPolicyResource[],
): RepositoryConnectionGroup[] {
	const groups = new Map<string, RepositoryConnectionGroup>();
	for (const workload of workloads) {
		const key = JSON.stringify([
			workload.repositoryId,
			workload.repositoryOwnerId,
			workflowFile(workload.repository, workload.workflowRef),
		]);
		const group = groups.get(key);
		if (group) {
			group.packages.push(workload);
			if (workload.active) group.policy = workload;
			if (workload.repositoryConnection) group.repositoryConnection = true;
		} else {
			groups.set(key, {
				key,
				packages: [workload],
				policy: workload,
				repositoryConnection: workload.repositoryConnection,
			});
		}
	}
	return [...groups.values()].toSorted((left, right) =>
		left.policy.repository.localeCompare(right.policy.repository),
	);
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
	const [connectionScopes, setConnectionScopes] = useState<
		Record<string, WorkflowConnectionRefScope>
	>({});
	const requestedConnectionId = useMemo(
		() => new URLSearchParams(location.search).get("connection"),
		[],
	);
	const requestedConnectionElement = useRef<HTMLDivElement>(null);
	const focusedConnectionId = useRef<string | null>(null);

	const refresh = useCallback(async () => {
		setError(null);
		try {
			const [publisher, connections, workloads, intents, audit] = await Promise.all([
				client.getPublisher(),
				client.listWorkflowConnections(),
				client.listWorkloads({ limit: 100 }),
				client.listPublisherIntents({ limit: 100 }),
				client.listPublisherAudit({ limit: 50 }),
			]);
			setData({
				publisher,
				connections,
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

	const requestedConnection = data?.connections.find(
		(connection) => connection.id === requestedConnectionId,
	);
	const requestedConnectionKey = requestedConnection?.id;
	const requestedConnectionState = requestedConnection?.state;
	const requestedConnectionExpiresAt = requestedConnection?.expiresAt;

	useEffect(() => {
		const element = requestedConnectionElement.current;
		if (
			!requestedConnectionKey ||
			!element ||
			focusedConnectionId.current === requestedConnectionKey
		) {
			return;
		}
		focusedConnectionId.current = requestedConnectionKey;
		element.scrollIntoView({ behavior: "smooth", block: "center" });
		element.focus({ preventScroll: true });
	}, [requestedConnectionKey]);

	useEffect(() => {
		if (
			!requestedConnectionId ||
			requestedConnectionState !== "pending" ||
			requestedConnectionExpiresAt === undefined ||
			requestedConnectionExpiresAt <= Date.now()
		) {
			return;
		}

		const abortController = new AbortController();
		let stopped = false;
		let timeout: ReturnType<typeof setTimeout> | undefined;

		const schedule = (expiresAt: number) => {
			const remaining = expiresAt - Date.now();
			if (stopped || remaining <= 0) return;
			timeout = setTimeout(
				() => void poll(),
				Math.min(WORKFLOW_CONNECTION_POLL_INTERVAL_MS, remaining),
			);
		};

		const poll = async () => {
			try {
				const [publisher, connections] = await Promise.all([
					client.getPublisher({ signal: abortController.signal }),
					client.listWorkflowConnections({ signal: abortController.signal }),
				]);
				if (stopped) return;
				setError(null);
				setData((current) => (current ? { ...current, publisher, connections } : current));
				const pending = connections.find(
					(connection) => connection.id === requestedConnectionId && connection.state === "pending",
				);
				if (pending) schedule(pending.expiresAt);
			} catch (cause) {
				if (stopped || abortController.signal.aborted) return;
				if (
					cause instanceof ReleaseServiceError &&
					(cause.code === "PUBLISHER_SESSION_INVALID" || cause.code === "AUTH_INVALID")
				) {
					setLoginRequired(true);
					return;
				}
				setError(cause);
				schedule(requestedConnectionExpiresAt);
			}
		};

		schedule(requestedConnectionExpiresAt);
		return () => {
			stopped = true;
			abortController.abort();
			if (timeout) clearTimeout(timeout);
		};
	}, [client, requestedConnectionExpiresAt, requestedConnectionId, requestedConnectionState]);

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

	async function confirmWorkflowConnection(request: WorkflowConnectionRequestResource) {
		setBusy(true);
		setError(null);
		try {
			await client.confirmWorkflowConnection(
				request.id,
				connectionScopes[request.id] ?? defaultRefScope(request),
				{ idempotencyKey: createReleaseIdempotencyKey("web-workflow-confirm") },
			);
			await refresh();
		} catch (cause) {
			setError(cause);
		} finally {
			setBusy(false);
		}
	}

	async function rejectWorkflowConnection(request: WorkflowConnectionRequestResource) {
		setBusy(true);
		setError(null);
		try {
			await client.rejectWorkflowConnection(request.id, {
				idempotencyKey: createReleaseIdempotencyKey("web-workflow-reject"),
			});
			await refresh();
		} catch (cause) {
			setError(cause);
		} finally {
			setBusy(false);
		}
	}

	async function disableRepositoryConnection(group: RepositoryConnectionGroup) {
		setBusy(true);
		setError(null);
		try {
			await Promise.all(
				group.packages
					.filter((workload) => workload.active)
					.map((workload) =>
						client.disableWorkload(workload.packageSlug, workload.stateVersion, {
							idempotencyKey: createReleaseIdempotencyKey("web-workflow-disable"),
						}),
					),
			);
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
	const workloadGroups = repositoryConnectionGroups(data.workloads);
	const connectionGroups = workloadGroups.filter((group) => group.repositoryConnection);
	const legacyGroups = workloadGroups.filter((group) => !group.repositoryConnection);

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
						? t("publisher.workload.setupTitle", "2. Connect your GitHub repository")
						: t("publisher.workload.addTitle", "Repository workflow")}
				</h2>
				{!publishingEnabled ? (
					<p className="mt-1 text-sm text-kumo-subtle">
						{t(
							"publisher.workload.authorizationRequired",
							"Authorize publishing before connecting a GitHub workflow.",
						)}
					</p>
				) : data.connections.length > 0 ? (
					<p className="mt-1 text-sm text-kumo-subtle">
						{t(
							"publisher.workload.reviewDescription",
							"A repository workflow is waiting for approval. Check its GitHub identity before connecting it to your signed package profiles.",
						)}
					</p>
				) : (
					<div className="mt-3 grid gap-3 text-sm">
						<p className="text-kumo-subtle">
							{t(
								"publisher.workload.setupCommand",
								"Run this once from the plugin repository. It prepares the current package profile and creates one shared GitHub workflow:",
							)}
						</p>
						<div className="overflow-x-auto rounded-lg bg-kumo-tint px-4 py-3">
							<code className="whitespace-nowrap font-mono text-sm text-kumo-strong">
								{RELEASE_SETUP_COMMAND}
							</code>
						</div>
						<p className="text-kumo-subtle">
							{t(
								"publisher.workload.setupResult",
								"Review and commit .github/workflows/emdash-release.yml, then push a package tag such as gallery@1.2.3 or start it from GitHub Actions.",
							)}
						</p>
						<p className="text-kumo-subtle">
							{t(
								"publisher.workload.firstRun",
								"The first run for each tag or branch scope appears here for approval. Later packages reuse those scopes when their signed profiles name the same repository.",
							)}
						</p>
					</div>
				)}
				{data.connections.length > 0 ? (
					<div className="mt-5 grid gap-4">
						{data.connections.map((request) => {
							const scope = connectionScopes[request.id] ?? defaultRefScope(request);
							const tagRequest = request.claim.ref.startsWith("refs/tags/");
							const isRequested = request.id === requestedConnectionId;
							const headingId = `workflow-connection-${request.id}`;
							return (
								<div
									aria-current={isRequested ? "true" : undefined}
									aria-labelledby={headingId}
									className={`rounded-lg border p-4 transition-colors ${
										isRequested
											? "border-kumo-brand bg-kumo-brand/10 ring-2 ring-kumo-brand/20"
											: "border-transparent bg-kumo-tint"
									}`}
									key={request.id}
									ref={isRequested ? requestedConnectionElement : undefined}
									role="region"
									tabIndex={isRequested ? -1 : undefined}
								>
									<div className="flex flex-wrap items-start justify-between gap-3">
										<div>
											<h3 className="font-semibold text-kumo-strong" id={headingId}>
												{t("publisher.connection.title", "Connect GitHub repository")}
											</h3>
											<p className="mt-1 text-sm text-kumo-subtle">
												{t(
													"publisher.connection.warning",
													"Approve only if you recognise this repository and workflow.",
												)}
											</p>
											<p className="mt-2 text-sm text-kumo-subtle">
												{t(
													"publisher.connection.profileCheck",
													"The initiating {packageSlug} profile already names this repository. Future packages must pass the same signed-profile check.",
													{ packageSlug: request.packageSlug },
												)}
											</p>
										</div>
										<Badge variant="warning">
											{t("publisher.connection.waiting", "Waiting for approval")}
										</Badge>
									</div>
									<dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
										<div>
											<dt className="text-kumo-subtle">
												{t("publisher.connection.repository", "Repository")}
											</dt>
											<dd className="font-medium text-kumo-strong">{request.claim.repository}</dd>
										</div>
										<div>
											<dt className="text-kumo-subtle">
												{t("publisher.connection.workflow", "Workflow file")}
											</dt>
											<dd className="font-medium text-kumo-strong">
												{workflowFile(request.claim.repository, request.claim.workflowRef)}
											</dd>
										</div>
										<div>
											<dt className="text-kumo-subtle">
												{t("publisher.connection.trigger", "Started from")}
											</dt>
											<dd className="font-medium text-kumo-strong">
												{friendlyRef(request.claim.ref)}
											</dd>
										</div>
										{request.claim.environment ? (
											<div>
												<dt className="text-kumo-subtle">
													{t("publisher.connection.environment", "Environment")}
												</dt>
												<dd className="font-medium text-kumo-strong">
													{request.claim.environment}
												</dd>
											</div>
										) : null}
									</dl>
									{tagRequest ? (
										<Select
											className="mt-4 max-w-sm"
											items={{
												version_tags: t(
													"publisher.connection.scope.allTags",
													"All package version tags",
												),
												current_ref: t("publisher.connection.scope.currentTag", "Only this tag"),
											}}
											label={t(
												"publisher.connection.scope.label",
												"Which releases may this workflow publish?",
											)}
											onValueChange={(value) => {
												if (value === "current_ref" || value === "version_tags") {
													setConnectionScopes((current) => ({
														...current,
														[request.id]: value,
													}));
												}
											}}
											value={scope}
										/>
									) : (
										<p className="mt-4 text-sm text-kumo-subtle">
											{t(
												"publisher.connection.scope.branch",
												"This approval adds the branch to the repository connection. Existing tag and branch scopes remain active.",
											)}
										</p>
									)}
									<div className="mt-4 flex flex-wrap gap-2">
										<Button
											disabled={!publishingEnabled || busy}
											onClick={() => confirmWorkflowConnection(request)}
											variant="primary"
										>
											{t("publisher.connection.approve", "Connect repository")}
										</Button>
										<Button
											disabled={busy}
											onClick={() => rejectWorkflowConnection(request)}
											variant="secondary-destructive"
										>
											{t("publisher.connection.reject", "Reject request")}
										</Button>
									</div>
								</div>
							);
						})}
					</div>
				) : publishingEnabled ? (
					<Button className="mt-4" disabled={busy} onClick={refresh} variant="outline">
						{t("publisher.connection.check", "Check for workflow requests")}
					</Button>
				) : null}
			</Surface>

			{connectionGroups.length > 0 ? (
				<Surface className="rounded-xl border bg-kumo-base p-6">
					<h2 className="text-xl font-semibold text-kumo-strong">
						{t("publisher.workloads.title", "Connected repositories")}
					</h2>
					<p className="mt-1 text-sm text-kumo-subtle">
						{t(
							"publisher.workloads.description",
							"Each repository workflow can publish packages whose signed profiles name the same repository.",
						)}
					</p>
					<div className="mt-5 grid gap-4">
						{connectionGroups.map((group) => {
							const active = group.packages.some((workload) => workload.active);
							return (
								<div className="rounded-lg border bg-kumo-tint p-4" key={group.key}>
									<div className="flex flex-wrap items-start justify-between gap-4">
										<div>
											<div className="flex flex-wrap items-center gap-2">
												<h3 className="font-semibold text-kumo-strong">
													{group.policy.repository}
												</h3>
												<Badge variant={active ? "success" : "neutral"}>
													{active ? t("status.active", "Active") : t("status.disabled", "Disabled")}
												</Badge>
											</div>
											<p className="mt-1 font-mono text-sm text-kumo-subtle">
												{workflowFile(group.policy.repository, group.policy.workflowRef)}
											</p>
										</div>
										{active ? (
											<Button
												disabled={busy}
												onClick={() => disableRepositoryConnection(group)}
												variant="secondary-destructive"
											>
												{t("publisher.workloads.disable", "Disable repository")}
											</Button>
										) : null}
									</div>
									<div className="mt-4 flex flex-wrap gap-2">
										{group.packages.map((workload) => (
											<Button
												disabled={busy}
												key={workload.packageSlug}
												onClick={() => loadApproverStatus(workload.packageSlug)}
												variant="outline"
											>
												{workload.packageSlug}
											</Button>
										))}
									</div>
								</div>
							);
						})}
					</div>
				</Surface>
			) : null}

			{legacyGroups.length > 0 ? (
				<Surface className="rounded-xl border bg-kumo-base p-6">
					<h2 className="text-xl font-semibold text-kumo-strong">
						{t("publisher.workloads.legacyTitle", "Package-scoped workflows")}
					</h2>
					<p className="mt-1 text-sm text-kumo-subtle">
						{t(
							"publisher.workloads.legacyDescription",
							"These existing approvals remain limited to their packages. The first unmatched package or ref asks you to create a reusable repository connection.",
						)}
					</p>
					<div className="mt-5 grid gap-3">
						{legacyGroups.map((group) => (
							<div className="rounded-lg border bg-kumo-tint p-4" key={group.key}>
								<p className="font-semibold text-kumo-strong">{group.policy.repository}</p>
								<p className="mt-1 font-mono text-sm text-kumo-subtle">
									{workflowFile(group.policy.repository, group.policy.workflowRef)}
								</p>
								<div className="mt-3 flex flex-wrap gap-2">
									{group.packages.map((workload) => (
										<Badge key={workload.packageSlug} variant="neutral">
											{workload.packageSlug}
										</Badge>
									))}
								</div>
							</div>
						))}
					</div>
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
								<Table.Head>
									<span className="sr-only">{t("publisher.intents.action", "Action")}</span>
								</Table.Head>
							</Table.Row>
						</Table.Header>
						<Table.Body>
							{data.intents.map((intent) => (
								<Table.Row key={intent.id}>
									<Table.Cell>{intent.packageSlug}</Table.Cell>
									<Table.Cell>{intent.version}</Table.Cell>
									<Table.Cell>
										<div className="flex flex-col items-start gap-1">
											<Badge variant={stateVariant(intent.state)}>
												{stateLabel(t, intent.state)}
											</Badge>
											{intent.reasonCode ? (
												<code className="text-xs text-kumo-subtle">{intent.reasonCode}</code>
											) : null}
										</div>
									</Table.Cell>
									<Table.Cell>
										{new Intl.DateTimeFormat(document.documentElement.lang, {
											dateStyle: "medium",
											timeStyle: "short",
										}).format(intent.updatedAt)}
									</Table.Cell>
									<Table.Cell>
										{intent.approvalUrl ? (
											<LinkButton href={intent.approvalUrl} size="sm" variant="outline">
												{t("publisher.intents.review", "Review release")}
											</LinkButton>
										) : null}
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
