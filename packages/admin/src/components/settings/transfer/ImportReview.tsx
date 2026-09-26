import { Badge, Banner, Button, Loader, Radio, Select } from "@cloudflare/kumo";
import { plural } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";

import { ApiResponseError } from "../../../lib/api/client.js";
import {
	analyzeTransferImport,
	executeTransferImport,
	fetchTransferImportPlan,
	TRANSFER_IMPORTS_QUERY_KEY,
	type PlanIssue,
	type ScaffoldItem,
	type SettingChoice,
	type SiteImportDecisions,
	type SiteImportPlan,
	type Sha256Digest,
	type TransferCapabilities,
	type TransferOperation,
} from "../../../lib/api/transfer.js";
import type { UserListItem } from "../../../lib/api/users.js";
import { formatFileSize } from "../../../lib/media-utils.js";
import { ConfirmDialog } from "../../ConfirmDialog.js";
import { getMutationError } from "../../DialogError.js";
import { SettingRow } from "../SettingsLayout.js";
import { CopyableDigest } from "./CopyableDigest.js";
import {
	issueLabel,
	recordKindLabel,
	RECORD_KIND_ORDER,
	SCAFFOLD_TYPE_ORDER,
	scaffoldItemName,
	transformationLabel,
} from "./labels.js";
import { canConfirmPlan, sameDecisions } from "./state.js";
import { useTransferUsers } from "./useTransferUsers.js";

const UNMAPPED = "";

/** Transformations the review presents in their own section. */
const SHOWN_ELSEWHERE = new Set(["seeded_scaffold_removed", "principal_mapped"]);

/** Scaffold names listed per type before the rest are folded away. */
const SCAFFOLD_NAMES_SHOWN = 12;

interface ChangeGroup {
	code: string;
	/** Records, references, or locales affected, summed over the code's transformations. */
	count: number;
	kinds: string[];
	locales: Array<{ from: string; to: string }>;
}

/** The plan's transformations by code, in plan order, without those shown elsewhere. */
function groupChanges(transformations: SiteImportPlan["transformations"]): ChangeGroup[] {
	const groups = new Map<string, ChangeGroup>();
	for (const transformation of transformations) {
		if (SHOWN_ELSEWHERE.has(transformation.code)) continue;
		const group = groups.get(transformation.code) ?? {
			code: transformation.code,
			count: 0,
			kinds: [],
			locales: [],
		};
		group.count +=
			transformation.count ?? transformation.ids?.length ?? transformation.locales?.length ?? 0;
		if (transformation.kind && !group.kinds.includes(transformation.kind)) {
			group.kinds.push(transformation.kind);
		}
		group.locales.push(...(transformation.locales ?? []));
		groups.set(transformation.code, group);
	}
	return [...groups.values()];
}

interface ReviewedPlan {
	plan: SiteImportPlan;
	planDigest: Sha256Digest;
}

function importPlanQueryKey(operationId: string) {
	return ["transfer", "import-plan", operationId] as const;
}

function hasErrorCode(error: unknown, code: string): boolean {
	return error instanceof ApiResponseError && error.code === code;
}

export function ImportReview({
	operation,
	capabilities,
	onExecuted,
}: {
	operation: TransferOperation;
	capabilities: TransferCapabilities;
	onExecuted: (operation: TransferOperation) => void;
}) {
	const { t } = useLingui();
	const planQuery = useQuery({
		queryKey: importPlanQueryKey(operation.id),
		queryFn: () => fetchTransferImportPlan(operation.id),
		staleTime: Infinity,
	});
	const usersQuery = useTransferUsers();

	if (planQuery.isPending || usersQuery.isPending) {
		return (
			<SettingRow>
				<div className="flex items-center gap-2 text-sm text-kumo-subtle" role="status">
					<Loader size="sm" />
					{t`Loading the import plan…`}
				</div>
			</SettingRow>
		);
	}
	if (planQuery.error || usersQuery.error) {
		return (
			<SettingRow>
				<Banner
					variant="error"
					role="alert"
					title={t`Couldn’t load the import plan`}
					description={getMutationError(planQuery.error ?? usersQuery.error) ?? undefined}
				/>
			</SettingRow>
		);
	}
	return (
		<PlanReview
			key={operation.id}
			operation={operation}
			reviewed={planQuery.data}
			users={usersQuery.data}
			capabilities={capabilities}
			onExecuted={onExecuted}
		/>
	);
}

export function PlanReview({
	operation,
	reviewed: initial,
	users,
	capabilities,
	onExecuted,
}: {
	operation: TransferOperation;
	reviewed: ReviewedPlan;
	users: readonly UserListItem[];
	capabilities: TransferCapabilities;
	onExecuted: (operation: TransferOperation) => void;
}) {
	const { t, i18n } = useLingui();
	const queryClient = useQueryClient();
	const [reviewed, setReviewed] = React.useState(initial);
	const [decisions, setDecisions] = React.useState<SiteImportDecisions>(initial.plan.decisions);
	const [confirmOpen, setConfirmOpen] = React.useState(false);
	const [notice, setNotice] = React.useState<"plan-changed" | "already-started" | null>(null);
	const { plan, planDigest } = reviewed;
	const started = notice === "already-started";

	const reloadMutation = useMutation({
		mutationFn: () => fetchTransferImportPlan(operation.id),
		onSuccess: (fresh) => {
			queryClient.setQueryData(importPlanQueryKey(operation.id), fresh);
			setReviewed(fresh);
			setDecisions(fresh.plan.decisions);
		},
	});

	const showAlreadyStarted = () => {
		setNotice("already-started");
		void queryClient.invalidateQueries({ queryKey: TRANSFER_IMPORTS_QUERY_KEY });
	};

	const decisionsMutation = useMutation({
		mutationFn: (next: SiteImportDecisions) => analyzeTransferImport(operation.id, next),
		onSuccess: (result, submitted) => {
			if (result.plan && result.planDigest) {
				setReviewed({ plan: result.plan, planDigest: result.planDigest });
				setDecisions((local) => (sameDecisions(local, submitted) ? result.plan!.decisions : local));
			}
		},
		onError: (error) => {
			if (!hasErrorCode(error, "TRANSFER_INVALID_STATE")) return;
			setDecisions(reviewed.plan.decisions);
			showAlreadyStarted();
		},
	});

	const executeMutation = useMutation({
		mutationFn: () =>
			executeTransferImport(operation.id, { packageDigest: plan.packageDigest, planDigest }),
		onSuccess: (executed) => {
			setConfirmOpen(false);
			onExecuted(executed);
		},
		onError: (error) => {
			if (hasErrorCode(error, "TRANSFER_PLAN_DIGEST_MISMATCH")) {
				setConfirmOpen(false);
				setNotice("plan-changed");
				reloadMutation.mutate();
			} else if (hasErrorCode(error, "TRANSFER_INVALID_STATE")) {
				setConfirmOpen(false);
				showAlreadyStarted();
			}
		},
	});

	const updateDecisions = (next: SiteImportDecisions) => {
		setDecisions(next);
		decisionsMutation.mutate(next);
	};

	const locked = executeMutation.isPending || started;
	const confirmable =
		!started &&
		canConfirmPlan({
			plan,
			decisions,
			saving: decisionsMutation.isPending || reloadMutation.isPending,
		});
	const decisionsError =
		decisionsMutation.error && !hasErrorCode(decisionsMutation.error, "TRANSFER_INVALID_STATE")
			? decisionsMutation.error
			: null;
	const userItems: Record<string, string> = {
		[UNMAPPED]: t`Don’t map`,
		...Object.fromEntries(users.map((user) => [user.id, user.name || user.email])),
	};
	const scaffoldItems = plan.transformations.find(
		(transformation) => transformation.code === "seeded_scaffold_removed",
	)?.items;
	const changes = groupChanges(plan.transformations);
	const counts = RECORD_KIND_ORDER.filter(
		(kind) => kind !== "principal" && (plan.counts[kind] ?? 0) > 0,
	);
	const matched = plan.principals.filter(
		(principal) =>
			principal.suggestedUserId !== undefined &&
			decisions.principalMappings[principal.id] === principal.suggestedUserId,
	).length;

	return (
		<>
			<SettingRow>
				<div className="grid gap-1 text-sm leading-5">
					<h3 className="font-medium">{t`Review the import`}</h3>
					<p className="max-w-2xl text-pretty text-kumo-subtle">
						{t`The package was checked against this site. Review what will be imported, choose who the content belongs to, then start the import.`}
					</p>
				</div>
			</SettingRow>

			<SettingRow>
				<dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
					<div>
						<dt className="text-kumo-subtle">{t`Exported`}</dt>
						<dd>
							{i18n.date(new Date(plan.origin.createdAt), {
								dateStyle: "medium",
								timeStyle: "short",
							})}
						</dd>
					</div>
					<div>
						<dt className="text-kumo-subtle">{t`Exported with`}</dt>
						<dd>{t`EmDash ${plan.origin.createdByEmDashVersion}`}</dd>
					</div>
					<div>
						<dt className="text-kumo-subtle">{t`Source site ID`}</dt>
						<dd>
							<span className="font-mono text-xs" dir="ltr">
								{plan.origin.siteId}
							</span>
						</dd>
					</div>
					<div>
						<dt className="text-kumo-subtle">{t`Size`}</dt>
						<dd>
							{t`${formatFileSize(plan.bytes.media)} of media, ${formatFileSize(plan.bytes.records)} of records`}
						</dd>
					</div>
				</dl>
				<div className="mt-4">
					<CopyableDigest label={t`Package digest`} digest={plan.packageDigest} />
				</div>
			</SettingRow>

			<SettingRow>
				<h4 className="text-sm font-medium leading-5">{t`What will be imported`}</h4>
				<dl className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-3">
					{counts.map((kind) => (
						<div key={kind} className="flex justify-between gap-2">
							<dt className="text-kumo-subtle">{recordKindLabel(i18n, kind)}</dt>
							<dd className="tabular-nums">{i18n.number(plan.counts[kind] ?? 0)}</dd>
						</div>
					))}
				</dl>
			</SettingRow>

			{plan.principals.length > 0 ? (
				<SettingRow>
					<div className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between">
						<h4 className="text-sm font-medium leading-5">{t`Authors`}</h4>
						<span className="text-sm text-kumo-subtle">
							{t`${i18n.number(matched)} of ${i18n.number(plan.principals.length)} matched by email`}
						</span>
					</div>
					<p className="mt-1 max-w-2xl text-sm leading-5 text-pretty text-kumo-subtle">
						{t`Users are not transferred. Choose the user on this site who should own each author’s content. Content of authors you don’t map will have no author.`}
					</p>
					<ul className="mt-3 divide-y divide-kumo-line rounded-lg border border-kumo-line">
						{plan.principals.map((principal) => {
							const mapped = decisions.principalMappings[principal.id] ?? null;
							const autoMatched =
								principal.suggestedUserId !== undefined && mapped === principal.suggestedUserId;
							return (
								<li
									key={principal.id}
									className="flex flex-col gap-3 p-3 sm:flex-row sm:items-center sm:justify-between"
								>
									<div className="min-w-0">
										<p className="truncate text-sm font-medium" dir="auto">
											{principal.displayName}
										</p>
										<p className="truncate text-sm text-kumo-subtle">
											{principal.email ? (
												<span dir="ltr">{principal.email}</span>
											) : (
												t`No email address`
											)}
											{" · "}
											{plural(principal.references, { one: "# reference", other: "# references" })}
										</p>
									</div>
									<div className="flex shrink-0 items-center gap-2">
										{autoMatched ? <Badge variant="success">{t`Matched by email`}</Badge> : null}
										<Select
											aria-label={t`User for ${principal.displayName}`}
											className="w-56"
											value={mapped ?? UNMAPPED}
											items={userItems}
											disabled={locked}
											onValueChange={(value) =>
												updateDecisions({
													...decisions,
													principalMappings: {
														...decisions.principalMappings,
														[principal.id]: value ? String(value) : null,
													},
												})
											}
										/>
									</div>
								</li>
							);
						})}
					</ul>
				</SettingRow>
			) : null}

			<SettingRow>
				<h4 className="text-sm font-medium leading-5">{t`Site identity`}</h4>
				<div className="mt-3 grid gap-4 sm:grid-cols-2">
					<SettingChoiceGroup
						legend={t`Site title`}
						values={plan.settings.title}
						value={decisions.siteTitle}
						disabled={locked}
						onChange={(siteTitle) => updateDecisions({ ...decisions, siteTitle })}
					/>
					<SettingChoiceGroup
						legend={t`Tagline`}
						values={plan.settings.tagline}
						value={decisions.siteTagline}
						disabled={locked}
						onChange={(siteTagline) => updateDecisions({ ...decisions, siteTagline })}
					/>
				</div>
			</SettingRow>

			{scaffoldItems && scaffoldItems.length > 0 ? (
				<SettingRow>
					<h4 className="text-sm font-medium leading-5">{t`Starter content that will be removed`}</h4>
					<p className="mt-1 max-w-2xl text-sm leading-5 text-pretty text-kumo-subtle">
						{t`This site was set up with starter content. It has no entries of its own, and the import deletes it before adding the package’s content.`}
					</p>
					<ScaffoldList items={scaffoldItems} known={capabilities.portableDomain.seededScaffold} />
				</SettingRow>
			) : null}

			{changes.length > 0 ? (
				<SettingRow>
					<h4 className="text-sm font-medium leading-5">{t`Differences from the source site`}</h4>
					<p className="mt-1 max-w-2xl text-sm leading-5 text-pretty text-kumo-subtle">
						{t`The exported package and this import change the content in these ways.`}
					</p>
					<ul className="mt-2 grid gap-2 text-sm leading-5">
						{changes.map((change) => (
							<li key={change.code}>
								<p className="font-medium">
									{transformationLabel(i18n, change.code)}
									{change.count > 1 ? ` (${i18n.number(change.count)})` : null}
								</p>
								{change.kinds.length > 0 ? (
									<ul className="flex flex-wrap gap-x-3 text-kumo-subtle">
										{change.kinds.map((kind) => (
											<li key={kind}>{recordKindLabel(i18n, kind)}</li>
										))}
									</ul>
								) : null}
								{change.locales.length > 0 ? (
									<ul className="flex flex-wrap gap-x-4 gap-y-1 text-kumo-subtle">
										{change.locales.map(({ from, to }) => (
											<li key={from}>
												<Trans>
													<bdi>{from}</bdi> becomes <bdi>{to}</bdi>
												</Trans>
											</li>
										))}
									</ul>
								) : null}
							</li>
						))}
					</ul>
				</SettingRow>
			) : null}

			<IssueList
				title={t`Blockers`}
				description={t`The import can’t start until these are resolved.`}
				issues={plan.blockers}
				variant="error"
			/>
			<IssueList
				title={t`Warnings`}
				description={t`The import can go ahead, but check these first.`}
				issues={plan.warnings}
				variant="alert"
			/>

			<SettingRow>
				{notice === "plan-changed" ? (
					<Banner
						className="mb-3"
						variant="alert"
						role="alert"
						title={t`The import plan changed`}
						description={t`The plan was changed somewhere else, such as from the command line or an AI assistant, after this page loaded it. Review it again, then start the import.`}
					/>
				) : started ? (
					<Banner
						className="mb-3"
						variant="alert"
						role="alert"
						title={t`This import has already started`}
						description={t`It was started somewhere else, so its plan can no longer be changed. Its progress will appear here.`}
					/>
				) : null}
				{reloadMutation.error ? (
					<Banner
						className="mb-3"
						variant="error"
						role="alert"
						title={t`Couldn’t reload the import plan`}
						description={getMutationError(reloadMutation.error) ?? undefined}
						action={
							<Button size="sm" variant="secondary" onClick={() => reloadMutation.mutate()}>
								{t`Try again`}
							</Button>
						}
					/>
				) : null}
				{decisionsError ? (
					<Banner
						className="mb-3"
						variant="error"
						role="alert"
						title={t`Couldn’t update the plan`}
						description={getMutationError(decisionsError) ?? undefined}
					/>
				) : null}
				<div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-end">
					{decisionsMutation.isPending || reloadMutation.isPending ? (
						<span className="flex items-center gap-2 text-sm text-kumo-subtle" role="status">
							<Loader size="sm" />
							{reloadMutation.isPending ? t`Reloading the plan…` : t`Updating the plan…`}
						</span>
					) : plan.blockers.length > 0 ? (
						<span className="text-sm text-kumo-danger">{t`Resolve the blockers to continue.`}</span>
					) : null}
					<Button
						variant="primary"
						disabled={!confirmable}
						onClick={() => {
							executeMutation.reset();
							setNotice(null);
							setConfirmOpen(true);
						}}
					>
						{t`Start import`}
					</Button>
				</div>
			</SettingRow>

			<ConfirmDialog
				open={confirmOpen}
				onClose={() => {
					setConfirmOpen(false);
					executeMutation.reset();
				}}
				role="alertdialog"
				title={t`Import this package?`}
				description={
					scaffoldItems && scaffoldItems.length > 0
						? t`The starter content listed above is deleted and replaced with the package’s content. The import can’t be undone once it starts; to go back you would need a backup of this site.`
						: t`The package’s content is written to this site. The import can’t be undone once it starts; to go back you would need a backup of this site.`
				}
				confirmLabel={t`Start import`}
				pendingLabel={t`Starting…`}
				variant="primary"
				preventCloseWhilePending
				isPending={executeMutation.isPending}
				error={executeMutation.error}
				onConfirm={() => executeMutation.mutate()}
			>
				<p className="mt-3 text-sm leading-5 text-kumo-subtle">
					{t`Editing on this site is paused until the import finishes.`}
				</p>
			</ConfirmDialog>
		</>
	);
}

function scaffoldTypeRank(type: string): number {
	const index = (SCAFFOLD_TYPE_ORDER as readonly string[]).indexOf(type);
	return index === -1 ? SCAFFOLD_TYPE_ORDER.length : index;
}

function ScaffoldList({
	items,
	known,
}: {
	items: ReadonlyArray<{ type: string; id: string }>;
	known: readonly ScaffoldItem[];
}) {
	const { i18n } = useLingui();
	const byKey = new Map(known.map((item) => [`${item.type}:${item.id}`, item]));
	const groups = new Map<string, string[]>();
	for (const item of items) {
		const found = byKey.get(`${item.type}:${item.id}`);
		const names = groups.get(item.type) ?? [];
		names.push(found ? scaffoldItemName(i18n, found, byKey) : item.id);
		groups.set(item.type, names);
	}
	const types = [...groups.keys()].toSorted((a, b) => scaffoldTypeRank(a) - scaffoldTypeRank(b));

	return (
		<dl className="mt-3 grid gap-3 text-sm leading-5">
			{types.map((type) => {
				const names = groups.get(type)!;
				return (
					<div key={type}>
						<dt className="flex items-baseline gap-2">
							<span className="font-medium">{recordKindLabel(i18n, type)}</span>
							<span className="text-kumo-subtle tabular-nums">{i18n.number(names.length)}</span>
						</dt>
						<dd className="mt-1">
							<ScaffoldNames names={names.slice(0, SCAFFOLD_NAMES_SHOWN)} />
							{names.length > SCAFFOLD_NAMES_SHOWN ? (
								<details className="mt-1">
									<summary className="cursor-pointer text-kumo-subtle">
										{plural(names.length - SCAFFOLD_NAMES_SHOWN, {
											one: "Show # more",
											other: "Show # more",
										})}
									</summary>
									<ScaffoldNames names={names.slice(SCAFFOLD_NAMES_SHOWN)} />
								</details>
							) : null}
						</dd>
					</div>
				);
			})}
		</dl>
	);
}

function ScaffoldNames({ names }: { names: readonly string[] }) {
	return (
		<ul className="flex flex-wrap gap-x-4 gap-y-1 text-kumo-subtle">
			{names.map((name, index) => (
				<li key={`${index}:${name}`} className="max-w-full truncate" dir="auto">
					{name}
				</li>
			))}
		</ul>
	);
}

function SettingChoiceGroup({
	legend,
	values,
	value,
	disabled,
	onChange,
}: {
	legend: string;
	values: { package?: string; target?: string };
	value: SettingChoice;
	disabled: boolean;
	onChange: (value: SettingChoice) => void;
}) {
	const { t } = useLingui();
	const packageValue = values.package ?? "";
	const targetValue = values.target ?? "";
	return (
		<Radio.Group
			legend={legend}
			value={value}
			disabled={disabled}
			onValueChange={(next: SettingChoice) => onChange(next)}
		>
			<Radio.Item
				value="package"
				label={packageValue ? t`From the package: “${packageValue}”` : t`From the package (empty)`}
			/>
			<Radio.Item
				value="target"
				label={targetValue ? t`Keep this site’s: “${targetValue}”` : t`Keep this site’s (empty)`}
			/>
		</Radio.Group>
	);
}

function IssueList({
	title,
	description,
	issues,
	variant,
}: {
	title: string;
	description: string;
	issues: readonly PlanIssue[];
	variant: "error" | "alert";
}) {
	const { t, i18n } = useLingui();
	if (issues.length === 0) return null;
	return (
		<SettingRow>
			<Banner
				variant={variant}
				role={variant === "error" ? "alert" : undefined}
				title={title}
				description={description}
			/>
			<ul className="mt-3 grid gap-2 text-sm leading-5">
				{issues.map((issue, index) => (
					<li key={`${issue.code}:${issue.kind ?? ""}:${issue.id ?? ""}:${index}`}>
						<p className="font-medium">
							{issueLabel(i18n, issue.code)}
							{issue.count !== undefined && issue.count > 1
								? ` (${i18n.number(issue.count)})`
								: null}
						</p>
						<p className="text-kumo-subtle" dir="auto">
							{issue.kind ? recordKindLabel(i18n, issue.kind) : null}
							{issue.kind && issue.id ? " · " : null}
							{issue.id ? (
								<span className="font-mono text-xs" dir="ltr">
									{issue.id}
								</span>
							) : null}
						</p>
						<details className="text-kumo-subtle">
							<summary className="cursor-pointer text-xs">{t`Technical details`}</summary>
							<p className="mt-1 text-xs" dir="ltr">
								{issue.message}
							</p>
						</details>
					</li>
				))}
			</ul>
		</SettingRow>
	);
}
