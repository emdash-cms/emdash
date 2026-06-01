/**
 * Sections library page component
 *
 * Browse, create, and manage reusable content sections (block patterns).
 */

import { Button, Dialog, Input, InputArea, Select, Toast } from "@cloudflare/kumo";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import {
	Plus,
	MagnifyingGlass,
	Trash,
	PencilSimple,
	Copy,
	FolderOpen,
	Globe,
	User,
	FileArrowDown,
	Stack,
	Sparkle,
	ArrowRight,
	Tag,
} from "@phosphor-icons/react";
import { X } from "@phosphor-icons/react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import * as React from "react";

import {
	fetchSections,
	createSection,
	deleteSection,
	type Section,
	type SectionSource,
} from "../lib/api";
import {
	SECTION_STARTER_TEMPLATES,
	SECTION_CATEGORIES,
	templateToCreateInput,
	draftSectionFromIntent,
	getIntentSuggestions,
	getTemplateSuggestions,
	type SectionStarterTemplate,
	type SectionCategoryId,
	getCategoryById,
} from "../lib/sectionTemplates";
import { cn, slugify } from "../lib/utils";
import { ConfirmDialog } from "./ConfirmDialog.js";
import { DialogError, getMutationError } from "./DialogError.js";
import { SectionVisualPreview } from "./SectionVisualPreview.js";

const sourceIcons: Record<SectionSource, React.ElementType> = {
	theme: Globe,
	user: User,
	import: FileArrowDown,
};

const sourceLabels: Record<SectionSource, MessageDescriptor> = {
	theme: msg`Theme`,
	user: msg`Custom`,
	import: msg`Imported`,
};

export function Sections() {
	const { t } = useLingui();
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const toastManager = Toast.useToastManager();
	const [isCreateOpen, setIsCreateOpen] = React.useState(false);
	const [deleteSlug, setDeleteSlug] = React.useState<string | null>(null);
	const [searchQuery, setSearchQuery] = React.useState("");
	const [selectedSource, setSelectedSource] = React.useState<SectionSource | null>(null);
	const [selectedCategory, setSelectedCategory] = React.useState<SectionCategoryId | null>(null);

	// Create form state
	const [createTitle, setCreateTitle] = React.useState("");
	const [createSlug, setCreateSlug] = React.useState("");
	const [createDescription, setCreateDescription] = React.useState("");
	const [createKeywords, setCreateKeywords] = React.useState("");
	const [createContent, setCreateContent] = React.useState<unknown[]>([]);
	const [selectedTemplateId, setSelectedTemplateId] = React.useState<string | null>(null);
	const [slugTouched, setSlugTouched] = React.useState(false);
	const [createError, setCreateError] = React.useState<string | null>(null);

	// Draft from intent state
	const [draftIntent, setDraftIntent] = React.useState("");
	const [draftResult, setDraftResult] = React.useState<ReturnType<
		typeof draftSectionFromIntent
	> | null>(null);
	const [draftSuggestions, setDraftSuggestions] = React.useState<string[]>([]);
	const [showSuggestions, setShowSuggestions] = React.useState(false);
	const [draftHighlightedIndex, setDraftHighlightedIndex] = React.useState(-1);

	// Reset form when dialog closes
	React.useEffect(() => {
		if (!isCreateOpen) {
			setCreateTitle("");
			setCreateSlug("");
			setCreateDescription("");
			setCreateKeywords("");
			setCreateContent([]);
			setSelectedTemplateId(null);
			setSlugTouched(false);
			setCreateError(null);
			setDraftIntent("");
			setDraftResult(null);
			setDraftSuggestions([]);
			setShowSuggestions(false);
		}
	}, [isCreateOpen]);

	// Handle draft from intent
	const handleDraftFromIntent = React.useCallback(() => {
		if (!draftIntent.trim()) {
			setDraftResult(null);
			return;
		}
		const result = draftSectionFromIntent(draftIntent);
		setDraftResult(result);
	}, [draftIntent]);

	const { data: sectionsData, isLoading: sectionsLoading } = useQuery({
		queryKey: ["sections", { source: selectedSource, search: searchQuery }],
		queryFn: () =>
			fetchSections({
				source: selectedSource || undefined,
				search: searchQuery || undefined,
			}),
	});
	const sections = sectionsData?.items ?? [];

	const createMutation = useMutation({
		mutationFn: createSection,
		onSuccess: (section) => {
			void queryClient.invalidateQueries({ queryKey: ["sections"] });
			setIsCreateOpen(false);
			toastManager.add({ title: t`Section created` });
			// Navigate to edit the new section
			void navigate({ to: "/sections/$slug", params: { slug: section.slug } });
		},
		onError: (error: Error) => {
			setCreateError(error.message);
		},
	});

	const deleteMutation = useMutation({
		mutationFn: deleteSection,
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: ["sections"] });
			setDeleteSlug(null);
			toastManager.add({ title: t`Section deleted` });
		},
	});

	const handleCreate = (e: React.FormEvent<HTMLFormElement>) => {
		e.preventDefault();
		setCreateError(null);
		const keywords = createKeywords
			.split(",")
			.map((keyword) => keyword.trim())
			.filter(Boolean);
		createMutation.mutate({
			slug: createSlug,
			title: createTitle,
			description: createDescription || undefined,
			keywords,
			content: createContent,
		});
	};

	const handleSelectTemplate = (template: SectionStarterTemplate | null) => {
		if (!template) {
			setSelectedTemplateId(null);
			setCreateTitle("");
			setCreateSlug("");
			setCreateDescription("");
			setCreateKeywords("");
			setCreateContent([]);
			setSlugTouched(false);
			return;
		}

		const input = templateToCreateInput(template);
		setSelectedTemplateId(template.id);
		setCreateTitle(input.title);
		setCreateSlug(input.slug);
		setCreateDescription(input.description ?? "");
		setCreateKeywords(input.keywords?.join(", ") ?? "");
		setCreateContent(input.content);
		setSlugTouched(false);
	};

	// Apply draft result to form - defined after handleSelectTemplate
	const handleApplyDraft = React.useCallback(() => {
		if (draftResult?.found && draftResult.template) {
			handleSelectTemplate(draftResult.template);
			setDraftIntent("");
			setDraftResult(null);
		}
	}, [draftResult]);

	const handleCopySlug = (slug: string) => {
		void navigator.clipboard.writeText(slug);
		toastManager.add({ title: t`Slug copied to clipboard` });
	};

	const sectionToDelete = sections.find((s) => s.slug === deleteSlug);

	return (
		<div className="space-y-6">
			{/* Header */}
			<div className="flex items-center justify-between">
				<div>
					<h1 className="text-3xl font-bold">{t`Sections`}</h1>
					<p className="text-kumo-subtle">
						{t`Reusable content blocks you can insert into any content`}
					</p>
				</div>
				<Dialog.Root open={isCreateOpen} onOpenChange={setIsCreateOpen}>
					<Dialog.Trigger
						render={(props) => (
							<Button {...props} icon={<Plus />}>
								{t`New Section`}
							</Button>
						)}
					/>
					<Dialog className="max-h-[85vh] overflow-y-auto p-6" size="lg">
						<div className="flex items-start justify-between gap-4 mb-4">
							<Dialog.Title className="text-lg font-semibold leading-none tracking-tight">
								{t`Create Section`}
							</Dialog.Title>
							<Dialog.Close
								aria-label={t`Close`}
								render={(props) => (
									<Button
										{...props}
										variant="ghost"
										shape="square"
										aria-label={t`Close`}
										className="absolute end-4 top-4"
									>
										<X className="h-4 w-4" />
										<span className="sr-only">{t`Close`}</span>
									</Button>
								)}
							/>
						</div>
						<form onSubmit={handleCreate} className="space-y-4">
							{/* Draft from intent - schema-constrained AI-assisted drafting */}
							<div className="rounded-lg border border-dashed border-kumo-brand/30 bg-kumo-tint/30 p-4">
								<div className="flex items-center gap-2 mb-3">
									<Sparkle className="h-4 w-4 text-kumo-brand" />
									<span className="text-sm font-medium">{t`Draft from intent`}</span>
								</div>
								<p className="text-xs text-kumo-subtle mb-3">
									{t`Describe what you need and we'll suggest a matching template.`}
								</p>
								<div className="relative">
									<div className="flex gap-2">
										<div className="relative flex-1">
											<Input
												placeholder={t`e.g. pricing table, FAQ section, hero banner`}
												value={draftIntent}
												onChange={(e) => {
													const value = e.target.value;
													setDraftIntent(value);
													setDraftHighlightedIndex(-1);
													// Update suggestions on input change
													if (value.trim().length >= 2) {
														setDraftSuggestions(getIntentSuggestions(value.trim()));
														setShowSuggestions(true);
													} else {
														setDraftSuggestions([]);
														setShowSuggestions(false);
													}
												}}
												onKeyDown={(e) => {
													if (e.key === "Enter") {
														e.preventDefault();
														if (
															draftHighlightedIndex >= 0 &&
															draftSuggestions[draftHighlightedIndex]
														) {
															// Select highlighted suggestion
															const selected = draftSuggestions[draftHighlightedIndex];
															setDraftIntent(selected);
															setDraftSuggestions([]);
															setShowSuggestions(false);
															setDraftHighlightedIndex(-1);
															const result = draftSectionFromIntent(selected);
															setDraftResult(result);
														} else {
															setShowSuggestions(false);
															handleDraftFromIntent();
														}
													} else if (e.key === "Escape") {
														setShowSuggestions(false);
														setDraftHighlightedIndex(-1);
													} else if (e.key === "ArrowDown") {
														e.preventDefault();
														if (showSuggestions && draftSuggestions.length > 0) {
															setDraftHighlightedIndex((prev) =>
																prev < draftSuggestions.length - 1 ? prev + 1 : 0,
															);
														}
													} else if (e.key === "ArrowUp") {
														e.preventDefault();
														if (showSuggestions && draftSuggestions.length > 0) {
															setDraftHighlightedIndex((prev) =>
																prev > 0 ? prev - 1 : draftSuggestions.length - 1,
															);
														}
													}
												}}
												onFocus={() => {
													if (draftIntent.trim().length >= 2 && draftSuggestions.length > 0) {
														setShowSuggestions(true);
													}
												}}
												onBlur={() => {
													// Delay hiding to allow click on suggestion
													setTimeout(() => setShowSuggestions(false), 200);
												}}
												className="flex-1 pr-8"
											/>
											{draftIntent && (
												<button
													type="button"
													className="absolute end-2 top-1/2 -translate-y-1/2 text-kumo-subtle hover:text-kumo-brand"
													onClick={() => {
														setDraftIntent("");
														setDraftSuggestions([]);
														setShowSuggestions(false);
														setDraftHighlightedIndex(-1);
													}}
													aria-label={t`Clear`}
												>
													<X className="h-4 w-4" />
												</button>
											)}
										</div>
										<Button
											type="button"
											variant="outline"
											size="sm"
											onClick={() => {
												setShowSuggestions(false);
												handleDraftFromIntent();
											}}
											disabled={!draftIntent.trim()}
										>
											{t`Suggest`}
										</Button>
									</div>
									{/* Autocomplete suggestions dropdown */}
									{showSuggestions && draftSuggestions.length > 0 && (
										<div
											className="absolute z-10 mt-1 w-full rounded-lg border bg-kumo-base shadow-lg"
											role="listbox"
										>
											{draftSuggestions.map((suggestion, index) => (
												<button
													key={suggestion}
													type="button"
													role="option"
													aria-selected={index === draftHighlightedIndex}
													className={cn(
														"w-full text-left px-3 py-2 text-sm transition-colors",
														index === 0 ? "rounded-t-lg" : "",
														index === draftSuggestions.length - 1 ? "rounded-b-lg" : "",
														index === draftHighlightedIndex
															? "bg-kumo-tint text-kumo-brand font-medium"
															: "hover:bg-kumo-tint",
													)}
													onClick={() => {
														setDraftIntent(suggestion);
														setDraftSuggestions([]);
														setShowSuggestions(false);
														setDraftHighlightedIndex(-1);
														// Auto-suggest on click
														const result = draftSectionFromIntent(suggestion);
														setDraftResult(result);
													}}
													onMouseEnter={() => setDraftHighlightedIndex(index)}
												>
													{suggestion}
												</button>
											))}
										</div>
									)}
								</div>
								{draftResult && (
									<div className="mt-3 p-3 rounded-lg bg-kumo-base border">
										{draftResult.found && draftResult.template ? (
											<div className="flex items-center justify-between gap-3">
												<div className="flex-1 min-w-0">
													<div className="text-sm font-medium flex items-center gap-2">
														<span
															className={cn(
																"inline-block w-2 h-2 rounded-full shrink-0",
																draftResult.confidence === "high"
																	? "bg-green-500"
																	: draftResult.confidence === "medium"
																		? "bg-yellow-500"
																		: "bg-gray-400",
															)}
														/>
														<span className="truncate">{draftResult.template.title}</span>
													</div>
													<div className="text-xs text-kumo-subtle mt-0.5">
														{draftResult.suggestion}
													</div>
													{/* Alternative suggestions */}
													{draftResult.alternatives && draftResult.alternatives.length > 0 && (
														<div className="mt-2 flex flex-wrap gap-1">
															<span className="text-[10px] text-kumo-subtle">{t`Or try:`}</span>
															{draftResult.alternatives.slice(0, 2).map((alt) => (
																<button
																	key={alt.id}
																	type="button"
																	className="rounded bg-kumo-tint px-1.5 py-0.5 text-[10px] text-kumo-brand hover:bg-kumo-brand/10 transition-colors"
																	onClick={() => {
																		const result = draftSectionFromIntent(alt.title);
																		setDraftResult(result);
																	}}
																>
																	{alt.title}
																</button>
															))}
														</div>
													)}
												</div>
												<Button
													type="button"
													size="sm"
													icon={<ArrowRight />}
													onClick={handleApplyDraft}
													className="shrink-0"
												>
													{t`Use`}
												</Button>
											</div>
										) : (
											<div className="text-sm text-kumo-subtle">{draftResult.suggestion}</div>
										)}
									</div>
								)}
							</div>

							<div>
								<div className="mb-2 text-sm font-medium">{t`Start from template`}</div>
								{/* Category filter for templates */}
								<div className="flex flex-wrap gap-2 mb-3">
									<button
										type="button"
										className={cn(
											"rounded-full border px-3 py-1 text-xs font-medium transition-colors",
											!selectedCategory
												? "border-kumo-brand bg-kumo-tint text-kumo-brand"
												: "border-kumo-line text-kumo-subtle hover:border-kumo-brand hover:text-kumo-brand",
										)}
										onClick={() => setSelectedCategory(null)}
									>
										{t`All`}
									</button>
									{SECTION_CATEGORIES.map((cat) => (
										<button
											key={cat.id}
											type="button"
											className={cn(
												"rounded-full border px-3 py-1 text-xs font-medium transition-colors",
												selectedCategory === cat.id
													? "border-kumo-brand bg-kumo-tint text-kumo-brand"
													: "border-kumo-line text-kumo-subtle hover:border-kumo-brand hover:text-kumo-brand",
											)}
											onClick={() => setSelectedCategory(cat.id as SectionCategoryId)}
										>
											{t(cat.label)}
										</button>
									))}
								</div>
								<div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
									<button
										type="button"
										className={cn(
											"rounded-lg border p-3 text-start transition-colors",
											!selectedTemplateId
												? "border-kumo-brand bg-kumo-tint"
												: "hover:border-kumo-brand hover:bg-kumo-tint/50",
										)}
										onClick={() => handleSelectTemplate(null)}
									>
										<div className="flex items-center gap-2 font-medium">
											<Plus className="h-4 w-4" />
											{t`Blank Section`}
										</div>
										<p className="mt-1 text-xs text-kumo-subtle">
											{t`Start empty and build the section manually.`}
										</p>
									</button>
									{SECTION_STARTER_TEMPLATES.filter(
										(template) => !selectedCategory || template.category === selectedCategory,
									).map((template) => (
										<TemplateCard
											key={template.id}
											template={template}
											active={selectedTemplateId === template.id}
											onSelect={() => handleSelectTemplate(template)}
										/>
									))}
								</div>
							</div>
							<Input
								label={t`Title`}
								value={createTitle}
								onChange={(e) => {
									const title = e.target.value;
									setCreateTitle(title);
									if (!slugTouched && title) {
										setCreateSlug(slugify(title));
									}
								}}
								required
								placeholder={t`Hero Banner`}
							/>
							<div>
								<Input
									label={t`Slug`}
									value={createSlug}
									onChange={(e) => {
										setCreateSlug(e.target.value);
										setSlugTouched(true);
									}}
									required
									placeholder="hero-banner"
									pattern="[a-z0-9\-]+"
									title={t`Lowercase letters, numbers, and hyphens only`}
								/>
								<p className="text-xs text-kumo-subtle mt-1">
									{t`Used to identify this section. Lowercase letters, numbers, and hyphens only.`}
								</p>
							</div>
							<InputArea
								label={t`Description`}
								value={createDescription}
								onChange={(e) => setCreateDescription(e.target.value)}
								placeholder={t`A full-width hero banner with heading, text, and CTA button`}
								rows={3}
							/>
							<Input
								label={t`Keywords`}
								value={createKeywords}
								onChange={(e) => setCreateKeywords(e.target.value)}
								placeholder={t`hero, banner, cta`}
							/>
							<DialogError message={createError || getMutationError(createMutation.error)} />
							<div className="flex justify-end gap-2">
								<Button type="button" variant="outline" onClick={() => setIsCreateOpen(false)}>
									{t`Cancel`}
								</Button>
								<Button type="submit" disabled={createMutation.isPending}>
									{createMutation.isPending ? t`Creating...` : t`Create`}
								</Button>
							</div>
						</form>
					</Dialog>
				</Dialog.Root>
			</div>

			{/* Filters */}
			<div className="flex items-center gap-4">
				{/* Search */}
				<div className="relative flex-1 max-w-md">
					<MagnifyingGlass className="absolute start-3 top-1/2 -translate-y-1/2 h-4 w-4 text-kumo-subtle" />
					<Input
						placeholder={t`Search sections...`}
						value={searchQuery}
						onChange={(e) => setSearchQuery(e.target.value)}
						className="ps-10"
					/>
				</div>

				{/* Source filter */}
				<Select
					value={selectedSource ?? ""}
					onValueChange={(v) => {
						setSelectedSource(v === "theme" || v === "user" || v === "import" ? v : null);
					}}
					items={{
						"": t`All Sources`,
						...Object.fromEntries(
							Object.entries(sourceLabels).map(([key, label]) => [key, t(label)]),
						),
					}}
					aria-label={t`Filter by source`}
				/>
			</div>

			{/* Section Grid */}
			{sectionsLoading ? (
				<div className="flex items-center justify-center h-64">
					<div className="text-kumo-subtle">{t`Loading sections...`}</div>
				</div>
			) : sections.length === 0 ? (
				<div className="rounded-lg border bg-kumo-base p-12 text-center">
					{searchQuery || selectedSource ? (
						<>
							<MagnifyingGlass className="mx-auto h-12 w-12 text-kumo-subtle" />
							<h3 className="mt-4 text-lg font-semibold">{t`No sections found`}</h3>
							<p className="mt-2 text-kumo-subtle">{t`Try adjusting your search or filters.`}</p>
						</>
					) : (
						<>
							<FolderOpen className="mx-auto h-12 w-12 text-kumo-subtle" />
							<h3 className="mt-4 text-lg font-semibold">{t`No sections yet`}</h3>
							<p className="mt-2 text-kumo-subtle">
								{t`Create your first reusable content section to get started.`}
							</p>
							<Button className="mt-4" icon={<Plus />} onClick={() => setIsCreateOpen(true)}>
								{t`Create Section`}
							</Button>
						</>
					)}
				</div>
			) : (
				<div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
					{sections.map((section) => (
						<SectionCard
							key={section.id}
							section={section}
							onEdit={() => navigate({ to: "/sections/$slug", params: { slug: section.slug } })}
							onDelete={() => setDeleteSlug(section.slug)}
							onCopySlug={() => handleCopySlug(section.slug)}
						/>
					))}
				</div>
			)}

			{/* Delete confirmation */}
			<ConfirmDialog
				open={!!deleteSlug}
				onClose={() => {
					setDeleteSlug(null);
					deleteMutation.reset();
				}}
				title={t`Delete Section?`}
				description={
					sectionToDelete?.source === "theme" ? (
						<>
							{t`Theme-provided sections cannot be deleted. Edit the section to create a custom copy, then delete that.`}
						</>
					) : (
						<>
							{t`This will permanently delete "${sectionToDelete?.title}". This action cannot be undone.`}
						</>
					)
				}
				confirmLabel={t`Delete`}
				pendingLabel={t`Deleting...`}
				isPending={deleteMutation.isPending}
				error={deleteMutation.error}
				onConfirm={() => deleteSlug && deleteMutation.mutate(deleteSlug)}
			/>
		</div>
	);
}

function TemplateCard({
	template,
	active,
	onSelect,
}: {
	template: SectionStarterTemplate;
	active: boolean;
	onSelect: () => void;
}) {
	const { t } = useLingui();
	const category = SECTION_CATEGORIES.find((c) => c.id === template.category);

	return (
		<button
			type="button"
			className={cn(
				"rounded-lg border text-start transition-colors relative overflow-hidden",
				active ? "border-kumo-brand bg-kumo-tint" : "hover:border-kumo-brand hover:bg-kumo-tint/50",
			)}
			onClick={onSelect}
		>
			{/* Mini visual preview */}
			<div className="h-16 bg-kumo-tint/50 overflow-hidden">
				<div className="scale-[0.2] origin-top-left w-[500%] h-[500%] pointer-events-none opacity-60">
					<SectionVisualPreview value={template.content} />
				</div>
			</div>

			{/* Content */}
			<div className="p-2.5">
				<div className="flex items-start justify-between gap-1">
					<div className="flex items-center gap-1.5 font-medium text-sm">
						<Stack className="h-3.5 w-3.5 text-kumo-brand" />
						<span className="truncate">{template.title}</span>
					</div>
					{category && (
						<span className="shrink-0 rounded-full bg-kumo-tint px-1.5 py-0.5 text-[10px] font-medium text-kumo-subtle">
							{t(category.label)}
						</span>
					)}
				</div>
				<p className="mt-1 text-[11px] text-kumo-subtle line-clamp-1">{template.description}</p>
			</div>
		</button>
	);
}

function SectionCard({
	section,
	onEdit,
	onDelete,
	onCopySlug,
}: {
	section: Section;
	onEdit: () => void;
	onDelete: () => void;
	onCopySlug: () => void;
}) {
	const { t } = useLingui();
	const SourceIcon = sourceIcons[section.source];
	const category = section.category ? getCategoryById(section.category) : null;

	return (
		<div className="rounded-lg border bg-kumo-base overflow-hidden hover:border-kumo-brand/50 transition-colors">
			{/* Preview area */}
			<div className="h-32 bg-kumo-tint overflow-hidden">
				{section.previewUrl ? (
					<img
						src={section.previewUrl}
						alt={section.title}
						className="w-full h-full object-cover"
					/>
				) : section.content.length > 0 ? (
					<div className="scale-[0.25] origin-top-left w-[400%] h-[400%] pointer-events-none opacity-60">
						<SectionVisualPreview value={section.content} />
					</div>
				) : (
					<div className="w-full h-full flex items-center justify-center text-kumo-subtle text-sm">
						<Stack className="h-6 w-6 mr-2" />
						{t`No preview`}
					</div>
				)}
			</div>

			{/* Content */}
			<div className="p-3">
				<div className="flex items-start justify-between gap-2">
					<div className="flex-1 min-w-0">
						<h3 className="font-semibold truncate text-sm">{section.title}</h3>
						<p className="text-xs text-kumo-subtle truncate">{section.slug}</p>
					</div>
					<div
						className="flex items-center gap-1 text-[10px] text-kumo-subtle shrink-0"
						title={t(sourceLabels[section.source])}
					>
						<SourceIcon className="h-3 w-3" />
					</div>
				</div>

				{section.description && (
					<p className="mt-2 text-xs text-kumo-subtle line-clamp-2">{section.description}</p>
				)}

				{/* Category badge */}
				{category && (
					<div className="mt-2">
						<span className="inline-flex items-center gap-1 rounded-full bg-kumo-tint px-2 py-0.5 text-[10px] font-medium text-kumo-subtle">
							<Tag className="h-3 w-3" />
							{t(category.label)}
						</span>
					</div>
				)}

				{section.keywords.length > 0 && (
					<div className="mt-2 flex flex-wrap gap-1">
						{section.keywords.slice(0, 2).map((keyword) => (
							<span
								key={keyword}
								className="inline-flex items-center rounded bg-kumo-tint/50 px-1.5 py-0.5 text-[10px] text-kumo-subtle"
							>
								{keyword}
							</span>
						))}
						{section.keywords.length > 2 && (
							<span className="text-[10px] text-kumo-subtle">+{section.keywords.length - 2}</span>
						)}
					</div>
				)}

				{/* Actions */}
				<div className="mt-3 flex items-center gap-1">
					<Button
						variant="outline"
						size="sm"
						icon={<PencilSimple />}
						onClick={onEdit}
						className="flex-1 text-xs h-7"
					>
						{t`Edit`}
					</Button>
					<Button
						variant="ghost"
						size="sm"
						onClick={onCopySlug}
						title={t`Copy slug`}
						aria-label={t`Copy ${section.slug} to clipboard`}
						className="h-7 w-7"
					>
						<Copy className="h-3.5 w-3.5" />
					</Button>
					<Button
						variant="ghost"
						size="sm"
						onClick={onDelete}
						title={section.source === "theme" ? t`Cannot delete theme sections` : t`Delete`}
						aria-label={t`Delete ${section.title}`}
						disabled={section.source === "theme"}
						className="h-7 w-7"
					>
						<Trash className="h-3.5 w-3.5" />
					</Button>
				</div>
			</div>
		</div>
	);
}
