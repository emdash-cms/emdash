/**
 * Sections library page component
 *
 * Browse, create, and manage reusable content sections (block patterns).
 */

import {
	Badge,
	Button,
	DropdownMenu,
	Input,
	InputArea,
	LayerCard,
	LayerDialog,
	Loader,
	Select,
	Toast,
} from "@cloudflare/kumo";
import type { MessageDescriptor } from "@lingui/core";
import { msg, plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import {
	Plus,
	MagnifyingGlass,
	Trash,
	PencilSimple,
	Copy,
	DotsThree,
	Globe,
	User,
	FileArrowDown,
} from "@phosphor-icons/react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import * as React from "react";

import {
	fetchSections,
	createSection,
	deleteSection,
	type CreateSectionInput,
	type Section,
	type SectionSource,
} from "../lib/api";
import { ApiResponseError } from "../lib/api/client.js";
import {
	guardUnsavedInput,
	revealErrors,
	useSingleFlight,
	useTakenValue,
} from "../lib/dialog-form.js";
import { slugify, slugifyIdentifier } from "../lib/utils";
import { ADMIN_NAV_ICONS } from "./admin-navigation-icons.js";
import { ConfirmDialog } from "./ConfirmDialog.js";
import { DialogError, getMutationError } from "./DialogError.js";
import { HelpLabel } from "./FieldHelpLabel.js";
import { TableToolbarSearch } from "./TableToolbar.js";

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

const SECTION_SLUG_PATTERN = /^[a-z0-9-]+$/;
const LETTER_PATTERN = /\p{Letter}/gu;
const COMBINING_MARK_PATTERN = /\p{M}/gu;
const ASCII_ALPHANUMERIC_PATTERN = /[a-z0-9]/;

/** The slug a title suggests, or "" when the title has nothing the slug field accepts. */
function toSectionSlug(title: string): string {
	// slugifyIdentifier spells each letter in ASCII (ß → ss, ø → oe, é → e); a letter
	// it can't spell becomes a word break.
	const latin = title
		.normalize("NFKC")
		.replace(LETTER_PATTERN, (letter) => slugifyIdentifier(letter) || " ")
		.replace(COMBINING_MARK_PATTERN, "");
	// With nothing usable left, slugify would invent an untitled-… slug.
	if (!ASCII_ALPHANUMERIC_PATTERN.test(latin)) return "";
	const slug = slugify(latin);
	return SECTION_SLUG_PATTERN.test(slug) ? slug : "";
}

type CreateSectionField = "title" | "slug";

function createSectionProblems(
	title: string,
	slug: string,
): Partial<Record<CreateSectionField, MessageDescriptor>> {
	const problems: Partial<Record<CreateSectionField, MessageDescriptor>> = {};
	if (!title.trim()) problems.title = msg`Enter a title.`;
	if (!slug) problems.slug = msg`Enter a slug.`;
	else if (!SECTION_SLUG_PATTERN.test(slug)) {
		problems.slug = msg`Use lowercase letters, numbers, and hyphens.`;
	}
	return problems;
}

function isConflict(error: unknown): boolean {
	return error instanceof ApiResponseError && error.code === "CONFLICT";
}

export function Sections() {
	const { t } = useLingui();
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const toastManager = Toast.useToastManager();
	const [isCreateOpen, setIsCreateOpen] = React.useState(false);
	const createFormId = React.useId();
	const createFormRef = React.useRef<HTMLFormElement>(null);
	const [deleteSlug, setDeleteSlug] = React.useState<string | null>(null);
	const [searchQuery, setSearchQuery] = React.useState("");
	const [selectedSource, setSelectedSource] = React.useState<SectionSource | null>(null);

	const [createTitle, setCreateTitle] = React.useState("");
	const [createSlug, setCreateSlug] = React.useState("");
	const [createDescription, setCreateDescription] = React.useState("");
	const [slugTouched, setSlugTouched] = React.useState(false);
	const [createSubmitted, setCreateSubmitted] = React.useState(false);
	const takenSlug = useTakenValue(createSlug);

	const {
		data: sectionsData,
		isLoading: sectionsLoading,
		isError: sectionsError,
		refetch: refetchSections,
	} = useQuery({
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
			void navigate({ to: "/sections/$slug", params: { slug: section.slug } });
		},
		onError: (error, input) => {
			if (!isConflict(error) || !takenSlug.stillHolds(input.slug)) return;
			revealErrors(createFormRef.current, () => {
				setCreateSubmitted(true);
				takenSlug.take(input.slug, error);
			});
		},
	});
	const submitCreate = useSingleFlight((input: CreateSectionInput) =>
		createMutation.mutateAsync(input),
	);

	const deleteMutation = useMutation({
		mutationFn: deleteSection,
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: ["sections"] });
			setDeleteSlug(null);
			toastManager.add({ title: t`Section deleted` });
		},
	});

	const handleCreateOpenChange = (open: boolean) => {
		setIsCreateOpen(open);
		if (!open) return;
		setCreateTitle("");
		setCreateSlug("");
		setCreateDescription("");
		setSlugTouched(false);
		setCreateSubmitted(false);
		takenSlug.reset();
		createMutation.reset();
	};

	const createProblems = createSectionProblems(createTitle, createSlug);
	if (takenSlug.isTaken) {
		createProblems.slug = msg`Another section already uses this slug. Enter a different one.`;
	}
	const createErrors = createSubmitted ? createProblems : {};

	const handleCreate = (e: React.FormEvent<HTMLFormElement>) => {
		e.preventDefault();
		if (createMutation.isPending) return;
		if (Object.keys(createProblems).length > 0) {
			revealErrors(e.currentTarget, () => setCreateSubmitted(true));
			return;
		}
		submitCreate({
			slug: createSlug,
			title: createTitle,
			description: createDescription || undefined,
			content: [],
		});
	};

	const handleCopySlug = (slug: string) => {
		void navigator.clipboard.writeText(slug);
		toastManager.add({ title: t`Slug copied to clipboard` });
	};

	const sectionToDelete = sections.find((s) => s.slug === deleteSlug);
	const searchPlaceholder = t`Search sections...`;

	return (
		<div className="space-y-6">
			<header className="grid min-w-0 gap-4 border-b border-kumo-line pb-4">
				<div className="flex flex-wrap items-start justify-between gap-3">
					<div className="min-w-0">
						<h1 className="text-2xl font-semibold leading-tight">{t`Sections`}</h1>
						<p className="mt-1 text-sm leading-5 text-pretty text-kumo-subtle">
							{t`Reusable content blocks you can insert into any content`}
						</p>
					</div>
					<LayerDialog.Root
						open={isCreateOpen}
						{...guardUnsavedInput(
							createTitle !== "" || createSlug !== "" || createDescription !== "",
							handleCreateOpenChange,
						)}
						dismissDisabled={createMutation.isPending}
					>
						<LayerDialog.Trigger
							render={(props) => (
								<Button {...props} variant="primary" icon={<Plus aria-hidden="true" />}>
									{t`New section`}
								</Button>
							)}
						/>
						<LayerDialog.Content>
							<LayerDialog.Title>
								<span dir="auto" className="block">
									{t`Create section`}
								</span>
							</LayerDialog.Title>
							<LayerDialog.Description>
								<span dir="auto" className="block">
									{t`Name your section, then add its content in the editor.`}
								</span>
							</LayerDialog.Description>
							<LayerDialog.Body>
								<form
									ref={createFormRef}
									id={createFormId}
									noValidate
									onSubmit={handleCreate}
									className="grid gap-5"
								>
									<Input
										label={t`Title`}
										value={createTitle}
										onChange={(e) => {
											const title = e.target.value;
											setCreateTitle(title);
											if (!slugTouched) setCreateSlug(toSectionSlug(title));
										}}
										required
										placeholder={t`Hero Banner`}
										error={createErrors.title && t(createErrors.title)}
										aria-invalid={createErrors.title ? true : undefined}
									/>
									<Input
										label={
											<HelpLabel help={t`Auto-generated from the title. You can change it.`}>
												{t`Slug`}
											</HelpLabel>
										}
										aria-label={t`Slug`}
										dir="ltr"
										value={createSlug}
										onChange={(e) => {
											setCreateSlug(e.target.value);
											setSlugTouched(true);
										}}
										required
										placeholder="hero-banner"
										error={createErrors.slug && t(createErrors.slug)}
										aria-invalid={createErrors.slug ? true : undefined}
									/>
									<InputArea
										label={t`Description`}
										value={createDescription}
										onChange={(e) => setCreateDescription(e.target.value)}
										placeholder={t`A full-width hero banner with heading, text, and CTA button`}
										rows={3}
									/>
									<DialogError
										message={getMutationError(takenSlug.unlessTaken(createMutation.error))}
									/>
								</form>
							</LayerDialog.Body>
							<LayerDialog.Actions dismissLabel={t`Cancel`}>
								<LayerDialog.Action
									type="submit"
									form={createFormId}
									disabled={createMutation.isPending}
								>
									{createMutation.isPending ? t`Creating...` : t`Create section`}
								</LayerDialog.Action>
							</LayerDialog.Actions>
						</LayerDialog.Content>
					</LayerDialog.Root>
				</div>
				<div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center">
					<TableToolbarSearch
						size="base"
						className="sm:w-72"
						placeholder={searchPlaceholder}
						aria-label={searchPlaceholder}
						value={searchQuery}
						onChange={(event) => setSearchQuery(event.target.value)}
					/>
					<Select
						className="w-full sm:w-auto"
						value={selectedSource ?? ""}
						onValueChange={(v) => {
							setSelectedSource(v === "theme" || v === "user" || v === "import" ? v : null);
						}}
						items={{
							"": t`All sources`,
							...Object.fromEntries(
								Object.entries(sourceLabels).map(([key, label]) => [key, t(label)]),
							),
						}}
						aria-label={t`Filter by source`}
					/>
				</div>
			</header>

			{sectionsLoading ? (
				<div
					role="status"
					className="flex items-center justify-center gap-2 py-16 text-sm text-kumo-subtle"
				>
					<span aria-hidden="true">
						<Loader />
					</span>
					{t`Loading sections...`}
				</div>
			) : sectionsError && !sectionsData ? (
				<div role="alert" className="flex flex-col items-center gap-3 py-16 text-center">
					<p className="text-sm text-kumo-subtle">{t`Sections could not be loaded.`}</p>
					<Button variant="secondary" onClick={() => void refetchSections()}>
						{t`Retry`}
					</Button>
				</div>
			) : sections.length === 0 ? (
				<div className="flex flex-col items-center gap-3 py-16 text-center">
					{searchQuery || selectedSource ? (
						<>
							<MagnifyingGlass className="size-8 text-kumo-subtle opacity-60" aria-hidden="true" />
							<h2 className="text-base font-semibold">{t`No sections found`}</h2>
							<p className="text-sm text-kumo-subtle">{t`Try adjusting your search or filters.`}</p>
							<Button
								variant="secondary"
								onClick={() => {
									setSearchQuery("");
									setSelectedSource(null);
								}}
							>
								{t`Clear filters`}
							</Button>
						</>
					) : (
						<>
							<ADMIN_NAV_ICONS.sections
								className="size-8 text-kumo-subtle opacity-60"
								aria-hidden="true"
							/>
							<h2 className="text-base font-semibold">{t`No sections yet`}</h2>
							<p className="text-sm text-kumo-subtle">
								{t`Create your first reusable content section to get started.`}
							</p>
							<Button
								icon={<Plus aria-hidden="true" />}
								onClick={() => handleCreateOpenChange(true)}
							>
								{t`Create section`}
							</Button>
						</>
					)}
				</div>
			) : (
				<div className="grid grid-cols-[repeat(auto-fill,minmax(min(18rem,100%),1fr))] gap-4">
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

	return (
		<LayerCard className="flex h-full min-w-0 flex-col overflow-hidden p-0">
			<div className="flex min-w-0 flex-1 flex-col gap-3 p-4">
				<div className="flex min-w-0 items-start gap-3">
					<div className="flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-md bg-kumo-tint/50 text-kumo-subtle">
						{section.previewUrl ? (
							<img
								src={section.previewUrl}
								alt={t`Preview of ${section.title}`}
								className="size-full object-cover"
							/>
						) : (
							<ADMIN_NAV_ICONS.sections className="size-5" aria-hidden="true" />
						)}
					</div>
					<div className="flex min-w-0 flex-1 items-start justify-between gap-2">
						<div className="min-w-0">
							<h2
								dir="auto"
								className="truncate text-base font-semibold leading-5"
								title={section.title}
							>
								{section.title}
							</h2>
							<bdi dir="ltr" className="block truncate text-xs text-kumo-subtle">
								/{section.slug}
							</bdi>
						</div>
						<Badge variant="secondary" className="flex shrink-0 items-center gap-1">
							<SourceIcon className="size-3" aria-hidden="true" />
							<span>{t(sourceLabels[section.source])}</span>
						</Badge>
					</div>
				</div>

				{section.description && (
					<p dir="auto" className="line-clamp-2 text-sm leading-5 text-kumo-subtle">
						{section.description}
					</p>
				)}

				{section.keywords.length > 0 && (
					<div className="flex flex-wrap items-center gap-1">
						{section.keywords.slice(0, 3).map((keyword) => (
							<Badge key={keyword} variant="outline" className="max-w-full truncate">
								<bdi dir="auto">{keyword}</bdi>
							</Badge>
						))}
						{section.keywords.length > 3 && (
							<span className="text-xs text-kumo-subtle">
								<bdi dir="auto">
									{plural(section.keywords.length - 3, { one: "+# more", other: "+# more" })}
								</bdi>
							</span>
						)}
					</div>
				)}

				<div className="mt-auto flex items-center justify-between gap-2 border-t border-kumo-line pt-3">
					<Button
						variant="secondary"
						size="sm"
						icon={<PencilSimple aria-hidden="true" />}
						onClick={onEdit}
						aria-label={t`Edit ${section.title}`}
					>
						{t`Edit`}
					</Button>
					<DropdownMenu>
						<DropdownMenu.Trigger
							render={
								<Button
									type="button"
									variant="ghost"
									size="sm"
									shape="square"
									icon={<DotsThree aria-hidden="true" />}
									aria-label={t`More actions for ${section.title}`}
								/>
							}
						/>
						<DropdownMenu.Content align="end">
							<DropdownMenu.Item
								icon={<Copy className="size-4" aria-hidden="true" />}
								onClick={onCopySlug}
							>
								{t`Copy slug`}
							</DropdownMenu.Item>
							<DropdownMenu.Separator />
							<DropdownMenu.Item
								variant="danger"
								icon={<Trash className="size-4" aria-hidden="true" />}
								aria-label={section.source === "theme" ? undefined : t`Delete ${section.title}`}
								disabled={section.source === "theme"}
								onClick={onDelete}
							>
								{section.source === "theme" ? t`Cannot delete theme sections` : t`Delete section`}
							</DropdownMenu.Item>
						</DropdownMenu.Content>
					</DropdownMenu>
				</div>
			</div>
		</LayerCard>
	);
}
