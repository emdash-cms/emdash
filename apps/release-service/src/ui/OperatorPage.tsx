import { Badge, Button, Dialog, Input, Surface, Table } from "@cloudflare/kumo";
import {
	ReleaseServiceOperatorClient,
	createReleaseIdempotencyKey,
	type ControlAuditEventResource,
	type DirectoryIdentityKind,
	type DirectoryIdentityResource,
	type EncryptionKeyStatusResource,
	type EncryptionRotationResult,
	type OperatorPublisherResource,
	type PublisherArchivePageResult,
	type PublisherRestorePageResult,
	type ServiceControlState,
	type StartPublisherArchiveResult,
} from "@emdash-cms/registry-client/release-service";
import { type FormEvent, useCallback, useEffect, useMemo, useState } from "react";

import { ErrorBanner, LoadingPanel } from "./components.js";
import { useT } from "./i18n.js";

function operatorStatus(t: ReturnType<typeof useT>, status: string): string {
	if (status === "active") return t("operator.status.active", "Active");
	if (status === "admission-paused")
		return t("operator.status.admissionPaused", "Admission paused");
	if (status === "publication-paused")
		return t("operator.status.publicationPaused", "Publication paused");
	if (status === "allowed") return t("operator.status.allowed", "Allowed");
	if (status === "suspended") return t("operator.status.suspended", "Suspended");
	if (status === "revoked") return t("operator.status.revoked", "Revoked");
	if (status === "reauthorization_required")
		return t("operator.status.reauthorize", "Reauthorization required");
	return t("operator.status.unknown", "Unknown");
}

function archiveKindLabel(
	t: ReturnType<typeof useT>,
	kind: PublisherArchivePageResult["kind"],
): string {
	if (kind === "metadata") return t("operator.archive.kind.metadata", "metadata");
	if (kind === "workload-policies")
		return t("operator.archive.kind.workloads", "workload policies");
	if (kind === "intents") return t("operator.archive.kind.intents", "release intents");
	return t("operator.archive.kind.audit", "audit events");
}

export function OperatorPage() {
	const t = useT();
	const client = useMemo(
		() => new ReleaseServiceOperatorClient({ serviceUrl: location.origin }),
		[],
	);
	const [state, setState] = useState<ServiceControlState | null>(null);
	const [publisher, setPublisher] = useState<OperatorPublisherResource | null>(null);
	const [publisherDid, setPublisherDid] = useState("");
	const [approverDid, setApproverDid] = useState("");
	const [intentId, setIntentId] = useState("");
	const [publisherRotationCursor, setPublisherRotationCursor] = useState("");
	const [approverRotationCursor, setApproverRotationCursor] = useState("");
	const [rotation, setRotation] = useState<EncryptionRotationResult | null>(null);
	const [encryptionKeys, setEncryptionKeys] = useState<EncryptionKeyStatusResource | null>(null);
	const [retireKeyVersion, setRetireKeyVersion] = useState("");
	const [retireKeyConfirmOpen, setRetireKeyConfirmOpen] = useState(false);
	const [verificationWorkflowId, setVerificationWorkflowId] = useState<string | null>(null);
	const [archiveId, setArchiveId] = useState(() => `archive-${crypto.randomUUID()}`);
	const [archiveCursor, setArchiveCursor] = useState("");
	const [archivePage, setArchivePage] = useState("0");
	const [archive, setArchive] = useState<PublisherArchivePageResult | null>(null);
	const [archiveWorkflow, setArchiveWorkflow] = useState<StartPublisherArchiveResult | null>(null);
	const [directoryKind, setDirectoryKind] = useState<DirectoryIdentityKind>("publisher");
	const [directoryCursor, setDirectoryCursor] = useState("");
	const [directoryItems, setDirectoryItems] = useState<DirectoryIdentityResource[]>([]);
	const [auditItems, setAuditItems] = useState<ControlAuditEventResource[]>([]);
	const [auditCursor, setAuditCursor] = useState("");
	const [restorePage, setRestorePage] = useState("0");
	const [restoreResult, setRestoreResult] = useState<PublisherRestorePageResult | null>(null);
	const [restoreConfirmOpen, setRestoreConfirmOpen] = useState(false);
	const [error, setError] = useState<unknown>(null);
	const [busy, setBusy] = useState(false);

	const refreshStatus = useCallback(async () => {
		try {
			const [serviceState, keyStatus] = await Promise.all([
				client.getStatus(),
				client.getEncryptionKeyStatus(),
			]);
			setState(serviceState);
			setEncryptionKeys(keyStatus);
		} catch (cause) {
			setError(cause);
		}
	}, [client]);

	useEffect(() => {
		void refreshStatus();
	}, [refreshStatus]);

	async function setMode(mode: ServiceControlState["mode"]) {
		setBusy(true);
		setError(null);
		try {
			const result = await client.setMode(mode, mode === "active" ? null : "OPERATOR_PAUSE", {
				idempotencyKey: createReleaseIdempotencyKey("web-service-mode"),
			});
			setState(result.value);
		} catch (cause) {
			setError(cause);
		} finally {
			setBusy(false);
		}
	}

	async function lookupPublisher(event: FormEvent) {
		event.preventDefault();
		setBusy(true);
		setError(null);
		try {
			setPublisher(await client.getPublisher(publisherDid));
		} catch (cause) {
			setError(cause);
		} finally {
			setBusy(false);
		}
	}

	async function setSuspended(suspended: boolean) {
		setBusy(true);
		setError(null);
		try {
			await client.setPublisherSuspended(
				publisherDid,
				suspended,
				suspended ? "OPERATOR_SUSPENDED" : null,
				{ idempotencyKey: createReleaseIdempotencyKey("web-publisher-control") },
			);
			setPublisher(await client.getPublisher(publisherDid));
		} catch (cause) {
			setError(cause);
		} finally {
			setBusy(false);
		}
	}

	async function revokePublisher() {
		setBusy(true);
		setError(null);
		try {
			await client.revokePublisher(publisherDid, {
				idempotencyKey: createReleaseIdempotencyKey("web-operator-revoke"),
			});
			setPublisher(await client.getPublisher(publisherDid));
		} catch (cause) {
			setError(cause);
		} finally {
			setBusy(false);
		}
	}

	async function rotateEncryption(owner: "approver" | "publisher") {
		setBusy(true);
		setError(null);
		try {
			const result =
				owner === "publisher"
					? await client.rotatePublisherEncryption(
							publisherDid,
							{ afterCursor: publisherRotationCursor || null, limit: 50 },
							{ idempotencyKey: createReleaseIdempotencyKey("web-publisher-rotation") },
						)
					: await client.rotateApproverEncryption(
							approverDid,
							{ afterCursor: approverRotationCursor || null, limit: 50 },
							{ idempotencyKey: createReleaseIdempotencyKey("web-approver-rotation") },
						);
			setRotation(result);
			if (owner === "publisher") setPublisherRotationCursor(result.nextCursor ?? "");
			else setApproverRotationCursor(result.nextCursor ?? "");
		} catch (cause) {
			setError(cause);
		} finally {
			setBusy(false);
		}
	}

	async function activateConfiguredEncryptionKey() {
		if (!encryptionKeys) return;
		setBusy(true);
		setError(null);
		try {
			await client.activateEncryptionKey(encryptionKeys.configured.activeVersion, {
				idempotencyKey: createReleaseIdempotencyKey("web-key-activate"),
			});
			setEncryptionKeys(await client.getEncryptionKeyStatus());
		} catch (cause) {
			setError(cause);
		} finally {
			setBusy(false);
		}
	}

	async function retireEncryptionKey() {
		const version = Number(retireKeyVersion);
		if (!Number.isSafeInteger(version) || version < 1) return;
		setBusy(true);
		setError(null);
		try {
			await client.retireEncryptionKey(version, {
				idempotencyKey: createReleaseIdempotencyKey("web-key-retire"),
			});
			setEncryptionKeys(await client.getEncryptionKeyStatus());
			setRetireKeyVersion("");
			setRetireKeyConfirmOpen(false);
		} catch (cause) {
			setError(cause);
		} finally {
			setBusy(false);
		}
	}

	async function startEncryptionVerification() {
		const version = Number(retireKeyVersion);
		if (!Number.isSafeInteger(version) || version < 1) return;
		setBusy(true);
		setError(null);
		try {
			const result = await client.startEncryptionVerification(version, {
				idempotencyKey: createReleaseIdempotencyKey("web-key-verify"),
			});
			setVerificationWorkflowId(result.workflowId);
		} catch (cause) {
			setError(cause);
		} finally {
			setBusy(false);
		}
	}

	async function refreshEncryptionKeyStatus() {
		setBusy(true);
		setError(null);
		try {
			setEncryptionKeys(await client.getEncryptionKeyStatus());
		} catch (cause) {
			setError(cause);
		} finally {
			setBusy(false);
		}
	}

	async function archivePublisher() {
		setBusy(true);
		setError(null);
		try {
			const result = await client.archivePublisher(
				publisherDid,
				{ archiveId, cursor: archiveCursor || null, page: Number(archivePage) },
				{ idempotencyKey: createReleaseIdempotencyKey("web-publisher-archive") },
			);
			setArchive(result);
			setArchiveCursor(result.nextCursor ?? "");
			setArchivePage(String(result.nextPage));
		} catch (cause) {
			setError(cause);
		} finally {
			setBusy(false);
		}
	}

	async function startPublisherArchive() {
		setBusy(true);
		setError(null);
		try {
			setArchiveWorkflow(
				await client.startPublisherArchive(publisherDid, archiveId, {
					idempotencyKey: createReleaseIdempotencyKey("web-publisher-archive-start"),
				}),
			);
		} catch (cause) {
			setError(cause);
		} finally {
			setBusy(false);
		}
	}

	async function listDirectory(kind: DirectoryIdentityKind) {
		setBusy(true);
		setError(null);
		try {
			let cursor = kind === directoryKind ? directoryCursor || undefined : undefined;
			for (let shard = 0; shard < 256; shard += 1) {
				const result = await client.listDirectory(kind, { cursor, limit: 50 });
				cursor = result.nextCursor;
				if (result.items.length > 0 || !cursor) {
					setDirectoryKind(kind);
					setDirectoryItems(result.items);
					setDirectoryCursor(cursor ?? "");
					return;
				}
			}
			throw new Error("Directory traversal did not terminate");
		} catch (cause) {
			setError(cause);
		} finally {
			setBusy(false);
		}
	}

	async function listAudit(reset: boolean) {
		setBusy(true);
		setError(null);
		try {
			const result = await client.listAudit({
				...(reset || !auditCursor ? {} : { cursor: auditCursor }),
				limit: 50,
			});
			setAuditItems(result.items);
			setAuditCursor(result.nextCursor ?? "");
		} catch (cause) {
			setError(cause);
		} finally {
			setBusy(false);
		}
	}

	async function preparePublisherRestore() {
		setBusy(true);
		setError(null);
		try {
			await client.preparePublisherRestore(publisherDid, archiveId, {
				idempotencyKey: createReleaseIdempotencyKey("web-publisher-restore-prepare"),
			});
			setRestorePage("0");
			setRestoreResult(null);
			setRestoreConfirmOpen(false);
		} catch (cause) {
			setError(cause);
		} finally {
			setBusy(false);
		}
	}

	async function restorePublisherPage() {
		setBusy(true);
		setError(null);
		try {
			const result = await client.restorePublisher(
				publisherDid,
				{ archiveId, page: Number(restorePage) },
				{ idempotencyKey: createReleaseIdempotencyKey("web-publisher-restore") },
			);
			setRestoreResult(result);
			setRestorePage(String(result.nextPage));
		} catch (cause) {
			setError(cause);
		} finally {
			setBusy(false);
		}
	}

	async function operateIntent(action: "cancel" | "reconcile") {
		setBusy(true);
		setError(null);
		try {
			if (action === "cancel") {
				await client.cancelIntent(publisherDid, intentId, {
					idempotencyKey: createReleaseIdempotencyKey("web-operator-cancel"),
				});
			} else {
				await client.reconcileIntent(publisherDid, intentId, {
					idempotencyKey: createReleaseIdempotencyKey("web-operator-reconcile"),
				});
			}
		} catch (cause) {
			setError(cause);
		} finally {
			setBusy(false);
		}
	}

	if (!state && !error) return <LoadingPanel />;

	return (
		<div className="flex flex-col gap-6">
			{error ? <ErrorBanner error={error} /> : null}
			<Surface className="rounded-xl border bg-kumo-base p-6">
				<div className="flex flex-wrap items-start justify-between gap-4">
					<div>
						<h2 className="text-xl font-semibold text-kumo-strong">
							{t("operator.service.title", "Service control")}
						</h2>
						<p className="mt-1 text-sm text-kumo-subtle">
							{t(
								"operator.service.description",
								"Pause admission or publication across the hosted service.",
							)}
						</p>
					</div>
					<Badge variant={state?.mode === "active" ? "success" : "warning"}>
						{operatorStatus(t, state?.mode ?? "unknown")}
					</Badge>
				</div>
				<div className="mt-5 flex flex-wrap gap-2">
					<Button loading={busy} onClick={() => setMode("active")} variant="secondary">
						{t("operator.service.activate", "Activate")}
					</Button>
					<Button loading={busy} onClick={() => setMode("admission-paused")} variant="outline">
						{t("operator.service.pauseAdmission", "Pause admission")}
					</Button>
					<Button loading={busy} onClick={() => setMode("publication-paused")} variant="outline">
						{t("operator.service.pausePublication", "Pause publication")}
					</Button>
				</div>
			</Surface>

			<Surface className="rounded-xl border bg-kumo-base p-6">
				<div className="flex flex-wrap items-start justify-between gap-4">
					<div>
						<h2 className="text-xl font-semibold text-kumo-strong">
							{t("operator.audit.title", "Service audit")}
						</h2>
						<p className="mt-1 text-sm text-kumo-subtle">
							{t(
								"operator.audit.description",
								"Review sanitized Access and service-control events in sequence.",
							)}
						</p>
					</div>
					<Button loading={busy} onClick={() => listAudit(true)} variant="outline">
						{t("operator.audit.load", "Load audit")}
					</Button>
				</div>
				{auditItems.length > 0 ? (
					<div className="mt-5 overflow-x-auto">
						<Table>
							<Table.Header>
								<Table.Row>
									<Table.Head>{t("operator.audit.sequence", "Sequence")}</Table.Head>
									<Table.Head>{t("operator.audit.event", "Event")}</Table.Head>
									<Table.Head>{t("operator.audit.actor", "Actor")}</Table.Head>
									<Table.Head>{t("operator.audit.subject", "Subject")}</Table.Head>
									<Table.Head>{t("operator.audit.time", "Time")}</Table.Head>
								</Table.Row>
							</Table.Header>
							<Table.Body>
								{auditItems.map((item) => (
									<Table.Row key={item.sequence}>
										<Table.Cell>{item.sequence}</Table.Cell>
										<Table.Cell>{item.eventType}</Table.Cell>
										<Table.Cell className="break-all">{item.actorIdentity}</Table.Cell>
										<Table.Cell className="break-all">{item.subject}</Table.Cell>
										<Table.Cell>
											{new Intl.DateTimeFormat(document.documentElement.lang, {
												dateStyle: "medium",
												timeStyle: "short",
											}).format(item.createdAt)}
										</Table.Cell>
									</Table.Row>
								))}
							</Table.Body>
						</Table>
						{auditCursor ? (
							<div className="mt-4 flex justify-end">
								<Button loading={busy} onClick={() => listAudit(false)} variant="outline">
									{t("operator.audit.next", "Next audit page")}
								</Button>
							</div>
						) : null}
					</div>
				) : null}
			</Surface>

			<Surface className="rounded-xl border bg-kumo-base p-6">
				<div className="flex flex-wrap items-start justify-between gap-4">
					<div>
						<h2 className="text-xl font-semibold text-kumo-strong">
							{t("operator.directory.title", "Operations directory")}
						</h2>
						<p className="mt-1 text-sm text-kumo-subtle">
							{t(
								"operator.directory.description",
								"List the next populated identity shard for fleet maintenance. Directory entries do not grant authority.",
							)}
						</p>
					</div>
					<Badge variant="neutral">
						{directoryKind === "publisher"
							? t("operator.directory.publishers", "Publishers")
							: t("operator.directory.approvers", "Approvers")}
					</Badge>
				</div>
				<div className="mt-4 flex flex-wrap gap-2">
					<Button loading={busy} onClick={() => listDirectory("publisher")} variant="outline">
						{t("operator.directory.listPublishers", "List publishers")}
					</Button>
					<Button loading={busy} onClick={() => listDirectory("approver")} variant="outline">
						{t("operator.directory.listApprovers", "List approvers")}
					</Button>
				</div>
				{directoryItems.length > 0 ? (
					<div className="mt-5 overflow-x-auto">
						<Table>
							<Table.Header>
								<Table.Row>
									<Table.Head>{t("operator.directory.did", "DID")}</Table.Head>
									<Table.Head>{t("operator.directory.shard", "Shard")}</Table.Head>
									<Table.Head>{t("operator.directory.lastSeen", "Last seen")}</Table.Head>
								</Table.Row>
							</Table.Header>
							<Table.Body>
								{directoryItems.map((item) => (
									<Table.Row key={`${item.kind}:${item.did}`}>
										<Table.Cell className="break-all">{item.did}</Table.Cell>
										<Table.Cell>{item.shard}</Table.Cell>
										<Table.Cell>
											{new Intl.DateTimeFormat(document.documentElement.lang, {
												dateStyle: "medium",
												timeStyle: "short",
											}).format(item.lastSeenAt)}
										</Table.Cell>
									</Table.Row>
								))}
							</Table.Body>
						</Table>
					</div>
				) : null}
			</Surface>

			<Surface className="rounded-xl border bg-kumo-base p-6">
				<div className="flex flex-wrap items-start justify-between gap-4">
					<div>
						<h2 className="text-xl font-semibold text-kumo-strong">
							{t("operator.archive.title", "Publisher archive")}
						</h2>
						<p className="mt-1 text-sm text-kumo-subtle">
							{t(
								"operator.archive.description",
								"Write one encrypted snapshot page and resume until the completion manifest is stored.",
							)}
						</p>
					</div>
					{archive ? (
						<Badge variant={archive.complete ? "success" : "warning"}>
							{archive.complete
								? t("operator.archive.complete", "Archive complete")
								: t("operator.archive.incomplete", "Resume required")}
						</Badge>
					) : null}
				</div>
				<div className="mt-5 grid gap-4 md:grid-cols-2">
					<Input
						label={t("operator.archive.publisherDid", "Publisher DID")}
						value={publisherDid}
						onChange={(event) => setPublisherDid(event.currentTarget.value)}
					/>
					<Input
						label={t("operator.archive.id", "Archive ID")}
						value={archiveId}
						onChange={(event) => setArchiveId(event.currentTarget.value)}
					/>
					<Input
						label={t("operator.archive.cursor", "Resume cursor")}
						value={archiveCursor}
						onChange={(event) => setArchiveCursor(event.currentTarget.value)}
					/>
					<Input
						label={t("operator.archive.page", "Page number")}
						type="number"
						value={archivePage}
						onChange={(event) => setArchivePage(event.currentTarget.value)}
					/>
				</div>
				<div className="mt-4 flex flex-wrap items-center gap-3">
					<Button
						disabled={!publisherDid || !archiveId}
						loading={busy}
						onClick={startPublisherArchive}
						variant="primary"
					>
						{t("operator.archive.start", "Start archive workflow")}
					</Button>
					<Button
						disabled={
							!publisherDid ||
							!archiveId ||
							!Number.isSafeInteger(Number(archivePage)) ||
							Number(archivePage) < 0
						}
						loading={busy}
						onClick={archivePublisher}
						variant="outline"
					>
						{t("operator.archive.write", "Write archive page")}
					</Button>
					{archiveWorkflow ? (
						<p className="break-all text-sm text-kumo-subtle">
							{t("operator.archive.workflow", "Workflow: {workflowId}", {
								workflowId: archiveWorkflow.workflowId,
							})}
						</p>
					) : null}
					{archive ? (
						<p className="text-sm text-kumo-subtle">
							{t("operator.archive.result", "Stored {kind} page {page}.", {
								kind: archiveKindLabel(t, archive.kind),
								page: archive.page,
							})}
						</p>
					) : null}
				</div>
				<div className="mt-6 border-t pt-5">
					<h3 className="font-semibold text-kumo-strong">
						{t("operator.restore.title", "Restore publisher shard")}
					</h3>
					<p className="mt-1 text-sm text-kumo-subtle">
						{t(
							"operator.restore.description",
							"Preparation deletes the suspended publisher shard before encrypted pages are applied in order.",
						)}
					</p>
					<div className="mt-4 flex flex-wrap items-end gap-3">
						<Input
							label={t("operator.restore.page", "Restore page")}
							type="number"
							value={restorePage}
							onChange={(event) => setRestorePage(event.currentTarget.value)}
						/>
						<Button
							disabled={!publisherDid || !archiveId}
							loading={busy}
							onClick={() => setRestoreConfirmOpen(true)}
							variant="secondary-destructive"
						>
							{t("operator.restore.prepare", "Prepare restore")}
						</Button>
						<Button
							disabled={
								!publisherDid ||
								!archiveId ||
								!Number.isSafeInteger(Number(restorePage)) ||
								Number(restorePage) < 0
							}
							loading={busy}
							onClick={restorePublisherPage}
							variant="outline"
						>
							{t("operator.restore.apply", "Apply restore page")}
						</Button>
					</div>
					{restoreResult ? (
						<p className="mt-4 text-sm text-kumo-subtle">
							{restoreResult.complete
								? t("operator.restore.complete", "Restore complete. Reauthorization is required.")
								: t("operator.restore.next", "Restore page stored. Apply the next page.")}
						</p>
					) : null}
				</div>
			</Surface>

			<Dialog.Root
				disablePointerDismissal
				onOpenChange={setRestoreConfirmOpen}
				open={restoreConfirmOpen}
			>
				<Dialog className="p-6" size="sm">
					<Dialog.Title className="text-lg font-semibold">
						{t("operator.restore.confirmTitle", "Delete publisher state for restore?")}
					</Dialog.Title>
					<Dialog.Description className="mt-2 text-sm text-kumo-subtle">
						{t(
							"operator.restore.confirmDescription",
							"The publisher must be suspended. This deletes current workload and intent state before archive pages can be restored.",
						)}
					</Dialog.Description>
					<div className="mt-6 flex justify-end gap-3">
						<Button onClick={() => setRestoreConfirmOpen(false)} variant="secondary">
							{t("common.cancel", "Cancel")}
						</Button>
						<Button
							loading={busy}
							onClick={preparePublisherRestore}
							variant="secondary-destructive"
						>
							{t("operator.restore.confirm", "Delete and prepare")}
						</Button>
					</div>
				</Dialog>
			</Dialog.Root>

			<Surface className="rounded-xl border bg-kumo-base p-6">
				<div className="flex flex-wrap items-start justify-between gap-4">
					<div>
						<h2 className="text-xl font-semibold text-kumo-strong">
							{t("operator.encryption.title", "Encryption maintenance")}
						</h2>
						<p className="mt-1 text-sm text-kumo-subtle">
							{t(
								"operator.encryption.description",
								"Keep publication paused while activating, rotating, verifying, or retiring encryption keys.",
							)}
						</p>
					</div>
					{rotation ? (
						<Badge variant={rotation.complete && rotation.raced === 0 ? "success" : "warning"}>
							{rotation.complete
								? t("operator.encryption.complete", "Verified")
								: t("operator.encryption.incomplete", "Resume required")}
						</Badge>
					) : null}
				</div>
				{encryptionKeys ? (
					<div className="mt-5 flex flex-col gap-4">
						<p className="text-sm text-kumo-subtle">
							{t(
								"operator.encryption.configured",
								"Configured active key: {activeVersion}. Available versions: {versions}.",
								{
									activeVersion: encryptionKeys.configured.activeVersion,
									versions: encryptionKeys.configured.versions.join(", "),
								},
							)}
						</p>
						<div className="overflow-x-auto">
							<Table>
								<Table.Header>
									<Table.Row>
										<Table.Head>{t("operator.encryption.version", "Version")}</Table.Head>
										<Table.Head>{t("operator.encryption.status", "Status")}</Table.Head>
										<Table.Head>{t("operator.encryption.updated", "Updated")}</Table.Head>
									</Table.Row>
								</Table.Header>
								<Table.Body>
									{encryptionKeys.keys.map((key) => (
										<Table.Row key={key.version}>
											<Table.Cell>{key.version}</Table.Cell>
											<Table.Cell>
												<Badge
													variant={
														key.status === "active"
															? "success"
															: key.status === "readable"
																? "warning"
																: "neutral"
													}
												>
													{key.status === "active"
														? t("operator.encryption.active", "Active")
														: key.status === "readable"
															? t("operator.encryption.readable", "Readable")
															: t("operator.encryption.retired", "Retired")}
												</Badge>
											</Table.Cell>
											<Table.Cell>
												{key.updatedAt === 0
													? t("operator.encryption.bootstrap", "Bootstrap")
													: new Intl.DateTimeFormat(document.documentElement.lang, {
															dateStyle: "medium",
															timeStyle: "short",
														}).format(key.updatedAt)}
											</Table.Cell>
										</Table.Row>
									))}
								</Table.Body>
							</Table>
						</div>
						{encryptionKeys.verification ? (
							<p className="text-sm text-kumo-subtle">
								{t(
									"operator.encryption.verification",
									"Key {keyVersion} verified {publishers} publisher shards, {approvers} approver shards, and {records} retained records.",
									{
										keyVersion: encryptionKeys.verification.targetKeyVersion,
										publishers: encryptionKeys.verification.publishers,
										approvers: encryptionKeys.verification.approvers,
										records: encryptionKeys.verification.records,
									},
								)}
							</p>
						) : null}
						{verificationWorkflowId ? (
							<p className="break-all text-sm text-kumo-subtle">
								{t("operator.encryption.workflow", "Verification Workflow: {workflowId}", {
									workflowId: verificationWorkflowId,
								})}
							</p>
						) : null}
						<div className="flex flex-wrap items-end gap-3">
							<Button loading={busy} onClick={refreshEncryptionKeyStatus} variant="outline">
								{t("operator.encryption.refresh", "Refresh key status")}
							</Button>
							<Button
								disabled={
									state?.mode !== "publication-paused" ||
									encryptionKeys.keys.find((key) => key.status === "active")?.version ===
										encryptionKeys.configured.activeVersion
								}
								loading={busy}
								onClick={activateConfiguredEncryptionKey}
								variant="outline"
							>
								{t("operator.encryption.activate", "Activate configured key")}
							</Button>
							<Input
								label={t("operator.encryption.previousVersion", "Previous key version")}
								type="number"
								value={retireKeyVersion}
								onChange={(event) => setRetireKeyVersion(event.currentTarget.value)}
							/>
							<Button
								disabled={
									state?.mode !== "publication-paused" ||
									!Number.isSafeInteger(Number(retireKeyVersion)) ||
									Number(retireKeyVersion) < 1 ||
									!encryptionKeys.configured.versions.includes(Number(retireKeyVersion))
								}
								loading={busy}
								onClick={startEncryptionVerification}
								variant="outline"
							>
								{t("operator.encryption.verify", "Start fleet verification")}
							</Button>
							<Button
								disabled={
									state?.mode !== "publication-paused" ||
									!Number.isSafeInteger(Number(retireKeyVersion)) ||
									Number(retireKeyVersion) < 1 ||
									encryptionKeys.configured.versions.includes(Number(retireKeyVersion)) ||
									encryptionKeys.verification === null
								}
								loading={busy}
								onClick={() => setRetireKeyConfirmOpen(true)}
								variant="secondary-destructive"
							>
								{t("operator.encryption.retire", "Retire removed key")}
							</Button>
						</div>
					</div>
				) : null}
				<h3 className="mt-6 font-semibold text-kumo-strong">
					{t("operator.encryption.rotationTitle", "Shard rotation")}
				</h3>
				<div className="mt-5 grid gap-4 md:grid-cols-2">
					<div className="flex flex-col gap-3">
						<Input
							label={t("operator.encryption.publisherDid", "Publisher DID")}
							value={publisherDid}
							onChange={(event) => setPublisherDid(event.currentTarget.value)}
						/>
						<Input
							label={t("operator.encryption.publisherCursor", "Publisher resume cursor")}
							value={publisherRotationCursor}
							onChange={(event) => setPublisherRotationCursor(event.currentTarget.value)}
						/>
						<Button
							disabled={!publisherDid}
							loading={busy}
							onClick={() => rotateEncryption("publisher")}
							variant="outline"
						>
							{t("operator.encryption.publisher", "Rotate publisher shard")}
						</Button>
					</div>
					<div className="flex flex-col gap-3">
						<Input
							label={t("operator.encryption.approverDid", "Approver DID")}
							value={approverDid}
							onChange={(event) => setApproverDid(event.currentTarget.value)}
						/>
						<Input
							label={t("operator.encryption.approverCursor", "Approver resume cursor")}
							value={approverRotationCursor}
							onChange={(event) => setApproverRotationCursor(event.currentTarget.value)}
						/>
						<Button
							disabled={!approverDid}
							loading={busy}
							onClick={() => rotateEncryption("approver")}
							variant="outline"
						>
							{t("operator.encryption.approver", "Rotate approver shard")}
						</Button>
					</div>
				</div>
				{rotation ? (
					<p className="mt-4 text-sm text-kumo-subtle">
						{t(
							"operator.encryption.result",
							"Key {keyVersion}: scanned {scanned}, rotated {rotated}, raced {raced}.",
							{
								keyVersion: rotation.targetKeyVersion,
								scanned: rotation.scanned,
								rotated: rotation.rotated,
								raced: rotation.raced,
							},
						)}
					</p>
				) : null}
			</Surface>

			<Dialog.Root
				disablePointerDismissal
				onOpenChange={setRetireKeyConfirmOpen}
				open={retireKeyConfirmOpen}
			>
				<Dialog className="p-6" size="sm">
					<Dialog.Title className="text-lg font-semibold">
						{t("operator.encryption.retireConfirmTitle", "Retire encryption key?")}
					</Dialog.Title>
					<Dialog.Description className="mt-2 text-sm text-kumo-subtle">
						{t(
							"operator.encryption.retireConfirmDescription",
							"Retire this version only after two zero-change verification scans and after removing it from the configured keyring. Remaining ciphertext for this version will become unreadable.",
						)}
					</Dialog.Description>
					<div className="mt-6 flex justify-end gap-3">
						<Button onClick={() => setRetireKeyConfirmOpen(false)} variant="secondary">
							{t("common.cancel", "Cancel")}
						</Button>
						<Button loading={busy} onClick={retireEncryptionKey} variant="secondary-destructive">
							{t("operator.encryption.retireConfirm", "Retire key")}
						</Button>
					</div>
				</Dialog>
			</Dialog.Root>

			<Surface className="rounded-xl border bg-kumo-base p-6">
				<h2 className="text-xl font-semibold text-kumo-strong">
					{t("operator.publisher.title", "Publisher lookup")}
				</h2>
				<form
					className="mt-5 flex flex-col gap-4 sm:flex-row sm:items-end"
					onSubmit={lookupPublisher}
				>
					<Input
						className="flex-1"
						label={t("operator.publisher.did", "Publisher DID")}
						required
						value={publisherDid}
						onChange={(event) => setPublisherDid(event.currentTarget.value)}
					/>
					<Button loading={busy} type="submit" variant="primary">
						{t("operator.publisher.lookup", "Look up publisher")}
					</Button>
				</form>
				{publisher ? (
					<div className="mt-5 flex flex-wrap items-center gap-3 border-t pt-5">
						<Badge variant={publisher.control.status === "allowed" ? "success" : "error"}>
							{operatorStatus(t, publisher.control.status)}
						</Badge>
						<Badge variant={publisher.delegation?.status === "active" ? "success" : "neutral"}>
							{publisher.delegation
								? operatorStatus(t, publisher.delegation.status)
								: t("operator.publisher.noDelegation", "No delegation")}
						</Badge>
						<Button
							loading={busy}
							onClick={() => setSuspended(publisher.control.status !== "suspended")}
							variant="outline"
						>
							{publisher.control.status === "suspended"
								? t("operator.publisher.restore", "Restore")
								: t("operator.publisher.suspend", "Suspend")}
						</Button>
						<Button loading={busy} onClick={revokePublisher} variant="secondary-destructive">
							{t("operator.publisher.revoke", "Revoke authority")}
						</Button>
					</div>
				) : null}
			</Surface>

			<Surface className="rounded-xl border bg-kumo-base p-6">
				<h2 className="text-xl font-semibold text-kumo-strong">
					{t("operator.intent.title", "Intent recovery")}
				</h2>
				<div className="mt-5 grid gap-4 sm:grid-cols-2">
					<Input
						label={t("operator.intent.publisherDid", "Publisher DID")}
						required
						value={publisherDid}
						onChange={(event) => setPublisherDid(event.currentTarget.value)}
					/>
					<Input
						label={t("operator.intent.id", "Intent ID")}
						required
						value={intentId}
						onChange={(event) => setIntentId(event.currentTarget.value)}
					/>
				</div>
				<div className="mt-4 flex flex-wrap gap-2">
					<Button
						disabled={!publisherDid || !intentId}
						loading={busy}
						onClick={() => operateIntent("reconcile")}
						variant="primary"
					>
						{t("operator.intent.reconcile", "Reconcile")}
					</Button>
					<Button
						disabled={!publisherDid || !intentId}
						loading={busy}
						onClick={() => operateIntent("cancel")}
						variant="secondary-destructive"
					>
						{t("operator.intent.cancel", "Cancel intent")}
					</Button>
				</div>
			</Surface>
		</div>
	);
}
