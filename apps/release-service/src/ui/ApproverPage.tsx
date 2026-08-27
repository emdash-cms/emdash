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

export function ApproverPage() {
	const t = useT();
	const intentId = location.pathname.startsWith("/approvals/")
		? location.pathname.slice("/approvals/".length)
		: "";
	const publisherDid = new URLSearchParams(location.search).get("publisher") ?? "";
	const [approval, setApproval] = useState<ApprovalResource | null>(null);
	const [credentials, setCredentials] = useState<ApproverCredential[]>([]);
	const [loginRequired, setLoginRequired] = useState(false);
	const [credentialName, setCredentialName] = useState("");
	const [error, setError] = useState<unknown>(null);
	const [busy, setBusy] = useState(false);
	const [completedDecision, setCompletedDecision] = useState<"approve" | "reject" | null>(null);

	const refresh = useCallback(async () => {
		setError(null);
		if (!intentId || !publisherDid) {
			setError(new UiApiError("INVALID_REQUEST", 400, "Approval link is incomplete"));
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
		}
	}, [intentId, publisherDid]);

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

	if (loginRequired) return <LoginPanel realm="approver" />;
	if (!approval && !error) return <LoadingPanel />;
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
							{t("approval.title", "Review delegated release")}
						</h2>
						<p className="mt-1 text-sm text-kumo-subtle">
							{t("approval.package", "{packageSlug} version {version}", {
								packageSlug: approval.intent.packageSlug,
								version: approval.intent.version,
							})}
						</p>
					</div>
					<Badge variant="warning">{t("approval.required", "Approval required")}</Badge>
				</div>
				<dl className="mt-6 grid gap-4 sm:grid-cols-2">
					<ReviewItem label={t("approval.publisher", "Publisher")} value={publisherDid} />
					<ReviewItem
						label={t("approval.repository", "Repository")}
						value={detail(review.source.repository, none)}
					/>
					<ReviewItem
						label={t("approval.workflow", "Workflow")}
						value={detail(review.source.workflowRef, none)}
					/>
					<ReviewItem
						label={t("approval.commit", "Commit")}
						value={detail(review.source.commitSha, none)}
					/>
					<ReviewItem
						label={t("approval.run", "Run ID")}
						value={detail(review.source.runId, none)}
					/>
					<ReviewItem
						label={t("approval.actor", "GitHub actor")}
						value={detail(review.source.actor, none)}
					/>
					<ReviewItem
						label={t("approval.artifact", "Artifact checksum")}
						value={review.artifact.checksum}
					/>
					<ReviewItem
						label={t("approval.provenance", "Provenance checksum")}
						value={review.provenance?.checksum ?? none}
					/>
					<ReviewItem
						label={t("approval.profileCid", "Profile CID")}
						value={String(approval.evidence["profileCid"] ?? none)}
					/>
					<ReviewItem
						label={t("approval.evidenceDigest", "Approval digest")}
						value={approval.evidenceDigest}
					/>
				</dl>
			</Surface>

			<Surface className="rounded-xl border bg-kumo-base p-6">
				<div className="flex flex-wrap items-center justify-between gap-3">
					<h2 className="text-xl font-semibold text-kumo-strong">
						{t("approval.access.title", "Declared access changes")}
					</h2>
					<Badge variant={review.accessDiff.escalation ? "warning" : "neutral"}>
						{review.accessDiff.escalation
							? t("approval.access.escalation", "Escalation")
							: t("approval.access.noEscalation", "No escalation")}
					</Badge>
				</div>
				{review.accessDiff.changes.length === 0 ? (
					<p className="mt-4 text-sm text-kumo-subtle">
						{t("approval.access.empty", "This release does not change declared access.")}
					</p>
				) : (
					<ul className="mt-4 flex flex-col gap-3">
						{review.accessDiff.changes.map((change) => (
							<li
								className="rounded-lg bg-kumo-tint p-3 text-sm"
								key={`${change.kind}:${change.path.join(".")}`}
							>
								<p className="font-medium text-kumo-strong">
									{t("approval.access.change", "{kind}: {category}", {
										kind: change.kind,
										category: change.category,
									})}
								</p>
								{change.operation ? (
									<p className="mt-1 text-kumo-subtle">
										{t("approval.access.operation", "Operation: {operation}", {
											operation: change.operation,
										})}
									</p>
								) : null}
							</li>
						))}
					</ul>
				)}
			</Surface>

			<Surface className="rounded-xl border bg-kumo-base p-6">
				<h2 className="text-xl font-semibold text-kumo-strong">
					{t("approval.credentials.title", "Approver passkeys")}
				</h2>
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
						{t("approval.credentials.enrol", "Enrol passkey")}
					</Button>
				</form>
			</Surface>

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
