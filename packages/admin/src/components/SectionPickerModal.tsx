/**
 * Section Picker Modal
 *
 * A modal for selecting and inserting sections into content.
 * Supports two insertion modes:
 * - "copy": pastes the section's content blocks directly (editable, independent)
 * - "ref": inserts a synced reference that always reflects the section's current content
 */

import { Button, Dialog, Input } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import { MagnifyingGlass, Stack, FolderOpen, Copy, Link } from "@phosphor-icons/react";
import { X } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import * as React from "react";

import { fetchSections, type Section } from "../lib/api";
import { useDebouncedValue } from "../lib/hooks";
import { cn } from "../lib/utils";

type InsertMode = "copy" | "ref";

interface SectionPickerModalProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onSelect: (section: Section, mode: InsertMode) => void;
}

export function SectionPickerModal({ open, onOpenChange, onSelect }: SectionPickerModalProps) {
	const { t } = useLingui();
	const [searchQuery, setSearchQuery] = React.useState("");
	const [mode, setMode] = React.useState<InsertMode>("copy");
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

	// Reset state when modal opens
	React.useEffect(() => {
		if (open) {
			setSearchQuery("");
			setMode("copy");
		}
	}, [open]);

	const handleSelect = (section: Section) => {
		onSelect(section, mode);
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
								className="absolute right-4 top-4"
							>
								<X className="h-4 w-4" />
								<span className="sr-only">{t`Close`}</span>
							</Button>
						)}
					/>
				</div>

				{/* Mode toggle + Search */}
				<div className="flex flex-col gap-3 py-4 border-b">
					{/* Insert mode toggle */}
					<div className="flex items-center gap-1 p-1 rounded-lg bg-kumo-tint w-fit">
						<button
							type="button"
							onClick={() => setMode("copy")}
							className={cn(
								"flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
								mode === "copy"
									? "bg-kumo-base shadow-sm text-kumo-text"
									: "text-kumo-subtle hover:text-kumo-text",
							)}
						>
							<Copy className="h-3.5 w-3.5" />
							{t`Insert copy`}
						</button>
						<button
							type="button"
							onClick={() => setMode("ref")}
							className={cn(
								"flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
								mode === "ref"
									? "bg-kumo-base shadow-sm text-kumo-brand"
									: "text-kumo-subtle hover:text-kumo-text",
							)}
						>
							<Link className="h-3.5 w-3.5" />
							{t`Synced reference`}
						</button>
					</div>
					{mode === "ref" && (
						<p className="text-xs text-kumo-subtle">
							{t`The section's content will stay in sync — edits to the section update everywhere it's referenced.`}
						</p>
					)}
					{/* Search */}
					<div className="relative">
						<MagnifyingGlass className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-kumo-subtle" />
						<Input
							placeholder={t`Search sections...`}
							value={searchQuery}
							onChange={(e) => setSearchQuery(e.target.value)}
							className="pl-10"
							autoFocus
						/>
					</div>
				</div>

				{/* Section grid */}
				<div className="flex-1 overflow-y-auto py-4">
					{sectionsLoading ? (
						<div className="flex items-center justify-center h-32">
							<div className="text-kumo-subtle">{t`Loading sections...`}</div>
						</div>
					) : sections.length === 0 ? (
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
					) : (
						<div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
							{sections.map((section) => (
								<SectionCard
									key={section.id}
									section={section}
									onSelect={() => handleSelect(section)}
								/>
							))}
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

function SectionCard({ section, onSelect }: { section: Section; onSelect: () => void }) {
	return (
		<button
			type="button"
			onClick={onSelect}
			className={cn(
				"text-left rounded-lg border bg-kumo-base overflow-hidden transition-colors",
				"hover:border-kumo-brand hover:bg-kumo-tint/50",
				"focus:outline-none focus:ring-2 focus:ring-kumo-ring focus:ring-offset-2",
			)}
		>
			{/* Preview */}
			<div className="aspect-video bg-kumo-tint flex items-center justify-center">
				{section.previewUrl ? (
					<img
						src={section.previewUrl}
						alt={section.title}
						className="w-full h-full object-cover"
					/>
				) : (
					<Stack className="h-8 w-8 text-kumo-subtle" />
				)}
			</div>

			{/* Content */}
			<div className="p-3">
				<h4 className="font-medium truncate">{section.title}</h4>
				{section.description && (
					<p className="text-xs text-kumo-subtle line-clamp-2 mt-1">{section.description}</p>
				)}
			</div>
		</button>
	);
}
