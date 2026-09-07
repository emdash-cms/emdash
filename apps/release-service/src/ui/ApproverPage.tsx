import { Badge, Button, Input, Surface } from "@cloudflare/kumo";
import { type FormEvent, useCallback, useEffect, useState } from "react";

import {
	beginApprovalDecision,
	beginPasskeyRegistration,
	completeApprovalDecision,
	completePasskeyRegistration,
	getApproval,
	listApproverCredentials,
	type ApprovalResource,
	type ApproverCredential,
	UiApiError,
} from "./api.js";
import { ErrorBanner, LoadingPanel, LoginPanel } from "./components.js";
import { useT } from "./i18n.js";
import {
	authenticationResponse,
	creationOptions,
	registrationResponse,
	requestOptions,
} from "./webauthn.js";

function detail(value: string | null, fallback: string): string {
	return value || fallback;
}

function workflowFile(repository: string | null, workflowRef: string | null): string | null {
	if (!workflowRef) return null;
	const repositoryPrefix = repository ? `${repository}/` : "";
	const withoutRepository =
		repositoryPrefix && workflowRef.startsWith(repositoryPrefix)
			? workflowRef.slice(repositoryPrefix.length)
			: workflowRef;
	return withoutRepository.split("@", 1)[0] ?? withoutRepository;
}

function accessCapability(
	t: ReturnType<typeof useT>,
	category: string,
	operation: string | null,
): string {
	if (category === "content" && operation === "read")
		return t("approval.access.capability.contentRead", "read site content");
	if (category === "content" && operation === "write")
		return t("approval.access.capability.contentWrite", "change site content");
	if (category === "email" && operation === "events")
		return t("approval.access.capability.emailEvents", "respond to incoming email");
	if (category === "email" && operation === "send")
		return t("approval.access.capability.emailSend", "send email");
	if (category === "email" && operation === "transport")
		return t("approval.access.capability.emailTransport", "use email delivery");
	if (category === "media" && operation === "read")
		return t("approval.access.capability.mediaRead", "read media files");
	if (category === "media" && operation === "write")
		return t("approval.access.capability.mediaWrite", "change media files");
	if (category === "network" && operation === "request")
		return t("approval.access.capability.networkRequest", "connect to external websites");
	if (category === "page" && operation === "fragments")
		return t("approval.access.capability.pageFragments", "add content to admin pages");
	if (category === "users" && operation === "read")
		return t("approval.access.capability.usersRead", "read user accounts");
	if (category === "content") return t("approval.access.category.content", "site content");
	if (category === "email") return t("approval.access.category.email", "email");
	if (category === "media") return t("approval.access.category.media", "media files");
	if (category === "network") return t("approval.access.category.network", "external websites");
	if (category === "page") return t("approval.access.category.page", "admin pages");
	if (category === "users") return t("approval.access.category.users", "user accounts");
	return t("approval.access.category.other", "plugin data");
}

function accessChangeLabel(
	t: ReturnType<typeof useT>,
	change: ApprovalResource["review"]["accessDiff"]["changes"][number],
): string {
	const capability = accessCapability(t, change.category, change.operation);
	if (
		change.kind === "category-added" ||
		change.kind === "operation-added" ||
		change.kind === "constraint-added"
	) {
		return t("approval.access.adds", "Adds permission to {capability}", { capability });
	}
	if (
		change.kind === "category-removed" ||
		change.kind === "operation-removed" ||
		change.kind === "constraint-removed"
	) {
		return t("approval.access.removes", "Removes permission to {capability}", { capability });
	}
	return t("approval.access.changes", "Changes permission limits for {capability}", {
		capability,
	});
}

export function ApproverPage({ embedded = false }: { embedded?: boolean }) {
	const t = useT();
	const standalone = embedded || location.pathname === "/approver";
	const intentId = location.pathname.startsWith("/approvals/")
		? location.pathname.slice("/approvals/".length)
		: "";
	const publisherDid = new URLSearchParams(location.search).get("publisher") ?? "";
	const [approval, setApproval] = useState<ApprovalResource | null>(null);
	const [credentials, setCredentials] = useState<ApproverCredential[]>([]);
	const [loaded, setLoaded] = useState(false);
	const [loginRequired, setLoginRequired] = useState(false);
	const [credentialName, setCredentialName] = useState("");
	const [error, setError] = useState<unknown>(null);
	const [busy, setBusy] = useState(false);
	const [completedDecision, setCompletedDecision] = useState<"approve" | "reject" | null>(null);

	const refresh = useCallback(async () => {
		setError(null);
		if (standalone) {
			try {
				setCredentials(await listApproverCredentials());
				setLoginRequired(false);
			} catch (cause) {
				if (cause instanceof UiApiError && cause.code === "APPROVER_SESSION_INVALID") {
					setLoginRequired(true);
					return;
				}
				setError(cause);
			} finally {
				setLoaded(true);
			}
			return;
		}
		if (!intentId || !publisherDid) {
			setError(new UiApiError("INVALID_REQUEST", 400, "Approval link is incomplete"));
			setLoaded(true);
			return;
		}
		try {
			const [credentialItems, approvalResource] = await Promise.all([
				listApproverCredentials(),
				getApproval(publisherDid, intentId),
			]);
			setCredentials(credentialItems);
			setApproval(approvalResource);
			setLoginRequired(false);
		} catch (cause) {
			if (cause instanceof UiApiError && cause.code === "APPROVER_SESSION_INVALID") {
				setLoginRequired(true);
				return;
			}
			setError(cause);
		} finally {
			setLoaded(true);
		}
	}, [intentId, publisherDid, standalone]);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	async function enrol(event: FormEvent) {
		event.preventDefault();
		setBusy(true);
		setError(null);
		try {
			if (!navigator.credentials) throw new Error("Passkeys are unavailable");
			const options = creationOptions(await beginPasskeyRegistration(credentialName));
			const created = await navigator.credentials.create({ publicKey: options });
			if (!(created instanceof PublicKeyCredential))
				throw new Error("Passkey creation was cancelled");
			await completePasskeyRegistration(registrationResponse(created));
			setCredentialName("");
			await refresh();
		} catch (cause) {
			setError(cause);
		} finally {
			setBusy(false);
		}
	}

	async function decide(decision: "approve" | "reject") {
		setBusy(true);
		setError(null);
		try {
			if (!navigator.credentials) throw new Error("Passkeys are unavailable");
			const options = requestOptions(await beginApprovalDecision(publisherDid, intentId, decision));
			const assertion = await navigator.credentials.get({ publicKey: options });
			if (!(assertion instanceof PublicKeyCredential))
				throw new Error("Passkey request was cancelled");
			await completeApprovalDecision(
				publisherDid,
				intentId,
				decision,
				authenticationResponse(assertion),
			);
			setCompletedDecision(decision);
			await refresh();
		} catch (cause) {
			setError(cause);
		} finally {
			setBusy(false);
		}
	}

	const credentialsPanel = (
		<Surface className="rounded-xl border bg-kumo-base p-6">
			<h2 className="text-xl font-semibold text-kumo-strong">
				{t("approval.credentials.title", "Release approval passkeys")}
			</h2>
			<p className="mt-1 text-sm text-kumo-subtle">
				{t(
					"approval.credentials.description",
					"A passkey confirms it is you when you approve or reject a plugin release.",
				)}
			</p>
			<div className="mt-4 flex flex-wrap gap-2">
				{credentials.map((credential) => (
					<Badge key={credential.id} variant={credential.revokedAt ? "error" : "success"}>
						{credential.name}
					</Badge>
				))}
			</div>
			<form className="mt-5 flex flex-col gap-4 sm:flex-row sm:items-end" onSubmit={enrol}>
				<Input
					className="flex-1"
					label={t("approval.credentials.name", "Passkey name")}
					placeholder={t("approval.credentials.placeholder", "Work laptop")}
					required
					value={credentialName}
					onChange={(event) => setCredentialName(event.currentTarget.value)}
				/>
				<Button loading={busy} type="submit" variant="secondary">
					{t("approval.credentials.enrol", "Add passkey")}
				</Button>
			</form>
		</Surface>
	);

	if (loginRequired) return embedded ? null : <LoginPanel realm="approver" />;
	if (!loaded && !error) return embedded ? null : <LoadingPanel />;
	if (embedded && credentials.length === 0 && !error) return null;
	if (standalone) {
		return (
			<div className="flex flex-col gap-6">
				{error ? <ErrorBanner error={error} /> : null}
				{credentialsPanel}
			</div>
		);
	}
	if (!approval) return <ErrorBanner error={error} />;
	const review = approval.review;
	const none = t("approval.none", "Not available");

	return (
		<div className="flex flex-col gap-6">
			{error ? <ErrorBanner error={error} /> : null}
			{completedDecision ? (
				<Surface className="rounded-xl border bg-kumo-success-tint p-5 text-kumo-success">
					{completedDecision === "approve"
						? t(
								"approval.completed.approve",
								"Approval recorded. The release workflow can continue.",
							)
						: t(
								"approval.completed.reject",
								"Rejection recorded. The release will not be published.",
							)}
				</Surface>
			) : null}
			<Surface className="rounded-xl border bg-kumo-base p-6">
				<div className="flex flex-wrap items-start justify-between gap-4">
					<div>
						<h2 className="text-xl font-semibold text-kumo-strong">
							{t("approval.title", "Review plugin release")}
						</h2>
						<p className="mt-1 text-sm text-kumo-subtle">
							{t("approval.package", "{packageSlug} version {version}", {
								packageSlug: approval.intent.packageSlug,
								version: approval.intent.version,
							})}
						</p>
					</div>
					<Badge variant="warning">{t("approval.required", "Approval needed")}</Badge>
				</div>
				<dl className="mt-6 grid gap-4 sm:grid-cols-2">
					<ReviewItem
						label={t("approval.repository", "Repository")}
						value={detail(review.source.repository, none)}
					/>
					<ReviewItem
						label={t("approval.workflow", "Workflow file")}
						value={detail(workflowFile(review.source.repository, review.source.workflowRef), none)}
					/>
					<ReviewItem
						label={t("approval.actor", "GitHub account")}
						value={detail(review.source.actor, none)}
					/>
				</dl>
				<details className="mt-6 text-sm text-kumo-subtle">
					<summary>{t("approval.technicalDetails", "Technical details")}</summary>
					<dl className="mt-4 grid gap-4 sm:grid-cols-2">
						<ReviewItem
							label={t("approval.publisher", "Publishing account ID")}
							value={publisherDid}
						/>
						<ReviewItem
							label={t("approval.commit", "Git commit")}
							value={detail(review.source.commitSha, none)}
						/>
						<ReviewItem
							label={t("approval.run", "GitHub workflow run")}
							value={detail(review.source.runId, none)}
						/>
						<ReviewItem
							label={t("approval.artifact", "Plugin package checksum")}
							value={review.artifact.checksum}
						/>
						<ReviewItem
							label={t("approval.provenance", "Build record checksum")}
							value={review.provenance?.checksum ?? none}
						/>
						<ReviewItem
							label={t("approval.profileCid", "Plugin profile version")}
							value={String(approval.evidence["profileCid"] ?? none)}
						/>
						<ReviewItem
							label={t("approval.evidenceDigest", "Approval proof")}
							value={approval.evidenceDigest}
						/>
					</dl>
				</details>
			</Surface>

			<Surface className="rounded-xl border bg-kumo-base p-6">
				<div className="flex flex-wrap items-center justify-between gap-3">
					<h2 className="text-xl font-semibold text-kumo-strong">
						{t("approval.access.title", "Plugin permissions")}
					</h2>
					<Badge variant={review.accessDiff.escalation ? "warning" : "neutral"}>
						{review.accessDiff.escalation
							? t("approval.access.escalation", "Permissions increase")
							: t("approval.access.noEscalation", "No permission increase")}
					</Badge>
				</div>
				{review.accessDiff.changes.length === 0 ? (
					<p className="mt-4 text-sm text-kumo-subtle">
						{t(
							"approval.access.empty",
							"This release requests the same plugin permissions as the current release.",
						)}
					</p>
				) : (
					<ul className="mt-4 flex flex-col gap-3">
						{review.accessDiff.changes.map((change) => (
							<li
								className="rounded-lg bg-kumo-tint p-3 text-sm"
								key={`${change.kind}:${change.path.join(".")}`}
							>
								<p className="font-medium text-kumo-strong">{accessChangeLabel(t, change)}</p>
								<details className="mt-1 text-xs text-kumo-subtle">
									<summary>{t("approval.technicalDetails", "Technical details")}</summary>
									<code className="mt-1 block break-all">
										{change.kind}: {change.path.join(".")}
									</code>
								</details>
							</li>
						))}
					</ul>
				)}
			</Surface>

			{credentialsPanel}

			<div className="flex flex-wrap justify-end gap-3">
				<Button
					disabled={credentials.every((credential) => credential.revokedAt !== null)}
					loading={busy}
					onClick={() => decide("reject")}
					variant="secondary-destructive"
				>
					{t("approval.reject", "Reject release")}
				</Button>
				<Button
					disabled={credentials.every((credential) => credential.revokedAt !== null)}
					loading={busy}
					onClick={() => decide("approve")}
					variant="primary"
				>
					{t("approval.approve", "Approve release")}
				</Button>
			</div>
		</div>
	);
}

function ReviewItem({ label, value }: { label: string; value: string }) {
	return (
		<div className="min-w-0">
			<dt className="text-sm text-kumo-subtle">{label}</dt>
			<dd className="mt-1 break-all text-sm text-kumo-default">{value}</dd>
		</div>
	);
}
