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
	Table,
	Tabs,
	useKumoToastManager,
} from "@cloudflare/kumo";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import {
	ArrowLeft,
	CheckCircle,
	ClipboardText,
	Flask,
	Gauge,
	Pause,
	Prohibit,
	Pulse,
	WarningCircle,
} from "@phosphor-icons/react";
import React from "react";

import {
	assessmentAction,
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
	type Page,
} from "./api.js";

type View = "overview" | "assessments" | "takedowns" | "issuance" | "evaluations" | "activity";
const ADMIN_VIEWS = new Set<View>(["takedowns", "issuance", "evaluations", "activity"]);

export function App() {
	const { t } = useLingui();
	React.useEffect(() => {
		document.title = t`EmDash labeler`;
	}, [t]);
	const [route, navigate] = useRoute();
	const session = useResource(getSession, []);
	const health = useResource(getHealth, []);

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

	const isAdmin = session.data.identity.roles.includes("admin");
	const activeView = viewFromPath(route);
	const navigation: Array<{ view: View; label: string; icon: React.ReactNode; admin?: boolean }> = [
		{ view: "overview", label: t`Overview`, icon: <Gauge /> },
		{ view: "assessments", label: t`Assessments`, icon: <ClipboardText /> },
		{ view: "takedowns", label: t`Takedowns`, icon: <Prohibit />, admin: true },
		{ view: "issuance", label: t`Issuance`, icon: <Pause />, admin: true },
		{ view: "evaluations", label: t`Evaluations`, icon: <Flask />, admin: true },
		{ view: "activity", label: t`Activity`, icon: <Pulse />, admin: true },
	];

	return (
		<div className="min-h-screen bg-kumo-canvas text-kumo-default">
			<header className="border-b bg-kumo-base">
				<div className="mx-auto flex max-w-[1500px] items-center justify-between gap-4 px-4 py-3 sm:px-6">
					<div>
						<p className="text-xs font-medium uppercase tracking-wide text-kumo-subtle">
							<Trans>EmDash registry</Trans>
						</p>
						<h1 className="text-lg font-semibold">
							<Trans>Labeler administration</Trans>
						</h1>
					</div>
					<div className="min-w-0 text-end">
						<p className="truncate text-sm font-medium">{session.data.identity.principal}</p>
						<div className="mt-1 flex justify-end gap-1">
							{session.data.identity.roles.map((role) => (
								<Badge key={role} variant="blue">
									{roleLabel(t, role)}
								</Badge>
							))}
						</div>
					</div>
				</div>
			</header>

			<div className="mx-auto grid max-w-[1500px] gap-6 px-4 py-6 sm:px-6 lg:grid-cols-[220px_minmax(0,1fr)]">
				<nav aria-label={t`Operator navigation`} className="flex gap-1 overflow-x-auto lg:flex-col">
					{navigation
						.filter((item) => !item.admin || isAdmin)
						.map((item) => (
							<Button
								key={item.view}
								variant={activeView === item.view ? "primary" : "ghost"}
								icon={item.icon}
								className="shrink-0 justify-start"
								onClick={() => navigate(pathForView(item.view))}
							>
								{item.label}
							</Button>
						))}
				</nav>

				<main className="min-w-0">
					{renderView(activeView, route, navigate, session.data, health)}
				</main>
			</div>
		</div>
	);
}

function renderView(
	view: View,
	path: string,
	navigate: (path: string) => void,
	session: OperatorSession,
	health: Resource<HealthStatus>,
): React.ReactNode {
	if (view === "overview") return <Overview health={health} navigate={navigate} />;
	if (ADMIN_VIEWS.has(view) && !session.identity.roles.includes("admin")) {
		return <AdministratorRoleRequired />;
	}
	if (view === "assessments") {
		const prefix = "/_admin/assessments/";
		return path.startsWith(prefix) ? (
			<AssessmentDetailView
				runKey={decodeURIComponent(path.slice(prefix.length))}
				navigate={navigate}
			/>
		) : (
			<AssessmentsView navigate={navigate} />
		);
	}
	if (view === "takedowns") return <TakedownsView />;
	if (view === "issuance") return <IssuanceView />;
	if (view === "evaluations") return <EvaluationsView />;
	if (view === "activity") return <ActivityView />;
	return null;
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
}: {
	health: Resource<HealthStatus>;
	navigate: (path: string) => void;
}) {
	const { t } = useLingui();
	return (
		<Page title={t`Overview`} description={t`Current readiness and operator work.`}>
			{health.error && (
				<Banner variant="error" title={t`Health check failed`} description={health.error.message} />
			)}
			<div className="grid gap-4 md:grid-cols-3">
				<StatusCard
					title={t`Service`}
					ready={health.data?.status === "ok"}
					value={
						health.loading ? t`Checking` : health.data?.status === "ok" ? t`Ready` : t`Not ready`
					}
				/>
				<StatusCard
					title={t`Discovery`}
					ready={health.data?.discovery.ready === true}
					value={health.data?.discovery.ready === true ? t`Ready` : t`Not ready`}
				/>
				<StatusCard
					title={t`Signing`}
					ready={health.data?.signing.ready === true}
					value={health.data?.signing.ready === true ? t`Ready` : t`Not ready`}
				/>
			</div>
			<LayerCard className="mt-6 p-5">
				<div className="flex flex-wrap items-center justify-between gap-4">
					<div>
						<h2 className="font-semibold">
							<Trans>Review queue</Trans>
						</h2>
						<p className="mt-1 text-sm text-kumo-subtle">
							<Trans>Inspect assessments awaiting an operator decision.</Trans>
						</p>
					</div>
					<Button variant="primary" onClick={() => navigate("/_admin/assessments")}>
						<Trans>Open assessments</Trans>
					</Button>
				</div>
			</LayerCard>
		</Page>
	);
}

function AssessmentsView({ navigate }: { navigate: (path: string) => void }) {
	const { t } = useLingui();
	const [state, setState] = React.useState<AssessmentState>("review");
	const stateRef = React.useRef(state);
	const resource = useResource(() => getAssessments(state), [state]);
	const [items, setItems] = React.useState<AssessmentListItem[]>([]);
	const [nextCursor, setNextCursor] = React.useState<string | undefined>();

	React.useEffect(() => {
		if (!resource.data) return;
		setItems(resource.data.items);
		setNextCursor(resource.data.nextCursor);
	}, [resource.data]);

	const tabs = assessmentStates.map((value) => ({ value, label: stateLabel(t, value) }));
	return (
		<Page
			title={t`Assessments`}
			description={t`Review model decisions and assessment failures.`}
			actions={
				<Button onClick={resource.refresh}>
					<Trans>Refresh</Trans>
				</Button>
			}
		>
			<Tabs
				tabs={tabs}
				value={state}
				onValueChange={(value) => {
					if (isAssessmentState(value)) {
						stateRef.current = value;
						setState(value);
					}
				}}
				variant="underline"
				className="mb-5 overflow-x-auto"
			/>
			{resource.error && (
				<Banner
					variant="error"
					title={t`Assessments unavailable`}
					description={resource.error.message}
				/>
			)}
			{resource.loading ? (
				<CenteredLoader label={t`Loading assessments`} />
			) : items.length === 0 ? (
				<Empty
					title={t`No assessments`}
					description={t`There are no assessments in this state.`}
					icon={<ClipboardText size={42} />}
				/>
			) : (
				<LayerCard className="overflow-x-auto p-0">
					<Table>
						<Table.Header>
							<Table.Row>
								<Table.Head>
									<Trans>Subject</Trans>
								</Table.Head>
								<Table.Head>
									<Trans>Kind</Trans>
								</Table.Head>
								<Table.Head>
									<Trans>State</Trans>
								</Table.Head>
								<Table.Head>
									<Trans>Updated</Trans>
								</Table.Head>
								<Table.Head>
									<Trans>Action</Trans>
								</Table.Head>
							</Table.Row>
						</Table.Header>
						<Table.Body>
							{items.map((item) => (
								<Table.Row key={item.run_key}>
									<Table.Cell>
										<div className="max-w-xl">
											<p className="truncate font-mono text-xs">{item.subject_uri}</p>
											<p className="mt-1 truncate font-mono text-xs text-kumo-subtle">
												{item.subject_cid}
											</p>
										</div>
									</Table.Cell>
									<Table.Cell>{kindLabel(t, item.subject_kind)}</Table.Cell>
									<Table.Cell>
										<StateBadge state={item.state} />
									</Table.Cell>
									<Table.Cell>{formatDate(item.updated_at)}</Table.Cell>
									<Table.Cell>
										<Button
											size="sm"
											onClick={() =>
												navigate(`/_admin/assessments/${encodeURIComponent(item.run_key)}`)
											}
										>
											<Trans>View</Trans>
										</Button>
									</Table.Cell>
								</Table.Row>
							))}
						</Table.Body>
					</Table>
				</LayerCard>
			)}
			{nextCursor && (
				<LoadMore
					onLoad={async () => {
						const requestedState = state;
						const page = await getAssessments(state, nextCursor);
						if (stateRef.current !== requestedState) return;
						setItems((current) => [...current, ...page.items]);
						setNextCursor(page.nextCursor);
					}}
				/>
			)}
		</Page>
	);
}

function AssessmentDetailView({
	runKey,
	navigate,
}: {
	runKey: string;
	navigate: (path: string) => void;
}) {
	const { t } = useLingui();
	const resource = useResource(() => getAssessment(runKey), [runKey]);
	const toast = useKumoToastManager();
	const [pendingAction, setPendingAction] = React.useState<"approve" | "block" | "rerun" | null>(
		null,
	);
	const assessment = resource.data?.assessment;
	const run = assessment ? toListItem(assessment) : null;
	return (
		<Page
			title={t`Assessment detail`}
			description={runKey}
			actions={
				<Button
					icon={<ArrowLeft className="rtl:-scale-x-100" />}
					onClick={() => navigate("/_admin/assessments")}
				>
					<Trans>Back to assessments</Trans>
				</Button>
			}
		>
			{resource.loading && <CenteredLoader label={t`Loading assessment`} />}
			{resource.error && (
				<Banner
					variant="error"
					title={t`Assessment unavailable`}
					description={resource.error.message}
				/>
			)}
			{assessment && run && (
				<>
					<div className="mb-5 flex flex-wrap gap-2">
						<ActionDialog
							label={t`Approve`}
							title={t`Approve assessment`}
							description={t`Issue an operator approval for this exact URI and CID.`}
							variant="primary"
							open={pendingAction === "approve"}
							onOpenChange={(open) => setPendingAction(open ? "approve" : null)}
							onConfirm={(reason) => assessmentAction(run, "approve", reason)}
							onSuccess={() => {
								resource.refresh();
								toast.add({ title: t`Assessment approved`, variant: "success" });
							}}
						/>
						<ActionDialog
							label={t`Block`}
							title={t`Block assessment`}
							description={t`Issue an operator block for this exact URI and CID.`}
							variant="destructive"
							open={pendingAction === "block"}
							onOpenChange={(open) => setPendingAction(open ? "block" : null)}
							onConfirm={(reason) => assessmentAction(run, "block", reason)}
							onSuccess={() => {
								resource.refresh();
								toast.add({ title: t`Assessment blocked`, variant: "success" });
							}}
						/>
						<ActionDialog
							label={t`Rerun`}
							title={t`Rerun assessment`}
							description={t`Create a fresh assessment run for this exact URI and CID.`}
							open={pendingAction === "rerun"}
							onOpenChange={(open) => setPendingAction(open ? "rerun" : null)}
							onConfirm={(reason) => assessmentAction(run, "rerun", reason)}
							onSuccess={() => {
								resource.refresh();
								toast.add({ title: t`Assessment rerun started`, variant: "success" });
							}}
						/>
					</div>
					<div className="grid gap-5 xl:grid-cols-2">
						<DetailCard
							title={t`Assessment`}
							value={{
								...assessment,
								canonicalInput: undefined,
								coverage: undefined,
								summary: undefined,
							}}
						/>
						<DetailCard title={t`Summary`} value={assessment.summary ?? null} />
						<DetailCard title={t`Coverage`} value={assessment.coverage ?? null} />
						<DetailCard title={t`Canonical input`} value={assessment.canonicalInput ?? null} />
					</div>
					<section className="mt-6">
						<h2 className="mb-3 text-lg font-semibold">
							<Trans>Findings</Trans>
						</h2>
						{resource.data?.findings?.length ? (
							<div className="grid gap-3">
								{resource.data.findings.map((finding) => (
									<LayerCard
										className="p-4"
										key={`${finding.finding_index}-${finding.reason_code}`}
									>
										<div className="flex flex-wrap items-center gap-2">
											<Badge variant="warning">{finding.category}</Badge>
											<code className="text-xs text-kumo-subtle">{finding.reason_code}</code>
											{finding.confidence !== null && (
												<span className="text-xs text-kumo-subtle">
													{Math.round(finding.confidence * 100)}%
												</span>
											)}
										</div>
										<p className="mt-2">{finding.public_summary}</p>
									</LayerCard>
								))}
							</div>
						) : (
							<Empty
								size="sm"
								title={t`No findings`}
								description={t`This assessment has no recorded findings.`}
							/>
						)}
					</section>
					{resource.data?.manualDecision && (
						<section className="mt-6">
							<DetailCard title={t`Latest manual decision`} value={resource.data.manualDecision} />
						</section>
					)}
				</>
			)}
		</Page>
	);
}

function TakedownsView() {
	const { t } = useLingui();
	const toast = useKumoToastManager();
	const [uri, setUri] = React.useState("");
	const [reason, setReason] = React.useState("");
	const [mode, setMode] = React.useState<"takedown" | "retract">("takedown");
	const [submitting, setSubmitting] = React.useState(false);
	const [error, setError] = React.useState<Error | null>(null);
	return (
		<Page
			title={t`Takedowns`}
			description={t`Issue or retract a takedown label for an AT URI or DID.`}
		>
			<LayerCard className="max-w-2xl p-6">
				<form
					className="grid gap-5"
					onSubmit={async (event) => {
						event.preventDefault();
						setSubmitting(true);
						setError(null);
						try {
							await setTakedown(uri, mode === "retract", reason);
							setReason("");
							toast.add({
								title: mode === "retract" ? t`Takedown retracted` : t`Takedown issued`,
								variant: "success",
							});
						} catch (caught) {
							setError(toError(caught, t`Action failed`));
						} finally {
							setSubmitting(false);
						}
					}}
				>
					<Select
						label={t`Action`}
						value={mode}
						onValueChange={(value) => value && setMode(value)}
						items={{ takedown: t`Issue takedown`, retract: t`Retract takedown` }}
					/>
					<Input
						label={t`Subject URI`}
						value={uri}
						onChange={(event) => setUri(event.currentTarget.value)}
						placeholder={t`at://… or did:…`}
						required
					/>
					<Field label={t`Reason`}>
						<InputArea
							aria-label={t`Reason`}
							value={reason}
							onChange={(event) => setReason(event.currentTarget.value)}
							rows={4}
							maxLength={1000}
							required
						/>
					</Field>
					{error && <Banner variant="error" title={t`Action failed`} description={error.message} />}
					<div>
						<Button
							type="submit"
							variant={mode === "takedown" ? "destructive" : "primary"}
							loading={submitting}
						>
							{mode === "takedown" ? t`Issue takedown` : t`Retract takedown`}
						</Button>
					</div>
				</form>
			</LayerCard>
		</Page>
	);
}

function IssuanceView() {
	const { t } = useLingui();
	const resource = useResource(getIssuance, []);
	const toast = useKumoToastManager();
	const [dialogOpen, setDialogOpen] = React.useState(false);
	const status = resource.data;
	return (
		<Page
			title={t`Issuance`}
			description={t`Pause or resume all label issuance.`}
			actions={
				<Button onClick={resource.refresh}>
					<Trans>Refresh</Trans>
				</Button>
			}
		>
			{resource.loading && <CenteredLoader label={t`Loading issuance status`} />}
			{resource.error && (
				<Banner
					variant="error"
					title={t`Issuance status unavailable`}
					description={resource.error.message}
				/>
			)}
			{status && (
				<LayerCard className="max-w-2xl p-6">
					<div className="flex flex-wrap items-center justify-between gap-4">
						<div>
							<div className="flex items-center gap-2">
								<h2 className="font-semibold">
									<Trans>Label issuance</Trans>
								</h2>
								<Badge variant={status.paused ? "warning" : "success"} appearance="dot">
									{status.paused ? t`Paused` : t`Active`}
								</Badge>
							</div>
							<p className="mt-2 text-sm text-kumo-subtle">
								{status.updatedAt
									? t`Last changed ${formatDate(status.updatedAt)}`
									: t`No control action has been recorded.`}
							</p>
						</div>
						<ActionDialog
							label={status.paused ? t`Resume issuance` : t`Pause issuance`}
							title={status.paused ? t`Resume label issuance` : t`Pause label issuance`}
							description={
								status.paused
									? t`Automated and operator label issuance will resume.`
									: t`All new label issuance will stop until an administrator resumes it.`
							}
							variant={status.paused ? "primary" : "destructive"}
							open={dialogOpen}
							onOpenChange={setDialogOpen}
							onConfirm={(reason) => setIssuance(!status.paused, reason)}
							onSuccess={() => {
								resource.refresh();
								toast.add({
									title: status.paused ? t`Issuance resumed` : t`Issuance paused`,
									variant: "success",
								});
							}}
						/>
					</div>
				</LayerCard>
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
	const [detailOpen, setDetailOpen] = React.useState(false);
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
			title={t`Protected evaluations`}
			description={t`Run and inspect the protected model evaluation suite.`}
			actions={
				<ActionDialog
					label={t`Start evaluation`}
					title={t`Start protected evaluation`}
					description={t`The evaluation runs asynchronously and may take several minutes.`}
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
			{resource.loading && <CenteredLoader label={t`Loading evaluations`} />}
			{resource.error && (
				<Banner
					variant="error"
					title={t`Evaluations unavailable`}
					description={resource.error.message}
				/>
			)}
			{!resource.loading && items.length === 0 ? (
				<Empty
					title={t`No evaluations`}
					description={t`No protected evaluation has been started.`}
					icon={<Flask size={42} />}
				/>
			) : (
				<EvaluationTable
					items={items}
					onView={async (id) => {
						try {
							setSelected(await getEvaluation(id));
							setDetailOpen(true);
						} catch (caught) {
							toast.add({
								title: t`Evaluation unavailable`,
								content: toError(caught, t`Request failed`).message,
								variant: "error",
							});
						}
					}}
				/>
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
			<Dialog.Root open={detailOpen} onOpenChange={setDetailOpen}>
				<Dialog size="xl" className="max-h-[85vh] max-w-[min(90vw,60rem)] overflow-auto p-6">
					<Dialog.Title>
						<Trans>Evaluation detail</Trans>
					</Dialog.Title>
					<Dialog.Description className="mt-1">
						<Trans>Durable run status and promotion result.</Trans>
					</Dialog.Description>
					<pre className="mt-5 rounded-lg bg-kumo-recessed p-4 text-xs">
						{JSON.stringify(selected, null, 2)}
					</pre>
					<div className="mt-5 flex justify-end">
						<Dialog.Close
							render={(props) => (
								<Button {...props}>
									<Trans>Close</Trans>
								</Button>
							)}
						/>
					</div>
				</Dialog>
			</Dialog.Root>
		</Page>
	);
}

function ActivityView() {
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
		<Page
			title={t`Operator activity`}
			description={t`Immutable operator decisions and service control actions.`}
			actions={
				<Button onClick={resource.refresh}>
					<Trans>Refresh</Trans>
				</Button>
			}
		>
			{resource.loading && <CenteredLoader label={t`Loading operator activity`} />}
			{resource.error && (
				<Banner
					variant="error"
					title={t`Activity unavailable`}
					description={resource.error.message}
				/>
			)}
			{!resource.loading && items.length === 0 ? (
				<Empty
					title={t`No activity`}
					description={t`No operator action has been recorded.`}
					icon={<Pulse size={42} />}
				/>
			) : (
				<ActivityTable items={items} />
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

function EvaluationTable({
	items,
	onView,
}: {
	items: EvaluationListItem[];
	onView: (id: number) => Promise<void>;
}) {
	const { t } = useLingui();
	return (
		<LayerCard className="overflow-x-auto p-0">
			<Table>
				<Table.Header>
					<Table.Row>
						<Table.Head>
							<Trans>Run</Trans>
						</Table.Head>
						<Table.Head>
							<Trans>Status</Trans>
						</Table.Head>
						<Table.Head>
							<Trans>Budget</Trans>
						</Table.Head>
						<Table.Head>
							<Trans>Started</Trans>
						</Table.Head>
						<Table.Head>
							<Trans>Reason</Trans>
						</Table.Head>
						<Table.Head>
							<Trans>Action</Trans>
						</Table.Head>
					</Table.Row>
				</Table.Header>
				<Table.Body>
					{items.map((item) => (
						<Table.Row key={item.id}>
							<Table.Cell>#{item.id}</Table.Cell>
							<Table.Cell>
								<StatusBadge status={item.status} />
							</Table.Cell>
							<Table.Cell>
								{item.budget_passed === null
									? t`Pending`
									: item.budget_passed === 1
										? t`Passed`
										: t`Failed`}
							</Table.Cell>
							<Table.Cell>{formatDate(item.created_at)}</Table.Cell>
							<Table.Cell>
								<p className="max-w-sm truncate">{item.reason}</p>
							</Table.Cell>
							<Table.Cell>
								<Button size="sm" onClick={() => void onView(item.id)}>
									<Trans>View</Trans>
								</Button>
							</Table.Cell>
						</Table.Row>
					))}
				</Table.Body>
			</Table>
		</LayerCard>
	);
}

function ActivityTable({ items }: { items: ActivityItem[] }) {
	return (
		<LayerCard className="overflow-x-auto p-0">
			<Table>
				<Table.Header>
					<Table.Row>
						<Table.Head>
							<Trans>Action</Trans>
						</Table.Head>
						<Table.Head>
							<Trans>Subject</Trans>
						</Table.Head>
						<Table.Head>
							<Trans>Actor</Trans>
						</Table.Head>
						<Table.Head>
							<Trans>Reason</Trans>
						</Table.Head>
						<Table.Head>
							<Trans>Time</Trans>
						</Table.Head>
					</Table.Row>
				</Table.Header>
				<Table.Body>
					{items.map((item) => (
						<Table.Row key={item.id}>
							<Table.Cell>
								<Badge variant="neutral">{item.action}</Badge>
							</Table.Cell>
							<Table.Cell>
								<p className="max-w-sm truncate font-mono text-xs">{item.subject_uri ?? "—"}</p>
							</Table.Cell>
							<Table.Cell>
								<p className="max-w-xs truncate font-mono text-xs">{item.actor_did}</p>
							</Table.Cell>
							<Table.Cell>
								<p className="max-w-md">{item.reason}</p>
							</Table.Cell>
							<Table.Cell>{formatDate(item.created_at)}</Table.Cell>
						</Table.Row>
					))}
				</Table.Body>
			</Table>
		</LayerCard>
	);
}

function ActionDialog(props: {
	label: string;
	title: string;
	description: string;
	variant?: "primary" | "destructive" | "secondary";
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onConfirm: (reason: string) => Promise<unknown>;
	onSuccess: () => void;
}) {
	const { t } = useLingui();
	const [reason, setReason] = React.useState("");
	const [submitting, setSubmitting] = React.useState(false);
	const [error, setError] = React.useState<Error | null>(null);
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
						<Field label={t`Reason`}>
							<InputArea
								aria-label={t`Reason`}
								value={reason}
								onChange={(event) => setReason(event.currentTarget.value)}
								rows={4}
								maxLength={1000}
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
					<div className="mt-6 flex justify-end gap-2">
						<Dialog.Close
							render={(closeProps) => (
								<Button {...closeProps} type="button">
									<Trans>Cancel</Trans>
								</Button>
							)}
						/>
						<Button
							type="submit"
							variant={props.variant}
							loading={submitting}
							disabled={reason.trim().length === 0}
						>
							{props.label}
						</Button>
					</div>
				</form>
			</Dialog>
		</Dialog.Root>
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
			<div className="mb-6 flex flex-wrap items-start justify-between gap-4">
				<div>
					<h2 className="text-2xl font-semibold">{title}</h2>
					<p className="mt-1 text-kumo-subtle">{description}</p>
				</div>
				{actions}
			</div>
			{children}
		</>
	);
}

function StatusCard({ title, value, ready }: { title: string; value: string; ready: boolean }) {
	return (
		<LayerCard className="p-5">
			<div className="flex items-center justify-between gap-3">
				<div>
					<p className="text-sm text-kumo-subtle">{title}</p>
					<p className="mt-2 text-xl font-semibold">{value}</p>
				</div>
				{ready ? (
					<CheckCircle className="text-kumo-success" size={30} weight="fill" />
				) : (
					<WarningCircle className="text-kumo-warning" size={30} weight="fill" />
				)}
			</div>
		</LayerCard>
	);
}

function DetailCard({ title, value }: { title: string; value: unknown }) {
	return (
		<LayerCard className="min-w-0 p-5">
			<h3 className="mb-3 font-semibold">{title}</h3>
			<pre className="rounded-lg bg-kumo-recessed p-4 text-xs">
				{JSON.stringify(value, null, 2)}
			</pre>
		</LayerCard>
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
function StatusBadge({ status }: { status: EvaluationListItem["status"] }) {
	const { t } = useLingui();
	return (
		<Badge
			variant={status === "succeeded" ? "success" : status === "failed" ? "error" : "warning"}
			appearance="dot"
		>
			{status === "succeeded" ? t`Succeeded` : status === "failed" ? t`Failed` : t`Running`}
		</Badge>
	);
}

function CenteredLoader({ label }: { label: string }) {
	return (
		<div className="flex min-h-48 items-center justify-center gap-3 text-kumo-subtle">
			<Loader />
			<span>{label}</span>
		</div>
	);
}

function LoadMore({ onLoad }: { onLoad: () => Promise<void> }) {
	const { t } = useLingui();
	const toast = useKumoToastManager();
	const [loading, setLoading] = React.useState(false);
	return (
		<div className="mt-4 flex justify-center">
			<Button
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
	const [path, setPath] = React.useState(window.location.pathname);
	React.useEffect(() => {
		const listener = () => setPath(window.location.pathname);
		window.addEventListener("popstate", listener);
		return () => window.removeEventListener("popstate", listener);
	}, []);
	return [
		path,
		(next) => {
			window.history.pushState(null, "", next);
			setPath(next);
			window.scrollTo({ top: 0 });
		},
	];
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
function isAssessmentState(value: string): value is AssessmentState {
	return (
		value === "pending" ||
		value === "running" ||
		value === "review" ||
		value === "error" ||
		value === "passed" ||
		value === "blocked" ||
		value === "superseded" ||
		value === "cancelled"
	);
}
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
const kindLabels: Record<string, MessageDescriptor> = {
	profile: msg`Profile`,
	release: msg`Release`,
};
function stateLabel(t: ReturnType<typeof useLingui>["t"], state: AssessmentState): string {
	return t(assessmentStateLabels[state]);
}
function roleLabel(t: ReturnType<typeof useLingui>["t"], role: string): string {
	return t(roleLabels[role] ?? roleLabels["reviewer"]!);
}
function kindLabel(t: ReturnType<typeof useLingui>["t"], kind: string): string {
	return t(kindLabels[kind] ?? kindLabels["release"]!);
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
function viewFromPath(path: string): View {
	if (path.startsWith("/_admin/assessments")) return "assessments";
	if (path.startsWith("/_admin/takedowns")) return "takedowns";
	if (path.startsWith("/_admin/issuance")) return "issuance";
	if (path.startsWith("/_admin/evaluations")) return "evaluations";
	if (path.startsWith("/_admin/activity")) return "activity";
	return "overview";
}
function pathForView(view: View): string {
	return view === "overview" ? "/_admin" : `/_admin/${view}`;
}
function formatDate(value: string): string {
	const date = new Date(value);
	return Number.isNaN(date.valueOf())
		? value
		: new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}
function toListItem(assessment: AssessmentDetail["assessment"]): AssessmentListItem {
	return { ...assessment, assessment_state: assessment.assessment_state ?? assessment.state };
}
function toError(value: unknown, fallback: string): Error {
	return value instanceof Error ? value : new Error(fallback);
}
