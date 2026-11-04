import { Badge, Banner, Button, Link, LinkButton, Loader } from "@cloudflare/kumo";
import { ArrowClockwise, CaretDown } from "@phosphor-icons/react";
import * as React from "react";

import {
	type Activity,
	type ActivityItem,
	type AttentionGroup,
	type AttentionRecord,
	call,
	editUrl,
	errorMessage,
	type RetryOutcome,
	relativeTime,
	type Status,
} from "./admin-api.js";
import { BuildProgress } from "./admin-build.js";
import { Row, RowText, Section } from "./admin-ui.js";
import { itemState } from "./ingestion.js";

function ItemStatus(props: { status: ActivityItem["status"] }) {
	switch (itemState(props.status)) {
		case "failed":
			return <Badge variant="error">Failed</Badge>;
		case "indexed":
			return <span className="text-xs text-kumo-subtle">Indexed</span>;
		case "processing":
			return (
				<span className="flex items-center gap-1.5 text-xs text-kumo-subtle">
					<Loader size="sm" />
					Processing
				</span>
			);
	}
}

const OUTCOME_MESSAGE: Record<RetryOutcome, string> = {
	synced: "Uploaded. AI Search will finish processing it shortly.",
	failed: "The upload failed again. It stays in the list below.",
	busy: "AI Search is busy. Try again in a minute.",
};

/** The index's state: totals, the running build, records that need attention, and recent updates. */
export function ActivityPanel(props: {
	status: Status;
	labels: Map<string, string>;
	rebuilding: boolean;
	onRebuild: () => void;
	onChanged: () => Promise<void>;
}) {
	const { status } = props;
	const [activity, setActivity] = React.useState<Activity | null>(null);
	const [error, setError] = React.useState<string | null>(null);
	const [notice, setNotice] = React.useState<string | null>(null);
	const [retrying, setRetrying] = React.useState<string | null>(null);

	const load = React.useCallback(async () => {
		try {
			setActivity(await call<Activity>("activity"));
			setError(null);
		} catch (loadError) {
			setError(errorMessage(loadError));
		}
	}, []);

	const building = Boolean(status.build);
	const { indexed, processing, failed } = status.totals;
	const version = [building, status.lastActivity, indexed, processing, failed].join("|");
	React.useEffect(() => {
		void load();
	}, [load, version]);

	const retry = async (item: { source: string; id: string }) => {
		const key = `${item.source}/${item.id}`;
		setRetrying(key);
		setNotice(null);
		try {
			const { outcome } = await call<{ outcome: RetryOutcome }>("entry/sync", item);
			setNotice(OUTCOME_MESSAGE[outcome]);
			await Promise.all([load(), props.onChanged()]);
		} catch (retryError) {
			setError(errorMessage(retryError));
		} finally {
			setRetrying(null);
		}
	};

	const label = (source: string) => props.labels.get(source) ?? source;

	return (
		<div className="space-y-6">
			<IndexSummary status={status} rebuilding={props.rebuilding} onRebuild={props.onRebuild} />
			{status.build && <BuildProgress build={status.build} labels={props.labels} />}
			{error && <Banner variant="error" description={error} />}
			{notice && (
				<p className="text-sm" role="status">
					{notice}
				</p>
			)}

			{!activity ? (
				!error && <Loader />
			) : (
				<>
					{(activity.attention.length > 0 || activity.unlisted > 0) && (
						<Section
							title="Needs attention"
							footer={activity.attention.length > 0 && unlistedNote(activity.unlisted, true)}
						>
							{activity.attention.length === 0 && (
								<Row>
									<span className="text-sm text-kumo-subtle">
										{unlistedNote(activity.unlisted, false)}
									</span>
								</Row>
							)}
							{activity.attention.map((group) => (
								<AttentionGroupRow
									key={`${group.stage}:${group.reason}`}
									group={group}
									label={label}
									retrying={retrying}
									onRetry={(record) => void retry(record)}
								/>
							))}
						</Section>
					)}

					<Section title="Recent updates">
						{activity.recent.length === 0 ? (
							<Row>
								<span className="text-sm text-kumo-subtle">Nothing has been indexed yet.</span>
							</Row>
						) : (
							activity.recent.map((item) => {
								const details = [
									label(item.source),
									languageName(item.locale),
									relativeTime(item.updatedAt),
								];
								return (
									<Row key={`${item.source}/${item.id}`}>
										<div className="min-w-0 flex-1">
											<RowText
												title={item.title}
												description={details.filter(Boolean).join(" · ")}
											/>
										</div>
										<ItemStatus status={item.status} />
									</Row>
								);
							})
						)}
					</Section>
				</>
			)}
		</div>
	);
}

function IndexSummary(props: { status: Status; rebuilding: boolean; onRebuild: () => void }) {
	const { status } = props;
	const synced = relativeTime(status.lastActivity ?? undefined);
	const figures: Array<[string, number]> = [
		["Indexed", status.totals.indexed],
		["Processing", status.totals.processing],
		["Need attention", status.totals.failed],
	];
	const headingId = React.useId();

	return (
		<section
			aria-labelledby={headingId}
			className="space-y-3 rounded-xl border border-kumo-line bg-kumo-base px-4 py-3"
		>
			<div>
				<h2 id={headingId} className="text-sm font-semibold">
					Index activity
				</h2>
				{synced && <p className="text-xs text-kumo-subtle">{`Last synced ${synced}`}</p>}
			</div>
			<dl className="grid grid-cols-3 gap-3">
				{figures.map(([name, value]) => (
					<div key={name} className="min-w-0">
						<dt className="truncate text-xs text-kumo-subtle">{name}</dt>
						<dd className="text-lg font-semibold tabular-nums">{value.toLocaleString()}</dd>
					</div>
				))}
			</dl>
			<div className="flex flex-wrap gap-2">
				<Button
					variant="outline"
					size="sm"
					icon={<ArrowClockwise />}
					title="Checks every record and uploads the ones that are missing or out of date"
					loading={props.rebuilding}
					disabled={Boolean(status.build)}
					onClick={props.onRebuild}
				>
					Rebuild index
				</Button>
				{status.dashboardUrl && (
					<LinkButton variant="ghost" size="sm" href={status.dashboardUrl} external>
						Open in Cloudflare
					</LinkButton>
				)}
			</div>
		</section>
	);
}

function unlistedNote(count: number, more: boolean): string | false {
	if (count === 0) return false;
	const records = count === 1 ? "record is" : "records are";
	return `${count.toLocaleString()}${more ? " more" : ""} failed ${records} not shown. Rebuild the index to retry every failed record.`;
}

function groupDetail(group: AttentionGroup): string {
	const records = `${group.count.toLocaleString()} ${group.count === 1 ? "record" : "records"}`;
	if (group.stage === "processing") return `${records} · AI Search could not process`;
	return `${records} · Upload failed · ${
		group.retrying ? "Retrying automatically" : "Automatic retries stopped"
	}`;
}

function AttentionGroupRow(props: {
	group: AttentionGroup;
	label: (source: string) => string;
	/** Key of the record being retried, if any. */
	retrying: string | null;
	onRetry: (record: AttentionRecord) => void;
}) {
	const { group } = props;
	const [open, setOpen] = React.useState(false);
	const panelId = React.useId();
	const hidden = group.count - group.records.length;

	return (
		<div>
			<Row>
				<div className="min-w-0 flex-1">
					<p className="text-sm font-medium wrap-break-word">{group.reason || "No reason given"}</p>
					<p className="text-xs text-kumo-subtle">{groupDetail(group)}</p>
				</div>
				<Button
					variant="ghost"
					size="sm"
					shape="square"
					aria-label={`Show records: ${group.reason || "No reason given"}`}
					aria-expanded={open}
					aria-controls={panelId}
					icon={<CaretDown className={open ? "rotate-180 transition" : "transition"} />}
					onClick={() => setOpen(!open)}
				/>
			</Row>
			{open && (
				<div
					id={panelId}
					className="divide-y divide-kumo-line border-t border-kumo-line bg-kumo-tint"
				>
					{group.records.map((record) => {
						const key = `${record.source}/${record.id}`;
						const href = record.title === null ? null : editUrl(record.source, record.id);
						return (
							<Row key={key}>
								<div className="min-w-0 flex-1">
									<RowText
										title={
											href ? (
												<Link variant="inline" href={href}>
													{record.title}
												</Link>
											) : (
												(record.title ?? "Deleted record")
											)
										}
										description={props.label(record.source)}
									/>
								</div>
								<Button
									variant="outline"
									size="sm"
									loading={props.retrying === key}
									onClick={() => props.onRetry(record)}
								>
									Retry
								</Button>
							</Row>
						);
					})}
					{hidden > 0 && (
						<Row>
							<span className="text-xs text-kumo-subtle">
								{`And ${hidden.toLocaleString()} more`}
							</span>
						</Row>
					)}
				</div>
			)}
		</div>
	);
}

function languageName(locale: string): string {
	try {
		return new Intl.DisplayNames(undefined, { type: "language" }).of(locale) ?? locale;
	} catch {
		return locale;
	}
}
