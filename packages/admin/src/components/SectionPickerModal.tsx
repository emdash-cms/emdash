/**
 * Section Picker Modal
 *
 * A modal for selecting and inserting sections into content.
 */

import { Button, Dialog, Input } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import { MagnifyingGlass, Stack, FolderOpen, Tag } from "@phosphor-icons/react";
import { X } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import * as React from "react";

import { fetchSections, type Section } from "../lib/api";
import { useDebouncedValue } from "../lib/hooks";
import {
	SECTION_STARTER_TEMPLATES,
	SECTION_CATEGORIES,
	matchesSectionTemplate,
	templateToSection,
	getCategoryById,
	type SectionCategoryId,
} from "../lib/sectionTemplates";
import { cn } from "../lib/utils";
import { SectionVisualPreview } from "./SectionVisualPreview.js";

interface SectionPickerModalProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onSelect: (section: Section) => void;
}

export function SectionPickerModal({ open, onOpenChange, onSelect }: SectionPickerModalProps) {
	const { t } = useLingui();
	const [searchQuery, setSearchQuery] = React.useState("");
	const [selectedCategory, setSelectedCategory] = React.useState<SectionCategoryId | null>(null);
	const debouncedSearch = useDebouncedValue(searchQuery, 300);

	const { data: sectionsData, isLoading: sectionsLoading } = useQuery({
		queryKey: ["sections", { search: debouncedSearch }],
		queryFn: () =>
			fetchSections({
				search: debouncedSearch || undefined,
			}),
		enabled: open,
	});
	const sections = sectionsData?.items ?? [];
	const starterSections = React.useMemo(
		() =>
			SECTION_STARTER_TEMPLATES.filter(
				(template) =>
					matchesSectionTemplate(template, debouncedSearch) &&
					(!selectedCategory || template.category === selectedCategory),
			).map(templateToSection),
		[debouncedSearch, selectedCategory],
	);
	const hasAnySections = starterSections.length > 0 || sections.length > 0 || sectionsLoading;

	// Reset search when modal opens
	React.useEffect(() => {
		if (open) {
			setSearchQuery("");
			setSelectedCategory(null);
		}
	}, [open]);

	const handleSelect = (section: Section) => {
		onSelect(section);
		onOpenChange(false);
	};

	return (
		<Dialog.Root open={open} onOpenChange={onOpenChange}>
			<Dialog className="p-6 max-w-3xl max-h-[80vh] flex flex-col" size="lg">
				<div className="flex items-start justify-between gap-4 mb-4">
					<Dialog.Title className="text-lg font-semibold leading-none tracking-tight flex items-center gap-2">
						<Stack className="h-5 w-5" />
						{t`Insert Section`}
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

				{/* Search and filter */}
				<div className="space-y-3 py-4 border-b">
					<div className="relative">
						<MagnifyingGlass className="absolute start-3 top-1/2 -translate-y-1/2 h-4 w-4 text-kumo-subtle" />
						<Input
							aria-label={t`Search sections`}
							placeholder={t`Search sections...`}
							value={searchQuery}
							onChange={(e) => setSearchQuery(e.target.value)}
							className="ps-10"
							autoFocus
						/>
					</div>
					{/* Category filter */}
					<div className="flex flex-wrap gap-2">
						<button
							type="button"
							className={cn(
								"rounded-full border px-2.5 py-1 text-xs font-medium transition-colors",
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
									"rounded-full border px-2.5 py-1 text-xs font-medium transition-colors",
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
				</div>

				{/* Section grid */}
				<div className="flex-1 overflow-y-auto py-4">
					{hasAnySections ? (
						<div className="space-y-6">
							{starterSections.length > 0 && (
								<SectionGroup
									title="Starter sections"
									sections={starterSections}
									onSelect={handleSelect}
								/>
							)}
							{sectionsLoading ? (
								<div className="flex items-center justify-center h-20">
									<div className="text-kumo-subtle">{t`Loading sections...`}</div>
								</div>
							) : (
								sections.length > 0 && (
									<SectionGroup title="Saved sections" sections={sections} onSelect={handleSelect} />
								)
							)}
						</div>
					) : (
						<div className="flex flex-col items-center justify-center h-32 text-center">
							{searchQuery ? (
								<>
									<MagnifyingGlass className="h-8 w-8 text-kumo-subtle mb-2" />
									<p className="text-kumo-subtle">{t`No sections found`}</p>
									<p className="text-sm text-kumo-subtle">{t`Try adjusting your search`}</p>
								</>
							) : (
								<>
									<FolderOpen className="h-8 w-8 text-kumo-subtle mb-2" />
									<p className="text-kumo-subtle">{t`No sections available`}</p>
									<p className="text-sm text-kumo-subtle">
										{t`Create sections in the Sections library to use them here`}
									</p>
								</>
							)}
						</div>
					)}
				</div>

				{/* Footer */}
				<div className="flex justify-end gap-2 pt-4 border-t">
					<Button variant="outline" onClick={() => onOpenChange(false)}>
						{t`Cancel`}
					</Button>
				</div>
			</Dialog>
		</Dialog.Root>
	);
}

function SectionGroup({
	title,
	sections,
	onSelect,
}: {
	title: string;
	sections: Section[];
	onSelect: (section: Section) => void;
}) {
	return (
		<section>
			<h3 className="mb-3 text-sm font-medium text-kumo-subtle">{title}</h3>
			<div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
				{sections.map((section) => (
					<SectionCard key={section.id} section={section} onSelect={() => onSelect(section)} />
				))}
			</div>
		</section>
	);
}

function SectionCard({ section, onSelect }: { section: Section; onSelect: () => void }) {
	const { t } = useLingui();
	const category = section.category ? getCategoryById(section.category) : null;

	return (
		<button
			type="button"
			onClick={onSelect}
			className={cn(
				"text-start rounded-lg border bg-kumo-base overflow-hidden transition-colors",
				"hover:border-kumo-brand hover:bg-kumo-tint/50",
				"focus:outline-none focus:ring-2 focus:ring-kumo-ring focus:ring-offset-2",
			)}
		>
			{/* Preview */}
			<div className="h-28 bg-kumo-tint/50 overflow-hidden">
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
					<div className="w-full h-full flex items-center justify-center text-kumo-subtle">
						<Stack className="h-8 w-8" />
					</div>
				)}
			</div>

			{/* Content */}
			<div className="p-2.5">
				<div className="flex items-start justify-between gap-2">
					<h4 className="font-medium truncate text-sm flex-1">{section.title}</h4>
					{category ? (
						<span className="shrink-0 inline-flex items-center gap-0.5 rounded-full bg-kumo-tint px-1.5 py-0.5 text-[10px] font-medium text-kumo-subtle">
							<Tag className="h-2.5 w-2.5" />
							{t(category.label)}
						</span>
					) : (
						<span className="shrink-0 rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-kumo-subtle">
							{section.source}
						</span>
					)}
				</div>
				{section.description && (
					<p className="text-xs text-kumo-subtle line-clamp-1 mt-1">{section.description}</p>
				)}
			</div>
		</button>
	);
}
