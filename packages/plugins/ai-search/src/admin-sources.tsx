import { Button, Checkbox, Input, Loader } from "@cloudflare/kumo";
import { CaretDown } from "@phosphor-icons/react";
import * as React from "react";

import {
	AUTHORS,
	enabledSourceInfos,
	kindOf,
	needsFields,
	type Settings,
	sourceOf,
	withSource,
} from "./admin-api.js";
import { Row, RowText, Section } from "./admin-ui.js";
import type { Config, SourceConfig, SourceInfo, TaxonomyInfo } from "./config.js";

interface DraftProps {
	settings: Settings;
	draft: Config;
	onChange: (config: Config) => void;
}

/** Whether the saved configuration already includes the source, with a checked address. */
function isSavedSource(settings: Settings, id: string): boolean {
	return settings.saved && Boolean(settings.config.sources[id]?.enabled);
}

export function ContentTab(
	props: DraftProps & {
		counts: Record<string, number> | null;
		/** Sources the running build has still to process. */
		building: string[];
		/** Opens the setup wizard at the source, to check its public address. */
		onConfigure: (draft: Config, id: string) => void;
	},
) {
	const { settings } = props;
	const row = (info: SourceInfo) => (
		<SourceRow
			key={info.id}
			{...props}
			info={info}
			count={props.counts?.[info.id]}
			building={props.building.includes(info.id)}
		/>
	);
	return (
		<div className="space-y-6">
			<Section
				title="Content to search"
				description="Published entries of each checked collection appear in search."
			>
				{settings.sources.filter((info) => info.id !== AUTHORS).map(row)}
			</Section>
			<Section
				title="Also show as results"
				description="Pages on your site that appear as their own results."
			>
				{settings.sources.filter((info) => info.id === AUTHORS).map(row)}
			</Section>
		</div>
	);
}

/**
 * Related names added to a collection's searchable text: credited authors and
 * terms from the taxonomies attached to the collection.
 */
export function RelatedNames(props: {
	info: SourceInfo;
	taxonomies: TaxonomyInfo[];
	draft: Config;
	onChange: (config: Config) => void;
}) {
	const { info, draft } = props;
	const source = sourceOf(draft, info.id);
	const included = source.taxonomies ?? [];
	const attached = props.taxonomies.filter((taxonomy) => taxonomy.collections.includes(info.id));
	const change = (next: Partial<SourceConfig>) => props.onChange(withSource(draft, info.id, next));

	return (
		<fieldset>
			<legend className="mb-1.5 text-xs font-medium text-kumo-subtle">Also searchable by</legend>
			<div className="flex flex-wrap gap-x-4 gap-y-2">
				<Checkbox
					aria-label="Author names"
					label="Author names"
					checked={source.includeAuthorNames ?? false}
					onCheckedChange={(includeAuthorNames) => change({ includeAuthorNames })}
				/>
				{attached.map((taxonomy) => (
					<Checkbox
						key={taxonomy.name}
						aria-label={taxonomy.label}
						label={taxonomy.label}
						checked={included.includes(taxonomy.name)}
						onCheckedChange={(on) =>
							change({
								taxonomies: on
									? [...included, taxonomy.name]
									: included.filter((name) => name !== taxonomy.name),
							})
						}
					/>
				))}
			</div>
			<p className="mt-1.5 text-xs text-kumo-subtle">
				{attached.length > 0
					? "Renamed or deleted authors and terms, and terms assigned from the editor sidebar, reach search when the entry is next saved or the index is rebuilt."
					: "Renamed or deleted authors reach search when the entry is next saved or the index is rebuilt."}
			</p>
		</fieldset>
	);
}

function SourceRow(
	props: DraftProps & {
		info: SourceInfo;
		count: number | undefined;
		building: boolean;
		onConfigure: (draft: Config, id: string) => void;
	},
) {
	const { info, settings, draft } = props;
	const source = sourceOf(draft, info.id);
	const isAuthors = info.id === AUTHORS;
	const [open, setOpen] = React.useState(false);
	const panelId = React.useId();

	const setEnabled = (enabled: boolean) => {
		const next = withSource(draft, info.id, { enabled });
		if (enabled && !isSavedSource(settings, info.id)) props.onConfigure(next, info.id);
		else props.onChange(next);
	};
	let status: React.ReactNode = "Off";
	if (source.enabled && !isSavedSource(settings, info.id)) {
		status = <span className="text-kumo-warning">Not saved</span>;
	} else if (props.building) {
		status = (
			<>
				<Loader size="sm" />
				Indexing
			</>
		);
	} else if (source.enabled) {
		status =
			props.count === undefined
				? "On"
				: `${props.count.toLocaleString()} ${props.count === 1 ? "record" : "records"}`;
	}

	const expanded = open && source.enabled;
	return (
		<div>
			<Row>
				<div className="min-w-0 flex-1">
					<Checkbox
						aria-label={info.label}
						label={<RowText title={info.label} description={info.description} />}
						checked={source.enabled}
						onCheckedChange={setEnabled}
					/>
				</div>
				<span className="flex items-center gap-1.5 text-xs text-kumo-subtle tabular-nums">
					{status}
				</span>
				<Button
					variant="ghost"
					size="sm"
					shape="square"
					aria-label={`${info.label} details`}
					aria-expanded={expanded}
					aria-controls={panelId}
					disabled={!source.enabled}
					icon={<CaretDown className={expanded ? "rotate-180 transition" : "transition"} />}
					onClick={() => setOpen(!open)}
				/>
			</Row>
			{expanded && (
				<div id={panelId} className="space-y-3 border-t border-kumo-line bg-kumo-tint px-4 py-3">
					{info.fields.length > 0 && (
						<fieldset>
							<legend className="mb-1.5 text-xs font-medium text-kumo-subtle">
								Searchable fields
							</legend>
							<div className="flex flex-wrap gap-x-4 gap-y-2">
								<FieldCheckboxes info={info} draft={draft} onChange={props.onChange} />
							</div>
						</fieldset>
					)}
					{!isAuthors && (
						<RelatedNames
							info={info}
							taxonomies={settings.taxonomies}
							draft={draft}
							onChange={props.onChange}
						/>
					)}
					{isAuthors && (
						<p className="text-sm text-kumo-subtle">
							Each result includes the author's name and biography.
						</p>
					)}
					<div className="flex flex-wrap items-center gap-2 text-sm">
						<span className="text-xs font-medium text-kumo-subtle">Public address</span>
						{source.urlTemplate ? (
							<>
								<code className="rounded bg-kumo-base px-1.5 py-0.5 text-xs" dir="ltr">
									{source.urlTemplate}
								</code>
								<Button variant="ghost" size="xs" onClick={() => props.onConfigure(draft, info.id)}>
									Change
								</Button>
							</>
						) : (
							<span className="text-kumo-subtle">From the collection's URL pattern</span>
						)}
					</div>
				</div>
			)}
		</div>
	);
}

/** A checkbox for each of a source's text fields. */
export function FieldCheckboxes(props: {
	info: SourceInfo;
	draft: Config;
	onChange: (config: Config) => void;
}) {
	const { info, draft } = props;
	const { fields } = sourceOf(draft, info.id);
	return info.fields.map((field) => (
		<Checkbox
			key={field.slug}
			aria-label={field.label}
			label={field.label}
			checked={fields.includes(field.slug)}
			onCheckedChange={(checked) =>
				props.onChange(
					withSource(draft, info.id, {
						fields: checked
							? [...fields, field.slug]
							: fields.filter((slug) => slug !== field.slug),
					}),
				)
			}
		/>
	));
}

export function RelevanceTab(props: DraftProps) {
	const { settings, draft } = props;
	const enabled = enabledSourceInfos(settings, draft);
	return (
		<div className="space-y-6">
			<Section
				title="Result priority"
				description="When results of different types match, higher numbers rank first. This weighs whole results, not fields."
				footer="Changing a priority re-uploads every result of that type."
			>
				{enabled.map((info) => (
					<Row key={info.id}>
						<div className="min-w-0 flex-1">
							<RowText title={info.label} description={kindOf(info.id)} />
						</div>
						<div className="w-20">
							<Input
								size="sm"
								aria-label={`Priority for ${info.label}`}
								type="number"
								min={0}
								max={10}
								value={String(sourceOf(draft, info.id).weight)}
								onChange={(event) =>
									props.onChange(
										withSource(draft, info.id, {
											weight: Math.min(
												10,
												Math.max(0, Math.round(Number(event.target.value) || 0)),
											),
										}),
									)
								}
							/>
						</div>
					</Row>
				))}
			</Section>
		</div>
	);
}

export function SaveBar(props: {
	settings: Settings;
	draft: Config;
	saving: boolean;
	/** What saving changes in the index, shown while there are unsaved changes. */
	impact?: React.ReactNode;
	onSave: () => void;
}) {
	const { settings, draft } = props;
	const problems = settings.sources
		.filter((info) => needsFields(info, draft))
		.map((info) => `Choose at least one searchable field for ${info.label}.`);
	if (enabledSourceInfos(settings, draft).length === 0) {
		problems.unshift("Choose at least one source.");
	}
	const dirty = JSON.stringify(draft) !== JSON.stringify(settings.config);

	return (
		<div className="space-y-3">
			{dirty && problems.length === 0 && props.impact}
			<div className="flex flex-wrap items-center justify-end gap-3">
				{problems.map((problem) => (
					<p key={problem} role="alert" className="me-auto text-sm text-kumo-danger">
						{problem}
					</p>
				))}
				<span className="text-sm text-kumo-subtle" aria-live="polite">
					{dirty ? "Unsaved changes" : "All changes saved"}
				</span>
				<Button
					variant="primary"
					size="sm"
					loading={props.saving}
					disabled={!dirty || problems.length > 0}
					onClick={props.onSave}
				>
					Save changes
				</Button>
			</div>
		</div>
	);
}
