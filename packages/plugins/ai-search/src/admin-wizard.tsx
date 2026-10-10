import {
	Banner,
	Button,
	Checkbox,
	Input,
	LinkButton,
	Loader,
	Meter,
	Select,
} from "@cloudflare/kumo";
import { ArrowSquareOut, Check } from "@phosphor-icons/react";
import * as React from "react";

import {
	AUTHORS,
	call,
	enabledSourceInfos,
	type Example,
	errorMessage,
	needsFields,
	type Settings,
	type Status,
	sourceOf,
	withoutInvalidAddresses,
	withSource,
} from "./admin-api.js";
import { BuildProgress } from "./admin-build.js";
import { IndexImpactNote } from "./admin-impact.js";
import { FieldCheckboxes, RelatedNames } from "./admin-sources.js";
import { Row, RowText, Section } from "./admin-ui.js";
import type { Config, SourceInfo, TaxonomyInfo } from "./config.js";
import { indexImpact } from "./impact.js";
import { URL_TEMPLATE } from "./url-template.js";

const STEPS = ["Choose content", "Configure", "Review", "Build"] as const;

type Step =
	| { name: "choose" }
	| { name: "configure"; index: number }
	| { name: "review" }
	| { name: "build" };

/**
 * Walks the admin through choosing sources, showing where an example record of
 * each one links to, and building the index. Nothing is saved until the
 * last step.
 */
export function SetupWizard(props: {
	settings: Settings;
	status: Status;
	initialDraft: Config;
	/** Opens the wizard at this source's configure step instead of the first step. */
	startAt?: string;
	onSave: (config: Config) => Promise<void>;
	onClose: () => void;
}) {
	const { settings, status } = props;
	const [draft, setDraft] = React.useState(props.initialDraft);
	const [step, setStep] = React.useState<Step>(() => {
		const index = settings.sources
			.filter((info) => sourceOf(props.initialDraft, info.id).enabled)
			.findIndex((info) => info.id === props.startAt);
		return index >= 0 ? { name: "configure", index } : { name: "choose" };
	});
	const [error, setError] = React.useState<string | null>(null);
	const [saving, setSaving] = React.useState(false);
	/** The sources the save sent to the index. */
	const [built, setBuilt] = React.useState<string[]>([]);
	const [firstSetup] = React.useState(!settings.saved);

	const selected = enabledSourceInfos(settings, draft);
	const labels = new Map(settings.sources.map((info) => [info.id, info.label]));

	const change = (next: Config) => {
		setError(null);
		setDraft(next);
	};
	const go = (next: Step) => {
		setError(null);
		setStep(next);
	};
	const nextAfter = (index: number): Step =>
		index + 1 < selected.length ? { name: "configure", index: index + 1 } : { name: "review" };

	const build = async () => {
		setSaving(true);
		setError(null);
		const config = withoutInvalidAddresses(draft, settings.config);
		const changed = settings.saved
			? indexImpact(settings.config, config).map((impact) => impact.source)
			: [];
		try {
			await props.onSave(config);
			setBuilt(changed.length > 0 ? changed : selected.map((info) => info.id));
			setStep({ name: "build" });
		} catch (saveError) {
			setError(errorMessage(saveError));
		} finally {
			setSaving(false);
		}
	};

	const stepIndex = { choose: 0, configure: 1, review: 2, build: 3 }[step.name];

	return (
		<div className="space-y-5">
			<Stepper current={stepIndex} />

			{error && (
				<div role="alert">
					<Banner variant="error" description={error} />
				</div>
			)}

			{step.name === "choose" && (
				<ChooseStep
					settings={settings}
					draft={draft}
					onChange={change}
					onBack={props.onClose}
					onNext={() =>
						selected.length > 0
							? go({ name: "configure", index: 0 })
							: setError("Choose at least one source to continue.")
					}
				/>
			)}

			{step.name === "configure" && selected[step.index] && (
				<ConfigureStep
					key={selected[step.index]?.id}
					info={selected[step.index] as SourceInfo}
					position={`${step.index + 1} of ${selected.length}`}
					taxonomies={settings.taxonomies}
					draft={draft}
					onChange={change}
					onBack={() =>
						go(step.index === 0 ? { name: "choose" } : { name: "configure", index: step.index - 1 })
					}
					onSkip={(id) => {
						const next = withSource(draft, id, { enabled: false });
						setDraft(next);
						const remaining = enabledSourceInfos(settings, next);
						go(
							remaining.length === 0
								? { name: "choose" }
								: step.index < remaining.length
									? { name: "configure", index: step.index }
									: { name: "review" },
						);
					}}
					onNext={(problem) => (problem ? setError(problem) : go(nextAfter(step.index)))}
				/>
			)}

			{step.name === "review" && (
				<ReviewStep
					selected={selected}
					draft={draft}
					firstSetup={firstSetup}
					taxonomyLabels={
						new Map(settings.taxonomies.map((taxonomy) => [taxonomy.name, taxonomy.label]))
					}
					saving={saving}
					impact={
						<IndexImpactNote
							saved={settings.saved ? settings.config : null}
							draft={draft}
							labels={labels}
							counts={status.counts}
						/>
					}
					changesIndex={!settings.saved || indexImpact(settings.config, draft).length > 0}
					onEdit={(index) => go({ name: "configure", index })}
					onBack={() => go({ name: "configure", index: selected.length - 1 })}
					onBuild={() => void build()}
				/>
			)}

			{step.name === "build" && (
				<BuildStep status={status} sources={built} labels={labels} onClose={props.onClose} />
			)}
		</div>
	);
}

function ChooseStep(props: {
	settings: Settings;
	draft: Config;
	onChange: (config: Config) => void;
	onBack: () => void;
	onNext: () => void;
}) {
	const { settings, draft } = props;
	const row = (info: SourceInfo) => (
		<Row key={info.id}>
			<Checkbox
				aria-label={info.label}
				label={<RowText title={info.label} description={info.description} />}
				checked={sourceOf(draft, info.id).enabled}
				onCheckedChange={(enabled) => props.onChange(withSource(draft, info.id, { enabled }))}
			/>
		</Row>
	);
	return (
		<section className="space-y-5">
			<StepHeader
				title="What should visitors find?"
				description="Choose the content and public pages to include in your site's search."
			/>
			<Section title="Content collections">
				{settings.sources.filter((info) => info.id !== AUTHORS).map(row)}
			</Section>
			<Section
				title="Also include public pages"
				description="These need existing pages on your site. You will check their addresses next."
			>
				{settings.sources.filter((info) => info.id === AUTHORS).map(row)}
			</Section>
			<StepActions>
				<Button variant="ghost" onClick={props.onBack}>
					Back to settings
				</Button>
				<Button variant="primary" onClick={props.onNext}>
					Configure selected content
				</Button>
			</StepActions>
		</section>
	);
}

function ConfigureStep(props: {
	info: SourceInfo;
	position: string;
	taxonomies: TaxonomyInfo[];
	draft: Config;
	onChange: (config: Config) => void;
	onBack: () => void;
	onSkip: (id: string) => void;
	onNext: (problem: string | null) => void;
}) {
	const { info, draft } = props;
	const source = sourceOf(draft, info.id);
	const isAuthors = info.id === AUTHORS;
	const address = source.urlTemplate ?? "";
	const templateValid = !isAuthors || URL_TEMPLATE.test(address);

	const next = () => {
		if (needsFields(info, draft)) return props.onNext("Choose at least one searchable field.");
		if (!templateValid)
			return props.onNext("Use a site path containing {slug}, such as /authors/{slug}.");
		return props.onNext(null);
	};

	return (
		<section className="space-y-5">
			<StepHeader
				eyebrow={`Source ${props.position}`}
				title={`Set up ${info.label}`}
				description={
					isAuthors
						? "Include these as their own results, alongside matching entries."
						: "Only published entries will appear in public search."
				}
			/>

			{isAuthors ? (
				<Input
					label="Public page address"
					description="Use {slug} for the author's slug. This points to an existing page; it does not create one."
					value={address}
					dir="ltr"
					onChange={(event) =>
						props.onChange(withSource(draft, info.id, { urlTemplate: event.target.value }))
					}
				/>
			) : (
				<Section title="Searchable fields">
					<Row className="flex-wrap gap-x-4 gap-y-2 py-3">
						<FieldCheckboxes info={info} draft={draft} onChange={props.onChange} />
					</Row>
					<div className="px-4 py-3">
						<RelatedNames
							info={info}
							taxonomies={props.taxonomies}
							draft={draft}
							onChange={props.onChange}
						/>
					</div>
				</Section>
			)}

			<ExamplePreview
				info={info}
				urlTemplate={isAuthors ? address : undefined}
				templateValid={templateValid}
			/>

			<StepActions>
				<Button variant="ghost" onClick={props.onBack}>
					Back
				</Button>
				<Button variant="outline" className="ms-auto" onClick={() => props.onSkip(info.id)}>
					{isAuthors ? "I don't have these pages yet" : "Skip this collection"}
				</Button>
				<Button variant="primary" onClick={next}>
					Next
				</Button>
			</StepActions>
		</section>
	);
}

/** Shows where a real record of the source links to, so the admin can open it and check. */
function ExamplePreview(props: {
	info: SourceInfo;
	urlTemplate: string | undefined;
	templateValid: boolean;
}) {
	const { info, urlTemplate, templateValid } = props;
	const [examples, setExamples] = React.useState<Example[] | null>(null);
	const [selectedId, setSelectedId] = React.useState<string | null>(null);
	const [loadError, setLoadError] = React.useState<string | null>(null);

	React.useEffect(() => {
		if (!templateValid) return;
		const query = new URLSearchParams({ source: info.id, ...(urlTemplate ? { urlTemplate } : {}) });
		let current = true;
		void (async () => {
			try {
				const result = await call<{ examples: Example[] }>(`examples?${query}`);
				if (!current) return;
				setExamples(result.examples);
				setSelectedId((id) => id ?? result.examples[0]?.id ?? null);
			} catch (error) {
				if (current) setLoadError(errorMessage(error));
			}
		})();
		return () => {
			current = false;
		};
	}, [info.id, urlTemplate, templateValid]);

	const example = examples?.find((candidate) => candidate.id === selectedId) ?? null;
	const url = templateValid ? example?.url : null;

	let body: React.ReactNode;
	if (loadError) body = <p className="text-sm text-kumo-danger">{loadError}</p>;
	else if (!templateValid)
		body = <p className="text-sm text-kumo-subtle">Enter a valid address template.</p>;
	else if (!examples) body = <Loader size="sm" />;
	else if (examples.length === 0) {
		body = <p className="text-sm text-kumo-subtle">There are no published records to show yet.</p>;
	}

	if (body) {
		return (
			<Section title="Example">
				<Row>{body}</Row>
			</Section>
		);
	}

	return (
		<Section title="Example" description="Search results link here. Open it to check the page.">
			<Row className="flex-wrap py-3">
				<div className="min-w-0">
					<Select
						aria-label={info.id === AUTHORS ? "Example author" : "Example entry"}
						value={selectedId ?? undefined}
						onValueChange={setSelectedId}
						items={Object.fromEntries(
							(examples ?? []).map((candidate) => [candidate.id, candidate.title]),
						)}
					/>
				</div>
				{url ? (
					<LinkButton
						variant="outline"
						size="sm"
						href={url}
						target="_blank"
						rel="noopener noreferrer"
						icon={<ArrowSquareOut />}
					>
						<span dir="ltr">{url}</span>
					</LinkButton>
				) : (
					<p className="text-sm text-kumo-danger">
						This record has no public address. Check the collection's URL pattern under Content
						Types.
					</p>
				)}
			</Row>
		</Section>
	);
}

function ReviewStep(props: {
	selected: SourceInfo[];
	draft: Config;
	firstSetup: boolean;
	taxonomyLabels: Map<string, string>;
	saving: boolean;
	/** What saving changes in the index. */
	impact: React.ReactNode;
	changesIndex: boolean;
	onEdit: (index: number) => void;
	onBack: () => void;
	onBuild: () => void;
}) {
	const { draft } = props;
	return (
		<section className="space-y-5">
			<StepHeader
				title="Ready to build your search?"
				description="Check the included sources and destinations before indexing."
			/>

			<Section title="Sources">
				{props.selected.map((info, index) => {
					const source = sourceOf(draft, info.id);
					const fieldLabels = info.fields
						.filter((field) => source.fields.includes(field.slug))
						.map((field) => field.label);
					const related = [
						...(source.includeAuthorNames ? ["Author names"] : []),
						...(source.taxonomies ?? []).map((name) => props.taxonomyLabels.get(name) ?? name),
					];
					return (
						<Row key={info.id} className="py-3">
							<div className="min-w-0 flex-1 space-y-0.5">
								<p className="text-sm font-medium">{info.label}</p>
								<p className="text-xs text-kumo-subtle">
									{info.id === AUTHORS
										? "Name, Biography"
										: [...fieldLabels, ...related].join(", ")}
									{" · "}
									{source.urlTemplate ? (
										<code dir="ltr">{source.urlTemplate}</code>
									) : (
										"Collection URL pattern"
									)}
								</p>
							</div>
							<Button variant="ghost" size="sm" onClick={() => props.onEdit(index)}>
								Edit
							</Button>
						</Row>
					);
				})}
			</Section>

			{props.impact}

			<StepActions>
				<Button variant="ghost" onClick={props.onBack}>
					Back
				</Button>
				<Button variant="primary" loading={props.saving} onClick={props.onBuild}>
					{props.firstSetup ? "Build index" : props.changesIndex ? "Save and update index" : "Save"}
				</Button>
			</StepActions>
		</section>
	);
}

function BuildStep(props: {
	status: Status;
	sources: string[];
	labels: Map<string, string>;
	onClose: () => void;
}) {
	const { build, totals } = props.status;
	const pending = build ? 0 : totals.processing;
	const processed = totals.indexed + totals.failed;
	const { failed } = totals;

	let heading = "Your search is ready";
	let description = "Visitors can now find your selected content.";
	if (build) {
		heading = "Preparing your search";
		description = "Uploading your selected sources to AI Search.";
	} else if (pending > 0) {
		heading = "Finishing indexing";
		description =
			"AI Search is processing the uploaded records. Most reach search within a few minutes.";
	}

	return (
		<section className="space-y-5">
			<StepHeader title={heading} description={description} />
			<BuildProgress build={build} sources={props.sources} labels={props.labels} />
			{!build && (
				<section
					className="space-y-2 rounded-xl border border-kumo-line bg-kumo-base px-4 py-3"
					aria-busy={pending > 0}
				>
					<Meter
						label="Records processed across the index"
						value={processed}
						max={Math.max(processed + pending, 1)}
						customValue={`${processed.toLocaleString()} of ${(processed + pending).toLocaleString()}`}
					/>
					<p className="flex items-center gap-1.5 text-xs text-kumo-subtle" aria-live="polite">
						{pending > 0 && <Loader size="sm" />}
						{pending > 0
							? "This can take a few minutes. You can leave this page; processing continues."
							: failed > 0
								? `${failed.toLocaleString()} ${failed === 1 ? "record" : "records"} could not be indexed. See Index activity in the settings.`
								: "Every record is searchable."}
					</p>
				</section>
			)}
			<StepActions>
				<Button variant="primary" onClick={props.onClose}>
					Go to settings
				</Button>
			</StepActions>
		</section>
	);
}

function Stepper(props: { current: number }) {
	return (
		<ol className="flex flex-wrap items-center gap-2 text-sm">
			{STEPS.map((label, index) => {
				const done = index < props.current;
				const current = index === props.current;
				let marker = "border border-kumo-line text-kumo-subtle";
				if (current) marker = "bg-kumo-brand text-kumo-inverse";
				else if (done) marker = "bg-kumo-success-tint text-kumo-success";
				return (
					<li
						key={label}
						aria-current={current ? "step" : undefined}
						className="flex items-center gap-2"
					>
						<span
							aria-hidden="true"
							className={`flex size-6 items-center justify-center rounded-full text-xs font-semibold ${marker}`}
						>
							{done ? <Check weight="bold" /> : index + 1}
						</span>
						<span className={current ? "font-medium" : "text-kumo-subtle"}>{label}</span>
						{index < STEPS.length - 1 && (
							<span aria-hidden="true" className="h-px w-6 bg-kumo-line" />
						)}
					</li>
				);
			})}
		</ol>
	);
}

function StepHeader(props: { eyebrow?: string; title: string; description: string }) {
	return (
		<header>
			{props.eyebrow && <p className="text-xs text-kumo-subtle">{props.eyebrow}</p>}
			<h2 className="text-lg font-semibold">{props.title}</h2>
			<p className="text-sm text-kumo-subtle">{props.description}</p>
		</header>
	);
}

function StepActions(props: { children: React.ReactNode }) {
	return (
		<div className="flex flex-wrap items-center justify-between gap-2 border-t border-kumo-line pt-4">
			{props.children}
		</div>
	);
}
