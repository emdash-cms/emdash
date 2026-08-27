import {
	Badge,
	Banner,
	Button,
	Dialog,
	Empty,
	Field,
	Input,
	InputArea,
	LayerCard,
	Loader,
	Select,
	useKumoToastManager,
} from "@cloudflare/kumo";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { ClipboardText, Flask, Pulse, WarningCircle } from "@phosphor-icons/react";
import React from "react";

import {
	assessmentAction,
	assessmentMediaUrl,
	getActivity,
	getAssessment,
	getAssessments,
	getEvaluation,
	getEvaluations,
	getHealth,
	getIssuance,
	getSession,
	setIssuance,
	setTakedown,
	startEvaluation,
	type ActivityItem,
	type AssessmentDetail,
	type AssessmentListItem,
	type AssessmentState,
	type EvaluationListItem,
	type HealthStatus,
	type OperatorSession,
	type Page as ApiPage,
} from "./api.js";

type View = "overview" | "assessments" | "takedowns" | "issuance" | "evaluations" | "activity";
const ADMIN_VIEWS = new Set<View>(["takedowns", "issuance", "evaluations", "activity"]);
const SLUG_SEPARATOR_RE = /[-_]/;
const EVAL_CASES_RE = /Cases: ([0-9]+); repeats: ([0-9]+)/;
const EVAL_UNSAFE_PASSES_RE = /Observed unsafe passes: ([0-9]+)/;
const EVAL_MISMATCHES_RE = /Expected-outcome mismatches: ([0-9]+)/;
const EVAL_INVALID_OUTPUTS_RE = /Invalid outputs: ([0-9]+)/;
const EVAL_MODEL_ERRORS_RE = /model errors: ([0-9]+)/;
const EVAL_P95_RE = /P95 latency: ([0-9]+ms)/;

export function App() {
	const { t } = useLingui();
	const [route, navigate] = useRoute();
	const session = useResource(getSession, []);
	const health = useResource(getHealth, []);

	React.useEffect(() => {
		document.title = t`EmDash labeler`;
	}, [t]);

	if (session.loading) return <CenteredLoader label={t`Loading operator session`} />;
	if (session.error || !session.data) {
		return (
			<main className="mx-auto flex min-h-screen max-w-2xl items-center p-6">
				<Banner
					variant="error"
					icon={<WarningCircle weight="fill" />}
					title={t`Operator session unavailable`}
					description={
						session.error?.message ?? t`Sign in through Cloudflare Access and try again.`
					}
				/>
			</main>
		);
	}

	const activeView = viewFromPath(route);
	const isAdmin = session.data.identity.roles.includes("admin");
	const navigation: Array<{ view: View; label: string; admin?: boolean }> = [
		{ view: "overview", label: t`Overview` },
		{ view: "assessments", label: t`Review` },
		{ view: "takedowns", label: t`Takedowns`, admin: true },
		{ view: "issuance", label: t`Issuance`, admin: true },
		{ view: "evaluations", label: t`Evaluations`, admin: true },
		{ view: "activity", label: t`Activity`, admin: true },
	];

	return (
		<div className="min-h-screen bg-kumo-canvas text-kumo-default">
			<header className="border-b bg-kumo-base">
				<div className="mx-auto flex max-w-[1400px] items-center justify-between gap-4 px-4 py-3 sm:px-6">
					<p className="font-semibold">
						<Trans>EmDash registry</Trans>{" "}
						<span className="ms-2 font-normal text-kumo-subtle">
							<Trans>Labeler</Trans>
						</span>
					</p>
					<p className="truncate text-sm text-kumo-subtle">
						{session.data.identity.principal} ·{" "}
						{roleLabel(t, session.data.identity.roles[0] ?? "reviewer")}
					</p>
				</div>
				<nav
					aria-label={t`Operator navigation`}
					className="mx-auto flex max-w-[1400px] gap-1 overflow-x-auto px-4 pb-2 sm:px-6"
				>
					{navigation
						.filter((item) => !item.admin || isAdmin)
						.map((item) => (
							<Button
								key={item.view}
								size="sm"
								variant={activeView === item.view ? "primary" : "ghost"}
								className="shrink-0"
								onClick={() => navigate(pathForView(item.view))}
							>
								{item.label}
							</Button>
						))}
				</nav>
			</header>
			<main className="mx-auto max-w-[1400px] px-4 py-6 sm:px-6">
				{renderView(activeView, route, navigate, session.data, health)}
			</main>
		</div>
	);
}

function renderView(
	view: View,
	path: string,
	navigate: (path: string) => void,
	session: OperatorSession,
	health: Resource<HealthStatus>,
) {
	if (ADMIN_VIEWS.has(view) && !session.identity.roles.includes("admin")) {
		return <AdministratorRoleRequired />;
	}
	if (view === "overview")
		return (
			<Overview
				health={health}
				navigate={navigate}
				isAdmin={session.identity.roles.includes("admin")}
			/>
		);
	if (view === "assessments") {
		const prefix = "/_admin/assessments/";
		return (
			<ReviewWorkspace
				initialRunKey={
					path.startsWith(prefix) ? decodeURIComponent(path.slice(prefix.length)) : undefined
				}
				navigate={navigate}
			/>
		);
	}
	if (view === "takedowns") return <TakedownsView />;
	if (view === "issuance") return <IssuanceView />;
	if (view === "evaluations") return <EvaluationsView />;
	return <ActivityView session={session} />;
}

function AdministratorRoleRequired() {
	const { t } = useLingui();
	return (
		<Banner
			variant="error"
			title={t`Administrator role required`}
			description={t`This console is not available to your operator role.`}
		/>
	);
}

function Overview({
	health,
	navigate,
	isAdmin,
}: {
	health: Resource<HealthStatus>;
	navigate: (path: string) => void;
	isAdmin: boolean;
}) {
	const { t } = useLingui();
	const reviews = useResource(() => getAssessments("review"), []);
	const errors = useResource(() => getAssessments("error"), []);
	const evaluations = useResource(
		() => (isAdmin ? getEvaluations() : Promise.resolve({ items: [] })),
		[isAdmin],
	);
	const issuance = useResource(getIssuance, []);
	const latestEvaluation = evaluations.data?.items[0];
	return (
		<Page
			title={t`Overview`}
			description={t`What needs attention and whether the service is healthy.`}
		>
			{health.error && (
				<Banner variant="error" title={t`Health check failed`} description={health.error.message} />
			)}
			<div className="grid gap-4 lg:grid-cols-[minmax(0,1.15fr)_minmax(260px,0.85fr)]">
				<LayerCard className="p-0">
					<SectionHeading>
						<Trans>Needs attention</Trans>
					</SectionHeading>
					<AttentionRow
						label={t`Listings awaiting review`}
						value={pageCount(reviews.data)}
						onClick={() => navigate("/_admin/assessments")}
					/>
					<AttentionRow
						label={t`Assessment errors`}
						value={pageCount(errors.data)}
						onClick={() => navigate("/_admin/assessments?state=error")}
					/>
					{isAdmin && (
						<AttentionRow
							label={t`Latest evaluation`}
							value={
								latestEvaluation
									? latestEvaluation.status === "failed"
										? t`Run failed`
										: latestEvaluation.status === "running"
											? t`Running`
											: latestEvaluation.budget_passed === 1
												? t`Passed gates`
												: t`Failed gates`
									: t`None`
							}
							onClick={() => navigate("/_admin/evaluations")}
						/>
					)}
				</LayerCard>
				<LayerCard className="p-0">
					<SectionHeading>
						<Trans>Service</Trans>
					</SectionHeading>
					<ServiceRow
						label={t`Issuance`}
						ready={issuance.data?.paused === false}
						value={issuance.data?.paused ? t`Paused` : t`Active`}
					/>
					<ServiceRow
						label={t`Discovery`}
						ready={health.data?.discovery.ready === true}
						value={health.data?.discovery.ready === true ? t`Connected` : t`Not ready`}
					/>
					<ServiceRow
						label={t`Signing`}
						ready={health.data?.signing.ready === true}
						value={health.data?.signing.ready === true ? t`Ready` : t`Not ready`}
					/>
				</LayerCard>
			</div>
		</Page>
	);
}

function AttentionRow({
	label,
	value,
	onClick,
}: {
	label: string;
	value: string;
	onClick: () => void;
}) {
	return (
		<button
			type="button"
			className="flex w-full items-center justify-between gap-4 border-b px-4 py-4 text-start last:border-b-0 hover:bg-kumo-tint"
			onClick={onClick}
		>
			<span>{label}</span>
			<strong className="text-lg font-semibold">{value}</strong>
		</button>
	);
}

function ServiceRow({ label, ready, value }: { label: string; ready: boolean; value: string }) {
	return (
		<div className="flex items-center justify-between gap-4 border-b px-4 py-3 text-sm last:border-b-0">
			<span>{label}</span>
			<Badge variant={ready ? "success" : "warning"} appearance="dot">
				{value}
			</Badge>
		</div>
	);
}

function ReviewWorkspace({
	initialRunKey,
	navigate,
}: {
	initialRunKey?: string;
	navigate: (path: string) => void;
}) {
	const { t } = useLingui();
	const initialState = stateFromLocation();
	const [state, setState] = React.useState<AssessmentState>(initialState);
	const stateRef = React.useRef(state);
	const list = useResource(() => getAssessments(state), [state]);
	const [items, setItems] = React.useState<AssessmentListItem[]>([]);
	const [nextCursor, setNextCursor] = React.useState<string | undefined>();
	const [selectedRunKey, setSelectedRunKey] = React.useState(initialRunKey ?? "");

	React.useEffect(() => {
		if (!list.data) return;
		setItems(list.data.items);
		setNextCursor(list.data.nextCursor);
		if (!selectedRunKey && list.data.items[0]) setSelectedRunKey(list.data.items[0].run_key);
	}, [list.data, selectedRunKey]);
	React.useEffect(() => {
		if (initialRunKey) setSelectedRunKey(initialRunKey);
	}, [initialRunKey]);

	const detail = useResource<AssessmentDetail | null>(
		() => (selectedRunKey ? getAssessment(selectedRunKey) : Promise.resolve(null)),
		[selectedRunKey],
	);
	const selectedItem =
		items.find((item) => item.run_key === selectedRunKey) ??
		(detail.data ? detailToListItem(detail.data) : undefined);
	const stateItems = Object.fromEntries(
		assessmentStates.map((value) => [value, stateLabel(t, value)]),
	);

	return (
		<Page
			title={t`Review queue`}
			description={t`${items.length}${nextCursor ? "+" : ""} in ${stateLabel(t, state).toLowerCase()} · oldest first`}
			actions={
				<Select
					aria-label={t`Assessment state`}
					value={state}
					onValueChange={(value) => {
						if (!value || !isAssessmentState(value)) return;
						stateRef.current = value;
						setState(value);
						setSelectedRunKey("");
						navigate(`/_admin/assessments?state=${value}`);
					}}
					items={stateItems}
					size="sm"
					className="w-48"
				/>
			}
		>
			{list.error && (
				<Banner
					variant="error"
					title={t`Assessments unavailable`}
					description={list.error.message}
				/>
			)}
			{list.loading ? (
				<CenteredLoader label={t`Loading assessments`} />
			) : items.length === 0 ? (
				<Empty
					title={t`No assessments`}
					description={t`There are no assessments in this state.`}
					icon={<ClipboardText size={42} />}
				/>
			) : (
				<LayerCard className="overflow-hidden p-0">
					<div className="grid min-w-0 lg:grid-cols-[280px_minmax(0,1fr)]">
						<aside
							className="border-b bg-kumo-recessed lg:border-b-0 lg:border-e"
							aria-label={t`Assessment queue`}
						>
							<div className="flex overflow-x-auto lg:block">
								{items.map((item) => {
									const identity = assessmentListIdentity(item);
									return (
										<button
											key={item.run_key}
											type="button"
											aria-current={item.run_key === selectedRunKey ? "true" : undefined}
											className="min-w-56 border-e px-4 py-3 text-start hover:bg-kumo-tint aria-current:bg-kumo-info-tint lg:block lg:min-w-0 lg:w-full lg:border-e-0 lg:border-b"
											onClick={() => {
												setSelectedRunKey(item.run_key);
												navigate(`/_admin/assessments/${encodeURIComponent(item.run_key)}`);
											}}
										>
											<span className="block truncate text-sm font-medium">{identity.name}</span>
											<span className="mt-1 block truncate text-xs text-kumo-subtle">
												{item.subject_kind === "release"
													? t`Release ${identity.version ?? ""}`
													: t`Profile`}
											</span>
										</button>
									);
								})}
							</div>
							{nextCursor && (
								<LoadMore
									compact
									onLoad={async () => {
										const requestedState = state;
										const page = await getAssessments(state, nextCursor);
										if (stateRef.current !== requestedState) return;
										setItems((current) => [...current, ...page.items]);
										setNextCursor(page.nextCursor);
									}}
								/>
							)}
						</aside>
						<section className="min-w-0">
							{detail.loading ? (
								<CenteredLoader label={t`Loading assessment`} />
							) : detail.error ? (
								<Banner
									variant="error"
									title={t`Assessment unavailable`}
									description={detail.error.message}
								/>
							) : detail.data && selectedItem ? (
								<AssessmentReview
									detail={detail.data}
									item={selectedItem}
									items={items}
									navigate={navigate}
									refreshList={list.refresh}
									refreshDetail={detail.refresh}
								/>
							) : null}
						</section>
					</div>
				</LayerCard>
			)}
		</Page>
	);
}

function AssessmentReview({
	detail,
	item,
	items,
	navigate,
	refreshList,
	refreshDetail,
}: {
	detail: AssessmentDetail;
	item: AssessmentListItem;
	items: AssessmentListItem[];
	navigate: (path: string) => void;
	refreshList: () => void;
	refreshDetail: () => void;
}) {
	const { t } = useLingui();
	const toast = useKumoToastManager();
	const [evidenceOpen, setEvidenceOpen] = React.useState(false);
	const [technicalOpen, setTechnicalOpen] = React.useState(false);
	const [pendingAction, setPendingAction] = React.useState<"approve" | "block" | "rerun" | null>(
		null,
	);
	const preview = listingPreview(detail);
	const previewType =
		preview.kind === "release" ? t`Release ${preview.version ?? ""}` : t`Publisher profile`;
	const previewMeta =
		preview.kind === "release" ? t`${previewType} · ${preview.slug}` : t`Profile · ${preview.slug}`;
	const findings = detail.findings ?? [];
	const reasonCodes = stringArray(recordValue(detail.assessment.summary, "reasonCodes"));
	const advance = () => {
		refreshList();
		refreshDetail();
		const index = items.findIndex((candidate) => candidate.run_key === item.run_key);
		const next = items[index + 1] ?? items[index - 1];
		if (next) navigate(`/_admin/assessments/${encodeURIComponent(next.run_key)}`);
	};
	return (
		<>
			<header className="flex flex-wrap items-start justify-between gap-3 border-b px-5 py-4">
				<div>
					<h2 className="text-lg font-semibold">{preview.name}</h2>
					<p className="mt-1 text-xs text-kumo-subtle">{previewMeta}</p>
				</div>
				<StateBadge state={item.state} />
			</header>
			<div className="p-5">
				<p className="mb-2 text-xs font-medium text-kumo-subtle">
					<Trans>Marketplace preview</Trans>
				</p>
				<ListingPreviewCard preview={preview} runKey={item.run_key} />
				<div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-y py-3 text-sm">
					<div>
						<strong>
							{findings.length === 0 ? t`No model findings` : t`${findings.length} model findings`}
						</strong>
						<span className="ms-2 text-kumo-subtle">
							{reasonCodes.includes("manual-positive-required")
								? t`Manual approval required`
								: t`Operator decision required`}
						</span>
					</div>
					<div className="flex gap-1">
						<Button size="sm" variant="ghost" onClick={() => setEvidenceOpen((open) => !open)}>
							{evidenceOpen ? t`Hide assessment` : t`Show assessment`}
						</Button>
						<Button size="sm" variant="ghost" onClick={() => setTechnicalOpen((open) => !open)}>
							{technicalOpen ? t`Hide technical details` : t`Technical details`}
						</Button>
					</div>
				</div>
				{evidenceOpen && (
					<AssessmentEvidence detail={detail} findings={findings} reasonCodes={reasonCodes} />
				)}
				{technicalOpen && (
					<pre className="mt-3 max-h-80 overflow-auto rounded-lg bg-kumo-recessed p-4 text-xs">
						{JSON.stringify(
							{ assessment: detail.assessment, canonicalInput: detail.assessment.canonicalInput },
							null,
							2,
						)}
					</pre>
				)}
			</div>
			<footer className="flex flex-wrap justify-end gap-2 border-t bg-kumo-recessed px-5 py-3">
				{canBlock(item.state) && (
					<ActionDialog
						label={t`Block`}
						title={t`Block exact revision`}
						description={t`Block only this exact listing revision.`}
						variant="destructive"
						open={pendingAction === "block"}
						onOpenChange={(open) => setPendingAction(open ? "block" : null)}
						onConfirm={(reason) => assessmentAction(item, "block", reason)}
						onSuccess={() => {
							advance();
							toast.add({ title: t`Assessment blocked`, variant: "success" });
						}}
					/>
				)}
				{canRerun(item.state) && (
					<ActionDialog
						label={t`Rerun`}
						title={t`Rerun assessment`}
						description={t`Create a fresh assessment for this exact revision.`}
						open={pendingAction === "rerun"}
						onOpenChange={(open) => setPendingAction(open ? "rerun" : null)}
						onConfirm={(reason) => assessmentAction(item, "rerun", reason)}
						onSuccess={() => {
							advance();
							toast.add({ title: t`Assessment rerun started`, variant: "success" });
						}}
					/>
				)}
				{canApprove(item.state) && (
					<ActionDialog
						label={t`Approve and next`}
						title={t`Approve exact revision`}
						description={t`Approve only this exact listing revision, then continue to the next item.`}
						variant="primary"
						reasonOptional
						open={pendingAction === "approve"}
						onOpenChange={(open) => setPendingAction(open ? "approve" : null)}
						onConfirm={(reason) => assessmentAction(item, "approve", reason)}
						onSuccess={() => {
							advance();
							toast.add({ title: t`Assessment approved`, variant: "success" });
						}}
					/>
				)}
			</footer>
		</>
	);
}

function ListingPreviewCard({ preview, runKey }: { preview: ListingPreview; runKey: string }) {
	const { t } = useLingui();
	const previewType =
		preview.kind === "release" ? t`Release ${preview.version ?? ""}` : t`Publisher profile`;
	return (
		<LayerCard className="p-0">
			<div className="flex gap-3 p-4">
				<div className="grid size-12 shrink-0 place-items-center rounded-lg bg-kumo-brand font-semibold text-white">
					{preview.name.slice(0, 1).toUpperCase()}
				</div>
				<div className="min-w-0">
					<h3 className="font-semibold">{preview.name}</h3>
					<p className="mt-1 text-xs text-kumo-subtle">
						{preview.publisher && preview.publisherHandle
							? t`By ${preview.publisher} · @${preview.publisherHandle}`
							: preview.publisher
								? t`By ${preview.publisher}`
								: preview.publisherHandle
									? `@${preview.publisherHandle}`
									: t`Publisher`}
					</p>
					<Badge className="mt-2" variant="outline">
						{previewType}
					</Badge>
				</div>
			</div>
			{preview.description && <p className="px-4 pb-4 text-sm leading-6">{preview.description}</p>}
			{preview.media.length > 0 ? (
				<div className="grid gap-3 border-t p-4 sm:grid-cols-2">
					{preview.media.map((media) => (
						<figure
							key={`${media.kind}-${media.index}`}
							className="overflow-hidden rounded-lg bg-kumo-recessed"
						>
							<img
								className="aspect-video w-full object-contain"
								src={assessmentMediaUrl(runKey, media.kind, media.index)}
								alt={t`Submitted ${media.kind}`}
							/>
							<figcaption className="px-3 py-2 text-xs text-kumo-subtle">{media.kind}</figcaption>
						</figure>
					))}
				</div>
			) : (
				<div className="border-t px-4 py-5 text-center text-xs text-kumo-subtle">
					<Trans>No marketplace media submitted</Trans>
				</div>
			)}
			<div className="flex flex-wrap gap-2 border-t px-4 py-3 text-xs text-kumo-subtle">
				{preview.license && <span>{t`License: ${preview.license}`}</span>}
				{preview.keywords.length > 0 && <span>{preview.keywords.join(" · ")}</span>}
			</div>
		</LayerCard>
	);
}

function AssessmentEvidence({
	detail,
	findings,
	reasonCodes,
}: {
	detail: AssessmentDetail;
	findings: NonNullable<AssessmentDetail["findings"]>;
	reasonCodes: string[];
}) {
	const { t } = useLingui();
	const coverage = detail.assessment.coverage;
	return (
		<div className="mt-3 grid gap-2">
			{findings.map((finding) => (
				<div
					key={`${finding.finding_index}-${finding.reason_code}`}
					className="border-s-2 border-kumo-warning py-2 ps-3"
				>
					<p className="text-sm font-medium">{finding.public_summary}</p>
					<p className="mt-1 text-xs text-kumo-subtle">
						{finding.category} · {finding.reason_code}
						{finding.confidence === null ? "" : ` · ${Math.round(finding.confidence * 100)}%`}
					</p>
				</div>
			))}
			{findings.length === 0 && (
				<div className="border-s-2 border-kumo-success py-2 ps-3">
					<p className="text-sm font-medium">
						<Trans>No model findings</Trans>
					</p>
					<p className="mt-1 text-xs text-kumo-subtle">
						<Trans>The model completed without flagging the submitted listing.</Trans>
					</p>
				</div>
			)}
			<div className="border-s-2 border-kumo-line py-2 ps-3">
				<p className="text-sm font-medium">
					<Trans>Policy</Trans>
				</p>
				<p className="mt-1 text-xs text-kumo-subtle">
					{reasonCodes.length > 0 ? reasonCodes.join(", ") : t`No policy reason code recorded`}
				</p>
			</div>
			{coverage != null && (
				<div className="border-s-2 border-kumo-line py-2 ps-3">
					<p className="text-sm font-medium">
						<Trans>Coverage</Trans>
					</p>
					<p className="mt-1 text-xs text-kumo-subtle">{coverageSummary(coverage)}</p>
				</div>
			)}
		</div>
	);
}

function TakedownsView() {
	const { t } = useLingui();
	const activity = useResource(getActivity, []);
	const toast = useKumoToastManager();
	const [dialog, setDialog] = React.useState<{ open: boolean; uri?: string }>({ open: false });
	const active = activeTakedowns(activity.data?.items ?? []);
	return (
		<Page
			title={t`Takedowns`}
			description={t`Emergency listing and publisher removals.`}
			actions={
				<Button variant="primary" onClick={() => setDialog({ open: true })}>
					<Trans>Issue takedown</Trans>
				</Button>
			}
		>
			{activity.error && (
				<Banner
					variant="error"
					title={t`Takedowns unavailable`}
					description={activity.error.message}
				/>
			)}
			{activity.loading ? (
				<CenteredLoader label={t`Loading takedowns`} />
			) : active.length === 0 ? (
				<Empty
					title={t`No active takedowns`}
					description={t`Emergency takedowns will appear here with their reason and current state.`}
					icon={<ClipboardText size={42} />}
				/>
			) : (
				<LayerCard className="p-0">
					{active.map((item) => (
						<ListRow
							key={item.id}
							title={
								item.subject_uri?.startsWith("did:")
									? t`Publisher`
									: (subjectLabel(item.subject_uri) ?? t`Service`)
							}
							meta={`${item.reason} · ${formatDate(item.created_at)}`}
							action={
								<Button
									size="sm"
									onClick={() => setDialog({ open: true, uri: item.subject_uri ?? undefined })}
								>
									<Trans>Retract</Trans>
								</Button>
							}
						/>
					))}
				</LayerCard>
			)}
			<TakedownDialog
				open={dialog.open}
				uri={dialog.uri}
				onOpenChange={(open) => setDialog((current) => ({ ...current, open }))}
				onSuccess={() => {
					activity.refresh();
					toast.add({
						title: dialog.uri ? t`Takedown retracted` : t`Takedown issued`,
						variant: "success",
					});
				}}
			/>
		</Page>
	);
}

function TakedownDialog({
	open,
	uri: initialUri,
	onOpenChange,
	onSuccess,
}: {
	open: boolean;
	uri?: string;
	onOpenChange: (open: boolean) => void;
	onSuccess: () => void;
}) {
	const { t } = useLingui();
	const [uri, setUri] = React.useState(initialUri ?? "");
	const [reason, setReason] = React.useState("");
	const [submitting, setSubmitting] = React.useState(false);
	const [error, setError] = React.useState<Error | null>(null);
	React.useEffect(() => {
		setUri(initialUri ?? "");
	}, [initialUri]);
	const retract = Boolean(initialUri);
	return (
		<Dialog.Root open={open} onOpenChange={onOpenChange} role={retract ? "dialog" : "alertdialog"}>
			<Dialog className="p-6">
				<form
					onSubmit={async (event) => {
						event.preventDefault();
						setSubmitting(true);
						setError(null);
						try {
							await setTakedown(uri, retract, reason);
							setReason("");
							onOpenChange(false);
							onSuccess();
						} catch (caught) {
							setError(toError(caught, t`Action failed`));
						} finally {
							setSubmitting(false);
						}
					}}
				>
					<Dialog.Title className="text-xl font-semibold">
						{retract ? t`Retract takedown` : t`Issue takedown`}
					</Dialog.Title>
					<Dialog.Description className="mt-2 text-kumo-subtle">
						{retract
							? t`Remove the active takedown for this subject.`
							: t`Hide a listing URI or every listing from a publisher DID.`}
					</Dialog.Description>
					<div className="mt-5 grid gap-4">
						<Input
							label={t`Subject URI or DID`}
							value={uri}
							onChange={(event) => setUri(event.currentTarget.value)}
							disabled={retract}
							required
						/>
						<Field label={t`Reason`}>
							<InputArea
								aria-label={t`Reason`}
								value={reason}
								onChange={(event) => setReason(event.currentTarget.value)}
								rows={4}
								required
							/>
						</Field>
					</div>
					{error && (
						<Banner
							className="mt-4"
							variant="error"
							title={t`Action failed`}
							description={error.message}
						/>
					)}
					<DialogActions
						disabled={!uri || !reason.trim()}
						loading={submitting}
						label={retract ? t`Retract takedown` : t`Issue takedown`}
					/>
				</form>
			</Dialog>
		</Dialog.Root>
	);
}

function IssuanceView() {
	const { t } = useLingui();
	const status = useResource(getIssuance, []);
	const activity = useResource(getActivity, []);
	const toast = useKumoToastManager();
	const [dialogOpen, setDialogOpen] = React.useState(false);
	const changes = (activity.data?.items ?? []).filter(
		(item) => item.action === "pause-issuance" || item.action === "resume-issuance",
	);
	return (
		<Page title={t`Issuance`} description={t`Global control for new label issuance.`}>
			{status.error && (
				<Banner
					variant="error"
					title={t`Issuance status unavailable`}
					description={status.error.message}
				/>
			)}
			{status.loading ? (
				<CenteredLoader label={t`Loading issuance status`} />
			) : (
				status.data && (
					<>
						<LayerCard className="flex flex-wrap items-center justify-between gap-5 p-6">
							<div>
								<div className="flex items-center gap-2 text-xl font-semibold">
									<Badge variant={status.data.paused ? "warning" : "success"} appearance="dot">
										{status.data.paused ? t`Paused` : t`Active`}
									</Badge>
								</div>
								<p className="mt-2 text-sm text-kumo-subtle">
									{status.data.paused
										? t`New labels will not be issued until an administrator resumes issuance.`
										: t`Assessments and operator decisions can issue labels normally.`}
								</p>
							</div>
							<ActionDialog
								label={status.data.paused ? t`Resume issuance` : t`Pause issuance`}
								title={status.data.paused ? t`Resume label issuance` : t`Pause label issuance`}
								description={
									status.data.paused
										? t`New label issuance will resume.`
										: t`All new label issuance will stop until an administrator resumes it.`
								}
								variant={status.data.paused ? "primary" : "destructive"}
								open={dialogOpen}
								onOpenChange={setDialogOpen}
								onConfirm={(reason) => setIssuance(!status.data!.paused, reason)}
								onSuccess={() => {
									status.refresh();
									activity.refresh();
									toast.add({
										title: status.data!.paused ? t`Issuance resumed` : t`Issuance paused`,
										variant: "success",
									});
								}}
							/>
						</LayerCard>
						<LayerCard className="mt-4 p-0">
							{changes.length === 0 ? (
								<ListRow
									title={t`No control action recorded`}
									meta={t`Issuance has remained active since this state was initialized.`}
								/>
							) : (
								changes.map((item) => (
									<ListRow
										key={item.id}
										title={actionLabel(t, item.action)}
										meta={`${item.reason} · ${formatDate(item.created_at)}`}
									/>
								))
							)}
						</LayerCard>
					</>
				)
			)}
		</Page>
	);
}

function EvaluationsView() {
	const { t } = useLingui();
	const resource = useResource(getEvaluations, []);
	const [items, setItems] = React.useState<EvaluationListItem[]>([]);
	const [nextCursor, setNextCursor] = React.useState<string | undefined>();
	const [selected, setSelected] = React.useState<Record<string, unknown> | null>(null);
	const [runOpen, setRunOpen] = React.useState(false);
	const toast = useKumoToastManager();
	React.useEffect(() => {
		if (resource.data) {
			setItems(resource.data.items);
			setNextCursor(resource.data.nextCursor);
		}
	}, [resource.data]);
	return (
		<Page
			title={t`Evaluations`}
			description={t`Protected model runs and promotion evidence.`}
			actions={
				<ActionDialog
					label={t`Start evaluation`}
					title={t`Start protected evaluation`}
					description={t`Run the protected suite against the current production model bundle.`}
					variant="primary"
					open={runOpen}
					onOpenChange={setRunOpen}
					onConfirm={startEvaluation}
					onSuccess={() => {
						resource.refresh();
						toast.add({ title: t`Evaluation started`, variant: "success" });
					}}
				/>
			}
		>
			{resource.error && (
				<Banner
					variant="error"
					title={t`Evaluations unavailable`}
					description={resource.error.message}
				/>
			)}
			{resource.loading ? (
				<CenteredLoader label={t`Loading evaluations`} />
			) : items.length === 0 ? (
				<Empty
					title={t`No evaluations`}
					description={t`No protected evaluation has been started.`}
					icon={<Flask size={42} />}
				/>
			) : (
				<LayerCard className="p-0">
					{items.map((item) => (
						<React.Fragment key={item.id}>
							<ListRow
								title={t`Run #${item.id}`}
								meta={`${item.reason} · ${formatDate(item.created_at)}`}
								status={<EvaluationStatus item={item} />}
								action={
									<Button
										size="sm"
										onClick={async () => {
											try {
												setSelected(await getEvaluation(item.id));
											} catch (caught) {
												toast.add({
													title: t`Evaluation unavailable`,
													content: toError(caught, t`Request failed`).message,
													variant: "error",
												});
											}
										}}
									>
										<Trans>View</Trans>
									</Button>
								}
							/>
							{selected && numberValue(selected, "runId") === item.id && (
								<EvaluationDetail value={selected} />
							)}
						</React.Fragment>
					))}
				</LayerCard>
			)}
			{nextCursor && (
				<LoadMore
					onLoad={async () => {
						const page = await getEvaluations(nextCursor);
						setItems((current) => [...current, ...page.items]);
						setNextCursor(page.nextCursor);
					}}
				/>
			)}
		</Page>
	);
}

function EvaluationStatus({ item }: { item: EvaluationListItem }) {
	const { t } = useLingui();
	if (item.status === "failed")
		return (
			<Badge variant="error" appearance="dot">
				<Trans>Run failed</Trans>
			</Badge>
		);
	if (item.status === "running")
		return (
			<Badge variant="warning" appearance="dot">
				<Trans>Running</Trans>
			</Badge>
		);
	return (
		<Badge variant={item.budget_passed === 1 ? "success" : "error"} appearance="dot">
			{item.budget_passed === 1 ? t`Passed gates` : t`Failed gates`}
		</Badge>
	);
}

function EvaluationDetail({ value }: { value: Record<string, unknown> }) {
	const { t } = useLingui();
	const metrics = evaluationMetrics(value);
	return (
		<div className="grid gap-4 border-t bg-kumo-recessed p-4 sm:grid-cols-2 lg:grid-cols-5">
			{metrics.map(([label, result]) => (
				<div key={label}>
					<p className="text-xs text-kumo-subtle">{evaluationMetricLabel(t, label)}</p>
					<p className="mt-1 font-semibold">{result}</p>
				</div>
			))}
			{metrics.length === 0 && (
				<p className="text-sm text-kumo-subtle">{t`No completed evaluation metrics are available.`}</p>
			)}
		</div>
	);
}

function ActivityView({ session }: { session: OperatorSession }) {
	const { t } = useLingui();
	const resource = useResource(getActivity, []);
	const [items, setItems] = React.useState<ActivityItem[]>([]);
	const [nextCursor, setNextCursor] = React.useState<string | undefined>();
	React.useEffect(() => {
		if (resource.data) {
			setItems(resource.data.items);
			setNextCursor(resource.data.nextCursor);
		}
	}, [resource.data]);
	return (
		<Page title={t`Activity`} description={t`Immutable operator decisions and service controls.`}>
			{resource.error && (
				<Banner
					variant="error"
					title={t`Activity unavailable`}
					description={resource.error.message}
				/>
			)}
			{resource.loading ? (
				<CenteredLoader label={t`Loading operator activity`} />
			) : items.length === 0 ? (
				<Empty
					title={t`No activity`}
					description={t`No operator action has been recorded.`}
					icon={<Pulse size={42} />}
				/>
			) : (
				<div className="relative ps-7 before:absolute before:inset-y-2 before:start-2 before:w-px before:bg-kumo-line">
					{items.map((item) => (
						<div
							key={item.id}
							className="relative pb-5 before:absolute before:start-[-1.45rem] before:top-1.5 before:size-2 before:rounded-full before:bg-kumo-subtle"
						>
							<p className="text-sm">
								<ActivityEventText item={item} session={session} />
							</p>
							<p className="mt-1 text-xs text-kumo-subtle">
								{item.reason} · {formatDate(item.created_at)}
							</p>
						</div>
					))}
				</div>
			)}
			{nextCursor && (
				<LoadMore
					onLoad={async () => {
						const page = await getActivity(nextCursor);
						setItems((current) => [...current, ...page.items]);
						setNextCursor(page.nextCursor);
					}}
				/>
			)}
		</Page>
	);
}

function ListRow({
	title,
	meta,
	status,
	action,
}: {
	title: React.ReactNode;
	meta: React.ReactNode;
	status?: React.ReactNode;
	action?: React.ReactNode;
}) {
	return (
		<div className="flex flex-wrap items-center justify-between gap-4 border-b px-4 py-3 last:border-b-0">
			<div className="min-w-0 flex-1">
				<p className="text-sm font-medium">{title}</p>
				<p className="mt-1 text-xs text-kumo-subtle">{meta}</p>
			</div>
			{status}
			{action}
		</div>
	);
}

function SectionHeading({ children }: { children: React.ReactNode }) {
	return (
		<div className="border-b px-4 py-3 text-xs font-semibold uppercase tracking-wide text-kumo-subtle">
			{children}
		</div>
	);
}

function ActionDialog(props: {
	label: string;
	title: string;
	description: string;
	variant?: "primary" | "destructive" | "secondary";
	reasonOptional?: boolean;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onConfirm: (reason: string) => Promise<unknown>;
	onSuccess: () => void;
}) {
	const { t } = useLingui();
	const [reason, setReason] = React.useState("");
	const [submitting, setSubmitting] = React.useState(false);
	const [error, setError] = React.useState<Error | null>(null);
	const reasonLabel = props.reasonOptional ? t`Note (optional)` : t`Reason`;
	return (
		<Dialog.Root
			open={props.open}
			onOpenChange={props.onOpenChange}
			role={props.variant === "destructive" ? "alertdialog" : "dialog"}
		>
			<Dialog.Trigger
				render={(triggerProps) => (
					<Button {...triggerProps} variant={props.variant}>
						{props.label}
					</Button>
				)}
			/>
			<Dialog className="p-6">
				<form
					onSubmit={async (event) => {
						event.preventDefault();
						setSubmitting(true);
						setError(null);
						try {
							await props.onConfirm(reason);
							setReason("");
							props.onOpenChange(false);
							props.onSuccess();
						} catch (caught) {
							setError(toError(caught, t`Action failed`));
						} finally {
							setSubmitting(false);
						}
					}}
				>
					<Dialog.Title className="text-xl font-semibold">{props.title}</Dialog.Title>
					<Dialog.Description className="mt-2 text-kumo-subtle">
						{props.description}
					</Dialog.Description>
					<div className="mt-5">
						<Field label={reasonLabel}>
							<InputArea
								aria-label={reasonLabel}
								value={reason}
								onChange={(event) => setReason(event.currentTarget.value)}
								rows={4}
								maxLength={1000}
								required={!props.reasonOptional}
							/>
						</Field>
					</div>
					{error && (
						<Banner
							className="mt-4"
							variant="error"
							title={t`Action failed`}
							description={error.message}
						/>
					)}
					<DialogActions
						disabled={!props.reasonOptional && !reason.trim()}
						loading={submitting}
						label={props.label}
						variant={props.variant}
					/>
				</form>
			</Dialog>
		</Dialog.Root>
	);
}

function DialogActions({
	disabled,
	loading,
	label,
	variant = "primary",
}: {
	disabled: boolean;
	loading: boolean;
	label: string;
	variant?: "primary" | "destructive" | "secondary";
}) {
	return (
		<div className="mt-6 flex justify-end gap-2">
			<Dialog.Close
				render={(props) => (
					<Button {...props} type="button">
						<Trans>Cancel</Trans>
					</Button>
				)}
			/>
			<Button type="submit" variant={variant} loading={loading} disabled={disabled}>
				{label}
			</Button>
		</div>
	);
}

function Page({
	title,
	description,
	actions,
	children,
}: {
	title: string;
	description: string;
	actions?: React.ReactNode;
	children: React.ReactNode;
}) {
	return (
		<>
			<div className="mb-5 flex flex-wrap items-start justify-between gap-4">
				<div>
					<h1 className="text-2xl font-semibold">{title}</h1>
					<p className="mt-1 text-sm text-kumo-subtle">{description}</p>
				</div>
				{actions}
			</div>
			{children}
		</>
	);
}

function StateBadge({ state }: { state: AssessmentState }) {
	const { t } = useLingui();
	return (
		<Badge variant={stateVariant(state)} appearance="dot">
			{stateLabel(t, state)}
		</Badge>
	);
}

function CenteredLoader({ label }: { label: string }) {
	return (
		<div className="flex min-h-40 items-center justify-center gap-3 text-kumo-subtle">
			<Loader />
			<span>{label}</span>
		</div>
	);
}

function LoadMore({ onLoad, compact = false }: { onLoad: () => Promise<void>; compact?: boolean }) {
	const { t } = useLingui();
	const toast = useKumoToastManager();
	const [loading, setLoading] = React.useState(false);
	return (
		<div className={compact ? "p-3" : "mt-4 flex justify-center"}>
			<Button
				className={compact ? "w-full" : undefined}
				size="sm"
				loading={loading}
				onClick={async () => {
					setLoading(true);
					try {
						await onLoad();
					} catch (caught) {
						toast.add({
							title: t`Could not load more results`,
							content: toError(caught, t`Request failed`).message,
							variant: "error",
						});
					} finally {
						setLoading(false);
					}
				}}
			>
				<Trans>Load more</Trans>
			</Button>
		</div>
	);
}

interface Resource<T> {
	data: T | null;
	error: Error | null;
	loading: boolean;
	refresh: () => void;
}
function useResource<T>(load: () => Promise<T>, dependencies: React.DependencyList): Resource<T> {
	const { t } = useLingui();
	const [data, setData] = React.useState<T | null>(null);
	const [error, setError] = React.useState<Error | null>(null);
	const [loading, setLoading] = React.useState(true);
	const [revision, setRevision] = React.useState(0);
	React.useEffect(() => {
		let active = true;
		setLoading(true);
		setError(null);
		void (async () => {
			try {
				const value = await load();
				if (active) setData(value);
			} catch (caught) {
				if (active) setError(toError(caught, t`Request failed`));
			} finally {
				if (active) setLoading(false);
			}
		})();
		return () => {
			active = false;
		};
	}, [...dependencies, revision]);
	return { data, error, loading, refresh: () => setRevision((value) => value + 1) };
}

function useRoute(): [string, (path: string) => void] {
	const [path, setPath] = React.useState(currentBrowserLocation);
	React.useEffect(() => {
		const listener = () => setPath(currentBrowserLocation());
		window.addEventListener("popstate", listener);
		return () => window.removeEventListener("popstate", listener);
	}, []);
	return [
		path,
		(next) => {
			window.history.pushState(null, "", next);
			setPath(currentBrowserLocation());
			window.scrollTo({ top: 0 });
		},
	];
}

function currentBrowserLocation(): string {
	return `${window.location.pathname}${window.location.search}`;
}

interface ListingPreview {
	name: string;
	publisher?: string;
	publisherHandle?: string;
	kind: "profile" | "release";
	slug: string;
	version?: string;
	description?: string;
	keywords: string[];
	license?: string;
	media: Array<{ kind: string; index: number }>;
}

function listingPreview(detail: AssessmentDetail): ListingPreview {
	const canonical = asRecord(detail.assessment.canonicalInput);
	const input = asRecord(canonical?.["input"]);
	const kind = detail.assessment.subject_kind;
	const source = kind === "release" ? asRecord(detail.relatedProfile) : input;
	const slug =
		stringValue(input?.[kind === "release" ? "packageSlug" : "slug"]) ??
		subjectParts(detail.assessment.subject_uri).slug;
	const name = stringValue(source?.["name"]) ?? humanizeSlug(slug);
	const version = stringValue(input?.["version"]);
	const authors = arrayValue(source?.["authors"]);
	const firstAuthor = asRecord(authors[0]);
	const publisher = stringValue(firstAuthor?.["name"]);
	const media = arrayValue(input?.["media"]).flatMap((item) => {
		const record = asRecord(item);
		const index = numberValue(record, "index");
		const mediaKind = stringValue(record?.["kind"]);
		return index === undefined || !mediaKind ? [] : [{ kind: mediaKind, index }];
	});
	return {
		name,
		publisher,
		publisherHandle: detail.publisherHandle ?? undefined,
		kind,
		slug,
		version,
		description: stringValue(source?.["description"]),
		keywords: stringArray(source?.["keywords"]),
		license: stringValue(source?.["license"]),
		media,
	};
}

function assessmentListIdentity(item: AssessmentListItem) {
	const parts = subjectParts(item.subject_uri);
	return {
		name: humanizeSlug(parts.slug),
		version: parts.version,
	};
}

function subjectParts(uri: string): { slug: string; version?: string } {
	const rkey = decodeURIComponent(uri.split("/").at(-1) ?? "listing");
	const separator = rkey.lastIndexOf(":");
	return separator > 0
		? { slug: rkey.slice(0, separator), version: rkey.slice(separator + 1) }
		: { slug: rkey };
}

function subjectLabel(uri: string | null): string | null {
	if (!uri || uri.startsWith("did:")) return null;
	const parts = subjectParts(uri);
	return `${humanizeSlug(parts.slug)}${parts.version ? ` ${parts.version}` : ""}`;
}

function humanizeSlug(value: string): string {
	return value
		.split(SLUG_SEPARATOR_RE)
		.filter(Boolean)
		.map((part) => (part === "emdash" ? "EmDash" : part.charAt(0).toUpperCase() + part.slice(1)))
		.join(" ");
}

function activeTakedowns(items: ActivityItem[]): ActivityItem[] {
	const latest = new Map<string, ActivityItem>();
	for (const item of items) {
		if (
			!item.subject_uri ||
			(item.action !== "takedown" && item.action !== "retract-takedown") ||
			latest.has(item.subject_uri)
		)
			continue;
		latest.set(item.subject_uri, item);
	}
	return [...latest.values()].filter((item) => item.action === "takedown");
}

type EvaluationMetric =
	| "cases"
	| "unsafePasses"
	| "outcomeMismatches"
	| "invalidAndErrors"
	| "p95Latency";

function evaluationMetrics(value: Record<string, unknown>): Array<[EvaluationMetric, string]> {
	const result = asRecord(value["result"]);
	const report = stringValue(result?.["report"]);
	if (!report) return [];
	const read = (pattern: RegExp) => report.match(pattern)?.[1];
	const cases = report.match(EVAL_CASES_RE);
	return [
		["cases", cases ? `${cases[1]} × ${cases[2]}` : "—"],
		["unsafePasses", read(EVAL_UNSAFE_PASSES_RE) ?? "—"],
		["outcomeMismatches", read(EVAL_MISMATCHES_RE) ?? "—"],
		[
			"invalidAndErrors",
			`${read(EVAL_INVALID_OUTPUTS_RE) ?? "—"} / ${read(EVAL_MODEL_ERRORS_RE) ?? "—"}`,
		],
		["p95Latency", read(EVAL_P95_RE) ?? "—"],
	];
}

function evaluationMetricLabel(
	t: ReturnType<typeof useLingui>["t"],
	metric: EvaluationMetric,
): string {
	if (metric === "cases") return t`Cases × repeats`;
	if (metric === "unsafePasses") return t`Unsafe passes`;
	if (metric === "outcomeMismatches") return t`Outcome mismatches`;
	if (metric === "invalidAndErrors") return t`Invalid / model errors`;
	return t`P95 latency`;
}

function coverageSummary(value: unknown): string {
	const record = asRecord(value);
	if (!record) return "—";
	return Object.entries(record)
		.map(
			([key, item]) =>
				`${key}: ${typeof item === "string" ? item : (stringValue(asRecord(item)?.["acquisition"]) ?? "unknown")}`,
		)
		.join(" · ");
}

function actorLabel(
	t: ReturnType<typeof useLingui>["t"],
	item: ActivityItem,
	session: OperatorSession,
): string {
	return item.actor_did === session.identity.actorDid ? t`You` : roleLabel(t, item.actor_role);
}

function ActivityEventText({ item, session }: { item: ActivityItem; session: OperatorSession }) {
	const { t } = useLingui();
	const actor = actorLabel(t, item, session);
	const subject = item.subject_uri?.startsWith("did:")
		? t`publisher`
		: (subjectLabel(item.subject_uri) ?? t`service`);
	if (item.action === "approve") return t`${actor} approved ${subject}`;
	if (item.action === "block") return t`${actor} blocked ${subject}`;
	if (item.action === "rerun") return t`${actor} reran ${subject}`;
	if (item.action === "takedown") return t`${actor} issued a takedown for ${subject}`;
	if (item.action === "retract-takedown") return t`${actor} retracted the takedown for ${subject}`;
	if (item.action === "pause-issuance") return t`${actor} paused issuance`;
	return t`${actor} resumed issuance`;
}

const actionLabels: Record<string, MessageDescriptor> = {
	approve: msg`Approved`,
	block: msg`Blocked`,
	rerun: msg`Reran`,
	takedown: msg`Issued a takedown for`,
	"retract-takedown": msg`Retracted the takedown for`,
	"pause-issuance": msg`Paused issuance`,
	"resume-issuance": msg`Resumed issuance`,
};
function actionLabel(t: ReturnType<typeof useLingui>["t"], action: string) {
	return t(actionLabels[action] ?? msg`Changed`);
}

const assessmentStates: AssessmentState[] = [
	"review",
	"error",
	"pending",
	"running",
	"passed",
	"blocked",
	"superseded",
	"cancelled",
];
const assessmentStateLabels: Record<AssessmentState, MessageDescriptor> = {
	review: msg`Review`,
	error: msg`Error`,
	pending: msg`Pending`,
	running: msg`Running`,
	passed: msg`Passed`,
	blocked: msg`Blocked`,
	superseded: msg`Superseded`,
	cancelled: msg`Cancelled`,
};
const roleLabels: Record<string, MessageDescriptor> = {
	admin: msg`Admin`,
	reviewer: msg`Reviewer`,
};
function stateLabel(t: ReturnType<typeof useLingui>["t"], state: AssessmentState) {
	return t(assessmentStateLabels[state]);
}
function roleLabel(t: ReturnType<typeof useLingui>["t"], role: string) {
	return t(roleLabels[role] ?? roleLabels["reviewer"]!);
}
function isAssessmentState(value: string): value is AssessmentState {
	return assessmentStates.some((state) => state === value);
}
function stateVariant(
	state: AssessmentState,
): "success" | "error" | "warning" | "neutral" | "info" {
	if (state === "passed") return "success";
	if (state === "blocked" || state === "error") return "error";
	if (state === "review") return "warning";
	if (state === "running" || state === "pending") return "info";
	return "neutral";
}
function canApprove(state: AssessmentState) {
	return state === "review" || state === "error" || state === "blocked";
}
function canBlock(state: AssessmentState) {
	return state === "review" || state === "error" || state === "passed" || state === "blocked";
}
function canRerun(state: AssessmentState) {
	return state !== "cancelled" && state !== "superseded";
}
function stateFromLocation(): AssessmentState {
	const value = new URLSearchParams(window.location.search).get("state");
	return value && isAssessmentState(value) ? value : "review";
}
function viewFromPath(path: string): View {
	if (path.startsWith("/_admin/assessments")) return "assessments";
	if (path.startsWith("/_admin/takedowns")) return "takedowns";
	if (path.startsWith("/_admin/issuance")) return "issuance";
	if (path.startsWith("/_admin/evaluations")) return "evaluations";
	if (path.startsWith("/_admin/activity")) return "activity";
	return "overview";
}
function pathForView(view: View) {
	return view === "overview" ? "/_admin" : `/_admin/${view}`;
}
function formatDate(value: string) {
	const date = new Date(value);
	return Number.isNaN(date.valueOf())
		? value
		: new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}
function pageCount(page: ApiPage<unknown> | null) {
	return page ? `${page.items.length}${page.nextCursor ? "+" : ""}` : "—";
}
function detailToListItem(detail: AssessmentDetail): AssessmentListItem {
	return {
		...detail.assessment,
		assessment_state: detail.assessment.assessment_state ?? detail.assessment.state,
	};
}
function asRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? Object.fromEntries(Object.entries(value))
		: null;
}
function recordValue(value: unknown, key: string) {
	return asRecord(value)?.[key];
}
function stringValue(value: unknown) {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}
function numberValue(value: Record<string, unknown> | null, key: string) {
	const item = value?.[key];
	return typeof item === "number" ? item : undefined;
}
function arrayValue(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}
function stringArray(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter((item): item is string => typeof item === "string")
		: [];
}
function toError(value: unknown, fallback: string) {
	return value instanceof Error ? value : new Error(fallback);
}
