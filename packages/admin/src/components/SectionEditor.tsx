/**
 * Section editor page component
 *
 * Edit a section's content and metadata.
 */

import { Button, Input, InputArea, Label, Loader, Toast } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import { ArrowLeft } from "@phosphor-icons/react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useParams, useNavigate } from "@tanstack/react-router";
import * as React from "react";

import { fetchSection, updateSection, type Section, type UpdateSectionInput } from "../lib/api";
import { slugify } from "../lib/utils";
import { PortableTextEditor } from "./PortableTextEditor";
import { SaveButton } from "./SaveButton";

export function SectionEditor() {
	const { t } = useLingui();
	const { slug } = useParams({ from: "/_admin/sections/$slug" });
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const toastManager = Toast.useToastManager();

	const {
		data: section,
		isLoading,
		error,
	} = useQuery({
		queryKey: ["sections", slug],
		queryFn: () => fetchSection(slug),
		staleTime: Infinity,
	});

	const updateMutation = useMutation({
		mutationFn: (input: UpdateSectionInput) => updateSection(slug, input),
		onSuccess: (updated) => {
			void queryClient.invalidateQueries({ queryKey: ["sections"] });
			void queryClient.invalidateQueries({ queryKey: ["sections", slug] });
			toastManager.add({ title: t`Section saved` });
			// If slug changed, navigate to new URL
			if (updated.slug !== slug) {
				void navigate({ to: "/sections/$slug", params: { slug: updated.slug } });
			}
		},
		onError: (mutationError: Error) => {
			toastManager.add({
				title: t`Error saving section`,
				description: mutationError.message,
				type: "error",
			});
		},
	});

	if (isLoading) {
		return (
			<div className="flex items-center justify-center h-64">
				<Loader />
			</div>
		);
	}

	if (error || !section) {
		return (
			<div className="space-y-6">
				<div className="flex items-center gap-4">
					<Link to="/sections">
						<Button variant="ghost" shape="square" aria-label={t`Back to sections`}>
							<ArrowLeft className="h-5 w-5" />
						</Button>
					</Link>
					<h1 className="text-2xl font-bold">{t`Section Not Found`}</h1>
				</div>
				<div className="rounded-lg border bg-kumo-base p-6">
					<p className="text-kumo-subtle">
						{error ? error.message : t`Section "${slug}" could not be found.`}
					</p>
				</div>
			</div>
		);
	}

	return (
		<SectionEditorForm
			key={section.updatedAt}
			section={section}
			isSaving={updateMutation.isPending}
			onSave={(input) => updateMutation.mutate(input)}
		/>
	);
}

interface SectionEditorFormProps {
	section: Section;
	isSaving: boolean;
	onSave: (input: UpdateSectionInput) => void;
}

function SectionEditorForm({ section, isSaving, onSave }: SectionEditorFormProps) {
	const { t } = useLingui();
	const [title, setTitle] = React.useState(section.title);
	const [sectionSlug, setSectionSlug] = React.useState(section.slug);
	const [slugTouched, setSlugTouched] = React.useState(true); // Existing sections have touched slugs
	const [description, setDescription] = React.useState(section.description || "");
	const [keywords, setKeywords] = React.useState(section.keywords.join(", "));
	const [content, setContent] = React.useState<unknown[]>(section.content);

	// Track initial state for dirty checking
	const [lastSavedData] = React.useState(() =>
		JSON.stringify({
			title: section.title,
			slug: section.slug,
			description: section.description || "",
			keywords: section.keywords.join(", "),
			content: section.content,
		}),
	);

	// Auto-generate slug from title if editing title and slug hasn't been manually changed
	React.useEffect(() => {
		if (!slugTouched && title && title !== section.title) {
			setSectionSlug(slugify(title));
		}
	}, [title, slugTouched, section.title]);

	const currentData = React.useMemo(
		() => JSON.stringify({ title, slug: sectionSlug, description, keywords, content }),
		[title, sectionSlug, description, keywords, content],
	);
	const isDirty = currentData !== lastSavedData;

	const handleSave = () => {
		const keywordsArray = keywords
			.split(",")
			.map((k) => k.trim())
			.filter(Boolean);

		onSave({
			title,
			slug: sectionSlug,
			description: description || undefined,
			keywords: keywordsArray,
			content,
		});
	};

	return (
		<div className="space-y-6">
			{/* Header */}
			<div className="flex items-center justify-between">
				<div className="flex items-center gap-4">
					<Link to="/sections">
						<Button variant="ghost" shape="square" aria-label={t`Back to sections`}>
							<ArrowLeft className="h-5 w-5" />
						</Button>
					</Link>
					<div>
						<h1 className="text-2xl font-bold">{section.title}</h1>
						<p className="text-sm text-kumo-subtle">
							{section.source === "theme" ? t`Theme Section` : t`Custom Section`} &middot;{" "}
							{section.slug}
						</p>
					</div>
				</div>
				<SaveButton isSaving={isSaving} isDirty={isDirty} onClick={handleSave} />
			</div>

			<div className="grid grid-cols-12 gap-6">
				{/* Main content */}
				<div className="col-span-8 space-y-6">
					{/* Content editor */}
					<div className="rounded-lg border bg-kumo-base p-6">
						<Label className="text-lg font-semibold mb-4 block">{t`Content`}</Label>
						<PortableTextEditor
							value={content as Parameters<typeof PortableTextEditor>[0]["value"]}
							onChange={(value) => setContent(value as unknown[])}
						/>
					</div>
				</div>

				{/* Sidebar */}
				<div className="col-span-4 space-y-6">
					{/* Metadata */}
					<div className="rounded-lg border bg-kumo-base p-6 space-y-4">
						<h2 className="text-lg font-semibold">{t`Section Details`}</h2>

						<Input
							label={t`Title`}
							value={title}
							onChange={(e) => setTitle(e.target.value)}
							placeholder={t`Section title`}
						/>

						<div>
							<Input
								label={t`Slug`}
								value={sectionSlug}
								onChange={(e) => {
									setSectionSlug(e.target.value);
									setSlugTouched(true);
								}}
								placeholder="section-slug"
								pattern="[a-z0-9-]+"
							/>
							<p className="text-xs text-kumo-subtle mt-1">
								{t`Used to identify this section. Lowercase letters, numbers, and hyphens only.`}
							</p>
						</div>

						<InputArea
							label={t`Description`}
							value={description}
							onChange={(e) => setDescription(e.target.value)}
							placeholder={t`Describe what this section is for...`}
							rows={3}
						/>

						<div>
							<Input
								label={t`Keywords`}
								value={keywords}
								onChange={(e) => setKeywords(e.target.value)}
								placeholder="hero, banner, cta"
							/>
							<p className="text-xs text-kumo-subtle mt-1">{t`Comma-separated keywords for search.`}</p>
						</div>
					</div>

					{/* Source info */}
					<div className="rounded-lg border bg-kumo-base p-6">
						<h2 className="text-lg font-semibold mb-2">{t`Source`}</h2>
						<p className="text-sm text-kumo-subtle">
							{section.source === "theme" && (
								<>
									{t`This section is provided by the theme. Editing will create a custom copy that overrides the theme version.`}
								</>
							)}
							{section.source === "user" && <>{t`This is a custom section.`}</>}
							{section.source === "import" && (
								<>{t`This section was imported from another system.`}</>
							)}
						</p>
						{section.themeId && (
							<p className="text-xs text-kumo-subtle mt-2">{t`Theme ID: ${section.themeId}`}</p>
						)}
					</div>
				</div>
			</div>
		</div>
	);
}
