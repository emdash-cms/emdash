import { Badge, Button, Input, Surface, Table } from "@cloudflare/kumo";
import {
	ReleaseServiceClient,
	ReleaseServiceError,
	createReleaseIdempotencyKey,
	type PublisherResource,
	type ReleaseIntentResource,
	type WorkloadPolicyResource,
} from "@emdash-cms/registry-client/release-service";
import { type FormEvent, useCallback, useEffect, useMemo, useState } from "react";

import { beginPublisherDelegation, publisherCsrfToken } from "./api.js";
import { ErrorBanner, LoadingPanel, LoginPanel } from "./components.js";
import { useT } from "./i18n.js";

interface PublisherData {
	publisher: PublisherResource;
	workloads: WorkloadPolicyResource[];
	intents: ReleaseIntentResource[];
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
	const [loginRequired, setLoginRequired] = useState(false);
	const [error, setError] = useState<unknown>(null);
	const [busy, setBusy] = useState(false);
	const [packageSlug, setPackageSlug] = useState("");
	const [repository, setRepository] = useState("");
	const [repositoryId, setRepositoryId] = useState("");
	const [repositoryOwnerId, setRepositoryOwnerId] = useState("");
	const [workflowRef, setWorkflowRef] = useState("");
	const [allowedRef, setAllowedRef] = useState("refs/heads/main");

	const refresh = useCallback(async () => {
		setError(null);
		try {
			const [publisher, workloads, intents] = await Promise.all([
				client.getPublisher(),
				client.listWorkloads({ limit: 100 }),
				client.listPublisherIntents({ limit: 100 }),
			]);
			setData({ publisher, workloads: workloads.items, intents: intents.items });
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

	async function saveWorkload(event: FormEvent) {
		event.preventDefault();
		setBusy(true);
		setError(null);
		try {
			await client.putWorkload(
				{
					packageSlug,
					repository,
					repositoryId,
					repositoryOwnerId,
					workflowRef,
					allowedRefs: [allowedRef],
					allowedEnvironments: [],
					expectedVersion: null,
				},
				{ idempotencyKey: createReleaseIdempotencyKey("web-workload") },
			);
			setPackageSlug("");
			setRepository("");
			setRepositoryId("");
			setRepositoryOwnerId("");
			setWorkflowRef("");
			await refresh();
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

	return (
		<div className="flex flex-col gap-6">
			{error ? <ErrorBanner error={error} /> : null}
			<Surface className="rounded-xl border bg-kumo-base p-6">
				<div className="flex flex-wrap items-start justify-between gap-4">
					<div>
						<h2 className="text-xl font-semibold text-kumo-strong">
							{t("publisher.authority.title", "Publishing authority")}
						</h2>
						<p className="mt-1 break-all text-sm text-kumo-subtle">{data.publisher.did}</p>
					</div>
					<Badge variant={stateVariant(delegation?.status ?? "revoked")}>
						{delegation
							? stateLabel(t, delegation.status)
							: t("publisher.delegation.missing", "Not delegated")}
					</Badge>
				</div>
				<p className="mt-4 text-sm text-kumo-subtle">
					{t(
						"publisher.authority.description",
						"The service can only create package release records. It cannot update or delete records.",
					)}
				</p>
				<div className="mt-5 flex flex-wrap gap-2">
					<Button loading={busy} onClick={authorizeDelegation} variant="primary">
						{delegation?.status === "active"
							? t("publisher.delegation.replace", "Reauthorize delegation")
							: t("publisher.delegation.authorize", "Authorize delegation")}
					</Button>
					{delegation && delegation.status !== "revoked" ? (
						<Button loading={busy} onClick={revokeDelegation} variant="secondary-destructive">
							{t("publisher.delegation.revoke", "Revoke delegation")}
						</Button>
					) : null}
				</div>
			</Surface>

			<Surface className="rounded-xl border bg-kumo-base p-6">
				<h2 className="text-xl font-semibold text-kumo-strong">
					{t("publisher.workload.addTitle", "Add GitHub workload")}
				</h2>
				<form className="mt-5 grid gap-4 md:grid-cols-2" onSubmit={saveWorkload}>
					<Input
						label={t("publisher.workload.package", "Package slug")}
						required
						value={packageSlug}
						onChange={(event) => setPackageSlug(event.currentTarget.value)}
					/>
					<Input
						label={t("publisher.workload.repository", "Repository")}
						placeholder={t("publisher.workload.repositoryPlaceholder", "owner/repository")}
						required
						value={repository}
						onChange={(event) => setRepository(event.currentTarget.value)}
					/>
					<Input
						label={t("publisher.workload.repositoryId", "Repository ID")}
						required
						value={repositoryId}
						onChange={(event) => setRepositoryId(event.currentTarget.value)}
					/>
					<Input
						label={t("publisher.workload.ownerId", "Repository owner ID")}
						required
						value={repositoryOwnerId}
						onChange={(event) => setRepositoryOwnerId(event.currentTarget.value)}
					/>
					<Input
						className="md:col-span-2"
						label={t("publisher.workload.workflow", "Workflow reference")}
						required
						value={workflowRef}
						onChange={(event) => setWorkflowRef(event.currentTarget.value)}
					/>
					<Input
						label={t("publisher.workload.ref", "Allowed Git ref")}
						required
						value={allowedRef}
						onChange={(event) => setAllowedRef(event.currentTarget.value)}
					/>
					<div className="flex items-end">
						<Button loading={busy} type="submit" variant="primary">
							{t("publisher.workload.save", "Save workload")}
						</Button>
					</div>
				</form>
			</Surface>

			<Surface className="overflow-x-auto rounded-xl border bg-kumo-base p-0">
				<Table>
					<Table.Header>
						<Table.Row>
							<Table.Head>{t("publisher.workloads.package", "Package")}</Table.Head>
							<Table.Head>{t("publisher.workloads.repository", "Repository")}</Table.Head>
							<Table.Head>{t("publisher.workloads.workflow", "Workflow")}</Table.Head>
							<Table.Head>{t("publisher.workloads.status", "Status")}</Table.Head>
						</Table.Row>
					</Table.Header>
					<Table.Body>
						{data.workloads.map((workload) => (
							<Table.Row key={workload.packageSlug}>
								<Table.Cell>{workload.packageSlug}</Table.Cell>
								<Table.Cell>{workload.repository}</Table.Cell>
								<Table.Cell className="break-all">{workload.workflowRef}</Table.Cell>
								<Table.Cell>
									<Badge variant={workload.active ? "success" : "neutral"}>
										{workload.active
											? t("status.active", "Active")
											: t("status.disabled", "Disabled")}
									</Badge>
								</Table.Cell>
							</Table.Row>
						))}
					</Table.Body>
				</Table>
			</Surface>

			<Surface className="overflow-x-auto rounded-xl border bg-kumo-base p-0">
				<Table>
					<Table.Header>
						<Table.Row>
							<Table.Head>{t("publisher.intents.package", "Package")}</Table.Head>
							<Table.Head>{t("publisher.intents.version", "Version")}</Table.Head>
							<Table.Head>{t("publisher.intents.state", "State")}</Table.Head>
							<Table.Head>{t("publisher.intents.updated", "Updated")}</Table.Head>
						</Table.Row>
					</Table.Header>
					<Table.Body>
						{data.intents.map((intent) => (
							<Table.Row key={intent.id}>
								<Table.Cell>{intent.packageSlug}</Table.Cell>
								<Table.Cell>{intent.version}</Table.Cell>
								<Table.Cell>
									<Badge variant={stateVariant(intent.state)}>{stateLabel(t, intent.state)}</Badge>
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
		</div>
	);
}
