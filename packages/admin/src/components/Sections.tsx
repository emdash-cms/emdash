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
import { slugify } from "../lib/utils";
import { ConfirmDialog } from "./ConfirmDialog.js";
import { DialogError, getMutationError } from "./DialogError.js";

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

	// Create form state
	const [createTitle, setCreateTitle] = React.useState("");
	const [createSlug, setCreateSlug] = React.useState("");
	const [createDescription, setCreateDescription] = React.useState("");
	const [slugTouched, setSlugTouched] = React.useState(false);
	const [createError, setCreateError] = React.useState<string | null>(null);

	// Reset form when dialog closes
	React.useEffect(() => {
		if (!isCreateOpen) {
			setCreateTitle("");
			setCreateSlug("");
			setCreateDescription("");
			setSlugTouched(false);
			setCreateError(null);
		}
	}, [isCreateOpen]);

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
		createMutation.mutate({
			slug: createSlug,
			title: createTitle,
			description: createDescription || undefined,
			content: [], // Start with empty content
		});
	};

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
					<Dialog className="p-6" size="lg">
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
		<div className="rounded-lg border bg-kumo-base overflow-hidden">
			{/* Preview area */}
			<div className="aspect-video bg-kumo-tint flex items-center justify-center">
				{section.previewUrl ? (
					<img
						src={section.previewUrl}
						alt={section.title}
						className="w-full h-full object-cover"
					/>
				) : (
					<div className="text-kumo-subtle text-sm">{t`No preview`}</div>
				)}
			</div>

			{/* Content */}
			<div className="p-4">
				<div className="flex items-start justify-between gap-2">
					<div className="flex-1 min-w-0">
						<h3 className="font-semibold truncate">{section.title}</h3>
						<p className="text-sm text-kumo-subtle truncate">{section.slug}</p>
					</div>
					<div
						className="flex items-center gap-1 text-xs text-kumo-subtle"
						title={t(sourceLabels[section.source])}
					>
						<SourceIcon className="h-3 w-3" />
						<span>{t(sourceLabels[section.source])}</span>
					</div>
				</div>

				{section.description && (
					<p className="mt-2 text-sm text-kumo-subtle line-clamp-2">{section.description}</p>
				)}

				{section.keywords.length > 0 && (
					<div className="mt-2 flex flex-wrap gap-1">
						{section.keywords.slice(0, 3).map((keyword) => (
							<span
								key={keyword}
								className="inline-flex items-center rounded bg-kumo-tint px-1.5 py-0.5 text-xs text-kumo-subtle"
							>
								{keyword}
							</span>
						))}
						{section.keywords.length > 3 && (
							<span className="text-xs text-kumo-subtle">+{section.keywords.length - 3} more</span>
						)}
					</div>
				)}

				{/* Actions */}
				<div className="mt-4 flex items-center gap-2">
					<Button
						variant="outline"
						size="sm"
						icon={<PencilSimple />}
						onClick={onEdit}
						className="flex-1"
					>
						{t`Edit`}
					</Button>
					<Button
						variant="ghost"
						size="sm"
						onClick={onCopySlug}
						title={t`Copy slug`}
						aria-label={t`Copy ${section.slug} to clipboard`}
					>
						<Copy className="h-4 w-4" />
					</Button>
					<Button
						variant="ghost"
						size="sm"
						onClick={onDelete}
						title={section.source === "theme" ? t`Cannot delete theme sections` : t`Delete`}
						aria-label={t`Delete ${section.title}`}
						disabled={section.source === "theme"}
					>
						<Trash className="h-4 w-4" />
					</Button>
				</div>
			</div>
		</div>
	);
}
