/**
 * TanStack Router configuration for EmDash Admin
 *
 * Defines all admin routes and their components.
 */

import { Loader, Toast } from "@cloudflare/kumo";
import type { QueryClient } from "@tanstack/react-query";
import { useQuery, useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
	createRouter,
	createRootRouteWithContext,
	createRoute,
	Outlet,
	Link,
	useParams,
	useNavigate,
	useSearch,
} from "@tanstack/react-router";
import * as React from "react";

import { CommentInbox } from "./components/comments/CommentInbox";
import { ContentEditor } from "./components/ContentEditor";
import { ContentList } from "./components/ContentList";
import { ContentTypeEditor } from "./components/ContentTypeEditor";
import { ContentTypeList } from "./components/ContentTypeList";
import { Dashboard } from "./components/Dashboard";
import { DeviceAuthorizePage } from "./components/DeviceAuthorizePage";
import { LoginPage } from "./components/LoginPage";
import { MarketplaceBrowse } from "./components/MarketplaceBrowse";
import { MarketplacePluginDetail } from "./components/MarketplacePluginDetail";
import { MediaLibrary } from "./components/MediaLibrary";
import { MenuEditor } from "./components/MenuEditor";
import { MenuList } from "./components/MenuList";
import { PluginManager } from "./components/PluginManager";
import type { PluginBlockDef } from "./components/PortableTextEditor";
import { Redirects } from "./components/Redirects";
import { SandboxedPluginPage } from "./components/SandboxedPluginPage";
import { SectionEditor } from "./components/SectionEditor";
import { Sections } from "./components/Sections";
import { Settings } from "./components/Settings";
import { AllowedDomainsSettings } from "./components/settings/AllowedDomainsSettings";
import { ApiTokenSettings } from "./components/settings/ApiTokenSettings";
import { EmailSettings } from "./components/settings/EmailSettings";
import { GeneralSettings } from "./components/settings/GeneralSettings";
import { SecuritySettings } from "./components/settings/SecuritySettings";
import { SeoSettings } from "./components/settings/SeoSettings";
import { SocialSettings } from "./components/settings/SocialSettings";
import { SetupWizard } from "./components/SetupWizard";
import { Shell } from "./components/Shell";
import { SignupPage } from "./components/SignupPage";
import { TaxonomyManager } from "./components/TaxonomyManager";
import { ThemeMarketplaceBrowse } from "./components/ThemeMarketplaceBrowse";
import { ThemeMarketplaceDetail } from "./components/ThemeMarketplaceDetail";
import { Widgets } from "./components/Widgets";
import { WordPressImport } from "./components/WordPressImport";
import {
	apiFetch,
	parseApiResponse,
	fetchManifest,
	fetchContentList,
	fetchContent,
	createContent,
	updateContent,
	deleteContent,
	fetchTranslations,
	fetchMediaList,
	uploadMedia,
	deleteMedia,
	fetchCollections,
	fetchCollection,
	createCollection,
	updateCollection,
	deleteCollection,
	createField,
	updateField,
	deleteField,
	fetchOrphanedTables,
	registerOrphanedTable,
	fetchUsers,
	fetchBylines,
	createByline,
	updateByline,
	setSearchEnabled,
	fetchTrashedContent,
	restoreContent,
	permanentDeleteContent,
	duplicateContent,
	scheduleContent,
	unscheduleContent,
	publishContent,
	unpublishContent,
	discardDraft,
	fetchRevision,
	type AdminManifest,
	type CreateCollectionInput,
	type UpdateCollectionInput,
	type CreateFieldInput,
	type BylineCreditInput,
	type ContentSeoInput,
} from "./lib/api";
import {
	fetchComments,
	fetchCommentCounts,
	updateCommentStatus,
	deleteComment,
	bulkCommentAction,
	type CommentStatus,
} from "./lib/api/comments";
import { useElementReady } from "./lib/hooks";
import { usePluginPage } from "./lib/plugin-context";
import { sanitizeRedirectUrl } from "./lib/url";
import { BylinesPage } from "./routes/bylines";
import { UsersPage } from "./routes/users";

// Router context type
interface RouterContext {
	queryClient: QueryClient;
}

// Create a base root route without Shell for setup
const baseRootRoute = createRootRouteWithContext<RouterContext>()({
	component: () => <Outlet />,
});

// Setup route (standalone, no Shell)
const setupRoute = createRoute({
	getParentRoute: () => baseRootRoute,
	path: "/setup",
	component: SetupWizard,
});

// Login route (standalone, no Shell)
const loginRoute = createRoute({
	getParentRoute: () => baseRootRoute,
	path: "/login",
	component: LoginPageWrapper,
});

function LoginPageWrapper() {
	// Extract redirect URL from query params, sanitized to prevent open redirect / XSS
	const searchParams = new URLSearchParams(window.location.search);
	const redirect = sanitizeRedirectUrl(searchParams.get("redirect") || "/_emdash/admin");
	return <LoginPage redirectUrl={redirect} />;
}

// Signup route (standalone, no Shell)
const signupRoute = createRoute({
	getParentRoute: () => baseRootRoute,
	path: "/signup",
	component: SignupPage,
});

// Device authorization route (standalone, no Shell)
const deviceRoute = createRoute({
	getParentRoute: () => baseRootRoute,
	path: "/device",
	component: DeviceAuthorizePage,
});

// Layout route with Shell wrapper for admin pages (pathless - matches all admin routes)
const adminLayoutRoute = createRoute({
	getParentRoute: () => baseRootRoute,
	id: "_admin",
	component: RootComponent,
});

function RootComponent() {
	const {
		data: manifest,
		isLoading,
		error,
	} = useQuery({
		queryKey: ["manifest"],
		queryFn: fetchManifest,
	});

	if (isLoading) {
		return <LoadingScreen />;
	}

	if (error || !manifest) {
		return <ErrorScreen error={error?.message || "Failed to load admin"} />;
	}

	// Plugin admin components are passed via props and available through PluginAdminContext
	return (
		<Shell manifest={manifest}>
			<Outlet />
		</Shell>
	);
}

// Dashboard route - matches the index path "/"
const dashboardRoute = createRoute({
	getParentRoute: () => adminLayoutRoute,
	path: "/",
	component: DashboardPage,
});

function DashboardPage() {
	const { data: manifest } = useQuery({
		queryKey: ["manifest"],
		queryFn: fetchManifest,
	});

	if (!manifest) return null;

	return <Dashboard manifest={manifest} />;
}

// Content list route
const contentListRoute = createRoute({
	getParentRoute: () => adminLayoutRoute,
	path: "/content/$collection",
	component: ContentListPage,
	validateSearch: (search: Record<string, unknown>) => ({
		locale: typeof search.locale === "string" ? search.locale : undefined,
	}),
});

function ContentListPage() {
	const { collection } = useParams({ from: "/_admin/content/$collection" });
	const { locale: localeParam } = useSearch({ from: "/_admin/content/$collection" });
	const queryClient = useQueryClient();
	const navigate = useNavigate();
	const toastManager = Toast.useToastManager();

	const { data: manifest } = useQuery({
		queryKey: ["manifest"],
		queryFn: fetchManifest,
	});

	const i18n = manifest?.i18n;

	// Default to defaultLocale when i18n is enabled and no locale specified
	const activeLocale = i18n ? (localeParam ?? i18n.defaultLocale) : undefined;

	const { data, isLoading, error } = useQuery({
		queryKey: ["content", collection, { locale: activeLocale }],
		queryFn: () => fetchContentList(collection, { locale: activeLocale }),
	});

	// Fetch trashed items
	const { data: trashedData, isLoading: isTrashedLoading } = useQuery({
		queryKey: ["content", collection, "trash"],
		queryFn: () => fetchTrashedContent(collection),
	});

	const deleteMutation = useMutation({
		mutationFn: (id: string) => deleteContent(collection, id),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: ["content", collection] });
			void queryClient.invalidateQueries({ queryKey: ["content", collection, "trash"] });
		},
		onError: (mutationError) => {
			toastManager.add({
				title: "Failed to delete",
				description: mutationError instanceof Error ? mutationError.message : "An error occurred",
				type: "error",
			});
		},
	});

	const restoreMutation = useMutation({
		mutationFn: (id: string) => restoreContent(collection, id),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: ["content", collection] });
			void queryClient.invalidateQueries({ queryKey: ["content", collection, "trash"] });
		},
		onError: (mutationError) => {
			toastManager.add({
				title: "Failed to restore",
				description: mutationError instanceof Error ? mutationError.message : "An error occurred",
				type: "error",
			});
		},
	});

	const permanentDeleteMutation = useMutation({
		mutationFn: (id: string) => permanentDeleteContent(collection, id),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: ["content", collection, "trash"] });
		},
		onError: (mutationError) => {
			toastManager.add({
				title: "Failed to delete",
				description: mutationError instanceof Error ? mutationError.message : "An error occurred",
				type: "error",
			});
		},
	});

	const duplicateMutation = useMutation({
		mutationFn: (id: string) => duplicateContent(collection, id),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: ["content", collection] });
		},
		onError: (mutationError) => {
			toastManager.add({
				title: "Failed to duplicate",
				description: mutationError instanceof Error ? mutationError.message : "An error occurred",
				type: "error",
			});
		},
	});

	if (!manifest) {
		return <LoadingScreen />;
	}

	const collectionConfig = manifest.collections[collection];

	if (!collectionConfig) {
		return <NotFoundPage message={`Collection "${collection}" not found`} />;
	}

	if (error) {
		return <ErrorScreen error={error.message} />;
	}

	const handleLocaleChange = (locale: string) => {
		// Update URL search params without full navigation
		void navigate({
			to: "/content/$collection",
			params: { collection },
			search: { locale: locale || undefined },
		});
	};

	return (
		<ContentList
			collection={collection}
			collectionLabel={collectionConfig.label}
			items={data?.items || []}
			trashedItems={trashedData?.items || []}
			isLoading={isLoading}
			isTrashedLoading={isTrashedLoading}
			trashedCount={trashedData?.items?.length || 0}
			onDelete={(id) => deleteMutation.mutate(id)}
			onRestore={(id) => restoreMutation.mutate(id)}
			onPermanentDelete={(id) => permanentDeleteMutation.mutate(id)}
			onDuplicate={(id) => duplicateMutation.mutate(id)}
			i18n={i18n}
			activeLocale={activeLocale}
			onLocaleChange={handleLocaleChange}
		/>
	);
}

/** Extract plugin block definitions from the manifest for Portable Text editor */
function getPluginBlocks(manifest: AdminManifest): PluginBlockDef[] {
	const blocks: PluginBlockDef[] = [];
	for (const [pluginId, plugin] of Object.entries(manifest.plugins)) {
		if (plugin.portableTextBlocks) {
			for (const block of plugin.portableTextBlocks) {
				blocks.push({ ...block, pluginId });
			}
		}
	}
	return blocks;
}

// Content new route
const contentNewRoute = createRoute({
	getParentRoute: () => adminLayoutRoute,
	path: "/content/$collection/new",
	component: ContentNewPage,
});

function ContentNewPage() {
	const { collection } = useParams({ from: "/_admin/content/$collection/new" });
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const [selectedBylines, setSelectedBylines] = React.useState<BylineCreditInput[]>([]);

	const { data: manifest } = useQuery({
		queryKey: ["manifest"],
		queryFn: fetchManifest,
	});

	const createMutation = useMutation({
		mutationFn: (data: {
			data: Record<string, unknown>;
			slug?: string;
			bylines?: BylineCreditInput[];
		}) => createContent(collection, data),
		onSuccess: (result) => {
			void queryClient.invalidateQueries({ queryKey: ["content", collection] });
			void navigate({
				to: "/content/$collection/$id",
				params: { collection, id: result.id },
			});
		},
	});

	const pluginBlocks = React.useMemo(() => (manifest ? getPluginBlocks(manifest) : []), [manifest]);

	const { data: bylinesData } = useQuery({
		queryKey: ["bylines"],
		queryFn: () => fetchBylines({ limit: 100 }),
	});

	const createBylineMutation = useMutation({
		mutationFn: (input: { slug: string; displayName: string }) =>
			createByline({ ...input, isGuest: true }),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: ["bylines"] });
		},
	});

	const updateBylineMutation = useMutation({
		mutationFn: (input: { id: string; slug: string; displayName: string }) =>
			updateByline(input.id, {
				slug: input.slug,
				displayName: input.displayName,
			}),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: ["bylines"] });
		},
	});

	if (!manifest) {
		return <LoadingScreen />;
	}

	const collectionConfig = manifest.collections[collection];

	if (!collectionConfig) {
		return <NotFoundPage message={`Collection "${collection}" not found`} />;
	}

	const handleSave = (payload: {
		data: Record<string, unknown>;
		slug?: string;
		bylines?: BylineCreditInput[];
	}) => {
		createMutation.mutate(payload);
	};

	return (
		<ContentEditor
			collection={collection}
			collectionLabel={collectionConfig.labelSingular || collectionConfig.label}
			fields={collectionConfig.fields}
			isNew
			isSaving={createMutation.isPending}
			onSave={handleSave}
			pluginBlocks={pluginBlocks}
			availableBylines={bylinesData?.items}
			selectedBylines={selectedBylines}
			onBylinesChange={setSelectedBylines}
			onQuickCreateByline={async (input) => {
				const created = await createBylineMutation.mutateAsync(input);
				return created;
			}}
			onQuickEditByline={async (bylineId, input) => {
				const updated = await updateBylineMutation.mutateAsync({ id: bylineId, ...input });
				return updated;
			}}
			manifest={manifest ?? null}
		/>
	);
}

// Content edit route
const contentEditRoute = createRoute({
	getParentRoute: () => adminLayoutRoute,
	path: "/content/$collection/$id",
	component: ContentEditPage,
	validateSearch: (search) => ({
		...(typeof search.field === "string" && { field: search.field }),
	}),
});

// Editor role level from @emdash-cms/auth
const ROLE_EDITOR = 40;

function ContentEditPage() {
	const { collection, id } = useParams({
		from: "/_admin/content/$collection/$id",
	});
	const { field, ...preservedSearch } = useSearch({
		from: "/_admin/content/$collection/$id",
	});
	const queryClient = useQueryClient();
	const navigate = useNavigate();
	const toastManager = Toast.useToastManager();

	useElementReady(field && `#field-${field}`, (el) => {
		el.scrollIntoView({ behavior: "smooth", block: "center" });
		el.focus();
		void navigate({ search: preservedSearch as never, replace: true });
	});

	const { data: manifest } = useQuery({
		queryKey: ["manifest"],
		queryFn: fetchManifest,
	});

	const i18n = manifest?.i18n;

	const { data: rawItem, isLoading } = useQuery({
		queryKey: ["content", collection, id],
		queryFn: () => fetchContent(collection, id),
	});

	// Fetch translations when i18n is enabled
	const { data: translationsData } = useQuery({
		queryKey: ["translations", collection, id],
		queryFn: () => fetchTranslations(collection, id),
		enabled: !!i18n && !!rawItem,
	});

	// When a draft revision exists, fetch its data for the editor form.
	// The content table holds published data; the draft revision holds
	// the editor's working copy.
	const { data: draftRevision } = useQuery({
		queryKey: ["revision", rawItem?.draftRevisionId],
		queryFn: () => fetchRevision(rawItem!.draftRevisionId!),
		enabled: !!rawItem?.draftRevisionId,
	});

	// Merge draft revision data into the item for the editor.
	// The item's metadata (id, status, slug, etc.) comes from the content table;
	// the data fields come from the draft revision if available.
	const item = React.useMemo(() => {
		if (!rawItem) return undefined;
		if (!draftRevision?.data) return rawItem;
		// Strip revision metadata keys (prefixed with _)
		const draftData: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(draftRevision.data)) {
			if (!key.startsWith("_")) {
				draftData[key] = value;
			}
		}
		// Draft slug override
		const draftSlug =
			typeof draftRevision.data._slug === "string" ? draftRevision.data._slug : rawItem.slug;
		return {
			...rawItem,
			slug: draftSlug,
			data: { ...rawItem.data, ...draftData },
		};
	}, [rawItem, draftRevision]);

	// Fetch current user for permission checks
	const { data: currentUser } = useQuery({
		queryKey: ["currentUser"],
		queryFn: async (): Promise<{ id: string; role: number }> => {
			const response = await apiFetch("/_emdash/api/auth/me");
			return parseApiResponse<{ id: string; role: number }>(response, "Failed to fetch user");
		},
		staleTime: 5 * 60 * 1000,
	});

	// Fetch users list for author selector (only if user is editor+)
	const { data: usersData } = useQuery({
		queryKey: ["users"],
		queryFn: () => fetchUsers({ limit: 100 }),
		enabled: !!currentUser && currentUser.role >= ROLE_EDITOR,
		staleTime: 5 * 60 * 1000,
	});

	const { data: bylinesData } = useQuery({
		queryKey: ["bylines"],
		queryFn: () => fetchBylines({ limit: 100 }),
	});

	const createBylineMutation = useMutation({
		mutationFn: (input: { slug: string; displayName: string }) =>
			createByline({ ...input, isGuest: true }),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: ["bylines"] });
		},
	});

	const updateBylineMutation = useMutation({
		mutationFn: (input: { id: string; slug: string; displayName: string }) =>
			updateByline(input.id, {
				slug: input.slug,
				displayName: input.displayName,
			}),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: ["bylines"] });
		},
	});

	const updateMutation = useMutation({
		mutationFn: (data: {
			data?: Record<string, unknown>;
			slug?: string;
			authorId?: string | null;
			bylines?: BylineCreditInput[];
			skipRevision?: boolean;
			seo?: ContentSeoInput;
		}) => updateContent(collection, id, data),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: ["content", collection, id] });
			// Also invalidate revisions since a new one was created
			void queryClient.invalidateQueries({ queryKey: ["revisions", collection, id] });
		},
		onError: (error) => {
			toastManager.add({
				title: "Failed to save",
				description: error instanceof Error ? error.message : "An error occurred",
				type: "error",
			});
		},
	});

	// Autosave mutation - skips revision creation
	const [lastAutosaveAt, setLastAutosaveAt] = React.useState<Date | null>(null);
	const autosaveMutation = useMutation({
		mutationFn: (data: {
			data?: Record<string, unknown>;
			slug?: string;
			bylines?: BylineCreditInput[];
		}) => updateContent(collection, id, { ...data, skipRevision: true }),
		onSuccess: () => {
			setLastAutosaveAt(new Date());
			// Silently update the cache without full invalidation
			void queryClient.invalidateQueries({ queryKey: ["content", collection, id] });
		},
		onError: (err) => {
			toastManager.add({
				title: "Autosave failed",
				description: err instanceof Error ? err.message : "An error occurred",
				type: "error",
			});
		},
	});

	const publishMutation = useMutation({
		mutationFn: () => publishContent(collection, id),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: ["content", collection, id] });
			void queryClient.invalidateQueries({ queryKey: ["revisions", collection, id] });
			toastManager.add({ title: "Published", description: "Content is now live" });
		},
		onError: (error) => {
			toastManager.add({
				title: "Failed to publish",
				description: error instanceof Error ? error.message : "An error occurred",
				type: "error",
			});
		},
	});

	const unpublishMutation = useMutation({
		mutationFn: () => unpublishContent(collection, id),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: ["content", collection, id] });
			void queryClient.invalidateQueries({ queryKey: ["revisions", collection, id] });
			toastManager.add({ title: "Unpublished", description: "Content removed from public view" });
		},
		onError: (error) => {
			toastManager.add({
				title: "Failed to unpublish",
				description: error instanceof Error ? error.message : "An error occurred",
				type: "error",
			});
		},
	});

	const discardDraftMutation = useMutation({
		mutationFn: () => discardDraft(collection, id),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: ["content", collection, id] });
			void queryClient.invalidateQueries({ queryKey: ["revisions", collection, id] });
			toastManager.add({
				title: "Changes discarded",
				description: "Reverted to published version",
			});
		},
		onError: (error) => {
			toastManager.add({
				title: "Failed to discard changes",
				description: error instanceof Error ? error.message : "An error occurred",
				type: "error",
			});
		},
	});

	const scheduleMutation = useMutation({
		mutationFn: (scheduledAt: string) => scheduleContent(collection, id, scheduledAt),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: ["content", collection, id] });
			toastManager.add({
				title: "Scheduled",
				description: "Content has been scheduled for publishing",
			});
		},
		onError: (error) => {
			toastManager.add({
				title: "Failed to schedule",
				description: error instanceof Error ? error.message : "An error occurred",
				type: "error",
			});
		},
	});

	const unscheduleMutation = useMutation({
		mutationFn: () => unscheduleContent(collection, id),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: ["content", collection, id] });
			toastManager.add({
				title: "Unscheduled",
				description: "Content reverted to draft",
			});
		},
		onError: (error) => {
			toastManager.add({
				title: "Failed to unschedule",
				description: error instanceof Error ? error.message : "An error occurred",
				type: "error",
			});
		},
	});

	// Create translation mutation
	const translateMutation = useMutation({
		mutationFn: (locale: string) =>
			createContent(collection, {
				data: rawItem?.data ?? {},
				slug: rawItem?.slug ?? undefined,
				locale,
				translationOf: id,
			}),
		onSuccess: (result) => {
			void queryClient.invalidateQueries({ queryKey: ["translations", collection, id] });
			void queryClient.invalidateQueries({ queryKey: ["content", collection] });
			void navigate({
				to: "/content/$collection/$id",
				params: { collection, id: result.id },
			});
			toastManager.add({
				title: "Translation created",
				description: `Created ${result.locale?.toUpperCase() ?? "new"} translation`,
			});
		},
		onError: (error) => {
			toastManager.add({
				title: "Failed to create translation",
				description: error instanceof Error ? error.message : "An error occurred",
				type: "error",
			});
		},
	});

	const deleteMutation = useMutation({
		mutationFn: () => deleteContent(collection, id),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: ["content", collection] });
			void queryClient.invalidateQueries({ queryKey: ["content", collection, "trash"] });
			void navigate({
				to: "/content/$collection",
				params: { collection },
				search: { locale: undefined },
			});
		},
		onError: (error) => {
			toastManager.add({
				title: "Failed to delete",
				description: error instanceof Error ? error.message : "An error occurred",
				type: "error",
			});
		},
	});

	const pluginBlocks = React.useMemo(() => (manifest ? getPluginBlocks(manifest) : []), [manifest]);

	if (!manifest) {
		return <LoadingScreen />;
	}

	const collectionConfig = manifest.collections[collection];

	if (!collectionConfig) {
		return <NotFoundPage message={`Collection "${collection}" not found`} />;
	}

	if (isLoading) {
		return <LoadingScreen />;
	}

	const handleSave = (payload: {
		data: Record<string, unknown>;
		slug?: string;
		bylines?: BylineCreditInput[];
	}) => {
		updateMutation.mutate(payload);
	};

	const handleAutosave = (payload: {
		data: Record<string, unknown>;
		slug?: string;
		bylines?: BylineCreditInput[];
	}) => {
		autosaveMutation.mutate(payload);
	};

	const handleAuthorChange = (authorId: string | null) => {
		updateMutation.mutate({ authorId });
	};

	const handleSeoChange = (seo: ContentSeoInput) => {
		updateMutation.mutate({ seo });
	};

	return (
		<ContentEditor
			collection={collection}
			collectionLabel={collectionConfig.labelSingular || collectionConfig.label}
			item={item}
			fields={collectionConfig.fields}
			isSaving={updateMutation.isPending}
			onSave={handleSave}
			onAutosave={handleAutosave}
			isAutosaving={autosaveMutation.isPending}
			lastAutosaveAt={lastAutosaveAt}
			onPublish={() => publishMutation.mutate()}
			onUnpublish={() => unpublishMutation.mutate()}
			onDiscardDraft={() => discardDraftMutation.mutate()}
			onSchedule={(scheduledAt) => scheduleMutation.mutate(scheduledAt)}
			onUnschedule={() => unscheduleMutation.mutate()}
			isScheduling={scheduleMutation.isPending}
			onDelete={() => deleteMutation.mutate()}
			isDeleting={deleteMutation.isPending}
			supportsDrafts={collectionConfig.supports.includes("drafts")}
			supportsRevisions={collectionConfig.supports.includes("revisions")}
			currentUser={currentUser}
			users={usersData?.items}
			onAuthorChange={handleAuthorChange}
			i18n={i18n}
			translations={translationsData?.translations}
			onTranslate={(locale) => translateMutation.mutate(locale)}
			pluginBlocks={pluginBlocks}
			hasSeo={collectionConfig.hasSeo}
			onSeoChange={handleSeoChange}
			availableBylines={bylinesData?.items}
			onQuickCreateByline={async (input) => {
				const created = await createBylineMutation.mutateAsync(input);
				return created;
			}}
			onQuickEditByline={async (bylineId, input) => {
				const updated = await updateBylineMutation.mutateAsync({ id: bylineId, ...input });
				return updated;
			}}
			manifest={manifest ?? null}
		/>
	);
}

// Media library route
const mediaRoute = createRoute({
	getParentRoute: () => adminLayoutRoute,
	path: "/media",
	component: MediaPage,
});

function MediaPage() {
	const queryClient = useQueryClient();

	const { data, isLoading, error } = useQuery({
		queryKey: ["media"],
		queryFn: () => fetchMediaList(),
	});

	const uploadMutation = useMutation({
		mutationFn: (file: File) => uploadMedia(file),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: ["media"] });
		},
	});

	const deleteMutation = useMutation({
		mutationFn: (id: string) => deleteMedia(id),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: ["media"] });
		},
	});

	if (error) {
		return <ErrorScreen error={error.message} />;
	}

	return (
		<MediaLibrary
			items={data?.items || []}
			isLoading={isLoading}
			onUpload={(file) => uploadMutation.mutate(file)}
			onDelete={(id) => deleteMutation.mutate(id)}
		/>
	);
}

// Comments moderation inbox route
const commentsRoute = createRoute({
	getParentRoute: () => adminLayoutRoute,
	path: "/comments",
	component: CommentsPage,
});

// Admin role level from @emdash-cms/auth
const ROLE_ADMIN = 50;

function CommentsPage() {
	const queryClient = useQueryClient();
	const toastManager = Toast.useToastManager();

	const { data: manifest } = useQuery({
		queryKey: ["manifest"],
		queryFn: fetchManifest,
	});

	// Current user for ADMIN check (hard delete)
	const { data: currentUser } = useQuery({
		queryKey: ["currentUser"],
		queryFn: async (): Promise<{ id: string; role: number }> => {
			const response = await apiFetch("/_emdash/api/auth/me");
			return parseApiResponse<{ id: string; role: number }>(response, "Failed to fetch user");
		},
		staleTime: 5 * 60 * 1000,
	});

	// Filter state
	const [activeStatus, setActiveStatus] = React.useState<CommentStatus>("pending");
	const [collectionFilter, setCollectionFilter] = React.useState("");
	const [searchQuery, setSearchQuery] = React.useState("");
	const [debouncedSearch, setDebouncedSearch] = React.useState("");

	// Debounce search
	React.useEffect(() => {
		const timer = setTimeout(setDebouncedSearch, 300, searchQuery);
		return () => clearTimeout(timer);
	}, [searchQuery]);

	// Fetch comments
	const {
		data: commentsData,
		isLoading,
		fetchNextPage,
		hasNextPage,
	} = useInfiniteQuery({
		queryKey: ["comments", activeStatus, collectionFilter, debouncedSearch],
		queryFn: ({ pageParam }) =>
			fetchComments({
				status: activeStatus,
				collection: collectionFilter || undefined,
				search: debouncedSearch || undefined,
				cursor: pageParam,
				limit: 50,
			}),
		initialPageParam: undefined as string | undefined,
		getNextPageParam: (lastPage) => lastPage.nextCursor,
	});

	// Fetch counts
	const { data: counts } = useQuery({
		queryKey: ["commentCounts"],
		queryFn: fetchCommentCounts,
	});

	// Status change mutation
	const statusMutation = useMutation({
		mutationFn: ({ id, status }: { id: string; status: CommentStatus }) =>
			updateCommentStatus(id, status),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: ["comments"] });
			void queryClient.invalidateQueries({ queryKey: ["commentCounts"] });
		},
		onError: (error) => {
			toastManager.add({
				title: "Failed to update status",
				description: error instanceof Error ? error.message : "An error occurred",
				type: "error",
			});
		},
	});

	// Delete mutation
	const deleteMutation = useMutation({
		mutationFn: (id: string) => deleteComment(id),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: ["comments"] });
			void queryClient.invalidateQueries({ queryKey: ["commentCounts"] });
		},
		onError: (error) => {
			toastManager.add({
				title: "Failed to delete comment",
				description: error instanceof Error ? error.message : "An error occurred",
				type: "error",
			});
		},
	});

	// Bulk action mutation
	const bulkMutation = useMutation({
		mutationFn: ({
			ids,
			action,
		}: {
			ids: string[];
			action: "approve" | "spam" | "trash" | "delete";
		}) => bulkCommentAction(ids, action),
		onSuccess: (result) => {
			void queryClient.invalidateQueries({ queryKey: ["comments"] });
			void queryClient.invalidateQueries({ queryKey: ["commentCounts"] });
			toastManager.add({
				title: `${result.affected} comment${result.affected !== 1 ? "s" : ""} updated`,
			});
		},
		onError: (error) => {
			toastManager.add({
				title: "Failed to perform bulk action",
				description: error instanceof Error ? error.message : "An error occurred",
				type: "error",
			});
		},
	});

	const allComments = commentsData?.pages.flatMap((p) => p.items) ?? [];
	const lastPage = commentsData?.pages[commentsData.pages.length - 1];

	// Require EDITOR role for comment moderation
	if (currentUser && currentUser.role < ROLE_EDITOR) {
		return (
			<div className="flex items-center justify-center min-h-[50vh]">
				<div className="text-center">
					<h1 className="text-2xl font-bold">Access Denied</h1>
					<p className="mt-2 text-kumo-subtle">You need Editor permissions to moderate comments.</p>
				</div>
			</div>
		);
	}

	return (
		<CommentInbox
			comments={allComments}
			counts={counts ?? { pending: 0, approved: 0, spam: 0, trash: 0 }}
			isLoading={isLoading}
			nextCursor={lastPage?.nextCursor}
			collections={manifest?.collections ?? {}}
			activeStatus={activeStatus}
			onStatusChange={setActiveStatus}
			collectionFilter={collectionFilter}
			onCollectionFilterChange={setCollectionFilter}
			searchQuery={searchQuery}
			onSearchChange={setSearchQuery}
			onCommentStatusChange={(id, status) =>
				statusMutation.mutateAsync({ id, status }).catch(() => {})
			}
			onCommentDelete={(id) => deleteMutation.mutateAsync(id).catch(() => {})}
			onBulkAction={(ids, action) => bulkMutation.mutateAsync({ ids, action }).catch(() => {})}
			onLoadMore={() => {
				if (hasNextPage) void fetchNextPage();
			}}
			isAdmin={(currentUser?.role ?? 0) >= ROLE_ADMIN}
			isStatusPending={
				statusMutation.isPending || deleteMutation.isPending || bulkMutation.isPending
			}
			deleteError={deleteMutation.error}
			onDeleteErrorReset={() => deleteMutation.reset()}
		/>
	);
}

// Settings route
const settingsRoute = createRoute({
	getParentRoute: () => adminLayoutRoute,
	path: "/settings",
	component: Settings,
});

// Security settings route
const securitySettingsRoute = createRoute({
	getParentRoute: () => adminLayoutRoute,
	path: "/settings/security",
	component: SecuritySettings,
});

// Allowed domains settings route
const allowedDomainsSettingsRoute = createRoute({
	getParentRoute: () => adminLayoutRoute,
	path: "/settings/allowed-domains",
	component: AllowedDomainsSettings,
});

// API tokens settings route
const apiTokenSettingsRoute = createRoute({
	getParentRoute: () => adminLayoutRoute,
	path: "/settings/api-tokens",
	component: ApiTokenSettings,
});

// Email settings route
const emailSettingsRoute = createRoute({
	getParentRoute: () => adminLayoutRoute,
	path: "/settings/email",
	component: EmailSettings,
});

// General settings route
const generalSettingsRoute = createRoute({
	getParentRoute: () => adminLayoutRoute,
	path: "/settings/general",
	component: GeneralSettings,
});

// Social settings route
const socialSettingsRoute = createRoute({
	getParentRoute: () => adminLayoutRoute,
	path: "/settings/social",
	component: SocialSettings,
});

// SEO settings route
const seoSettingsRoute = createRoute({
	getParentRoute: () => adminLayoutRoute,
	path: "/settings/seo",
	component: SeoSettings,
});

// Plugin manager route
const pluginManagerRoute = createRoute({
	getParentRoute: () => adminLayoutRoute,
	path: "/plugins-manager",
	component: PluginManagerPage,
});

function PluginManagerPage() {
	const { data: manifest } = useQuery({
		queryKey: ["manifest"],
		queryFn: fetchManifest,
	});
	return <PluginManager manifest={manifest} />;
}

// Marketplace browse route
const marketplaceBrowseRoute = createRoute({
	getParentRoute: () => adminLayoutRoute,
	path: "/plugins/marketplace",
	component: MarketplaceBrowsePage,
});

function MarketplaceBrowsePage() {
	const { data: plugins } = useQuery({
		queryKey: ["plugins"],
		queryFn: async () => {
			const { fetchPlugins } = await import("./lib/api/plugins.js");
			return fetchPlugins();
		},
	});

	const installedIds = React.useMemo(() => {
		if (!plugins) return new Set<string>();
		return new Set(plugins.map((p) => p.id));
	}, [plugins]);

	return <MarketplaceBrowse installedPluginIds={installedIds} />;
}

// Marketplace plugin detail route
const marketplaceDetailRoute = createRoute({
	getParentRoute: () => adminLayoutRoute,
	path: "/plugins/marketplace/$pluginId",
	component: MarketplaceDetailPage,
});

function MarketplaceDetailPage() {
	const { pluginId } = useParams({ from: "/_admin/plugins/marketplace/$pluginId" });

	const { data: plugins } = useQuery({
		queryKey: ["plugins"],
		queryFn: async () => {
			const { fetchPlugins } = await import("./lib/api/plugins.js");
			return fetchPlugins();
		},
	});

	const installedIds = React.useMemo(() => {
		if (!plugins) return new Set<string>();
		return new Set(plugins.map((p) => p.id));
	}, [plugins]);

	return <MarketplacePluginDetail pluginId={pluginId} installedPluginIds={installedIds} />;
}

// Theme marketplace browse route
const themeMarketplaceBrowseRoute = createRoute({
	getParentRoute: () => adminLayoutRoute,
	path: "/themes/marketplace",
	component: ThemeMarketplaceBrowse,
});

// Theme marketplace detail route
const themeMarketplaceDetailRoute = createRoute({
	getParentRoute: () => adminLayoutRoute,
	path: "/themes/marketplace/$themeId",
	component: ThemeDetailPage,
});

function ThemeDetailPage() {
	const { themeId } = useParams({ from: "/_admin/themes/marketplace/$themeId" });
	return <ThemeMarketplaceDetail themeId={themeId} />;
}

// WordPress import route
const wordpressImportRoute = createRoute({
	getParentRoute: () => adminLayoutRoute,
	path: "/import/wordpress",
	component: WordPressImport,
});

// Menu routes
const menuListRoute = createRoute({
	getParentRoute: () => adminLayoutRoute,
	path: "/menus",
	component: MenuList,
});

const menuEditorRoute = createRoute({
	getParentRoute: () => adminLayoutRoute,
	path: "/menus/$name",
	component: MenuEditor,
});

// Taxonomy manager route
const taxonomyRoute = createRoute({
	getParentRoute: () => adminLayoutRoute,
	path: "/taxonomies/$taxonomy",
	component: TaxonomyPage,
});

function TaxonomyPage() {
	const { taxonomy } = useParams({ from: "/_admin/taxonomies/$taxonomy" });
	return <TaxonomyManager taxonomyName={taxonomy} />;
}

// Widgets route
const widgetsRoute = createRoute({
	getParentRoute: () => adminLayoutRoute,
	path: "/widgets",
	component: Widgets,
});

// Sections routes
const redirectsRoute = createRoute({
	getParentRoute: () => adminLayoutRoute,
	path: "/redirects",
	component: Redirects,
});

const sectionsListRoute = createRoute({
	getParentRoute: () => adminLayoutRoute,
	path: "/sections",
	component: Sections,
});

const sectionEditRoute = createRoute({
	getParentRoute: () => adminLayoutRoute,
	path: "/sections/$slug",
	component: SectionEditor,
});

// Users route
const usersRoute = createRoute({
	getParentRoute: () => adminLayoutRoute,
	path: "/users",
	component: UsersPage,
});

// Bylines route
const bylinesRoute = createRoute({
	getParentRoute: () => adminLayoutRoute,
	path: "/bylines",
	component: BylinesPage,
});

// Content Types routes
const contentTypesListRoute = createRoute({
	getParentRoute: () => adminLayoutRoute,
	path: "/content-types",
	component: ContentTypesListPage,
});

function ContentTypesListPage() {
	const queryClient = useQueryClient();

	const {
		data: collections,
		isLoading: collectionsLoading,
		error: collectionsError,
	} = useQuery({
		queryKey: ["schema", "collections"],
		queryFn: fetchCollections,
	});

	const {
		data: orphanedTables,
		isLoading: orphansLoading,
		error: orphansError,
	} = useQuery({
		queryKey: ["schema", "orphans"],
		queryFn: fetchOrphanedTables,
	});

	const deleteMutation = useMutation({
		mutationFn: (slug: string) => deleteCollection(slug, true),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: ["schema", "collections"] });
			void queryClient.invalidateQueries({ queryKey: ["manifest"] });
		},
	});

	const registerOrphanMutation = useMutation({
		mutationFn: (slug: string) => registerOrphanedTable(slug),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: ["schema", "collections"] });
			void queryClient.invalidateQueries({ queryKey: ["schema", "orphans"] });
			void queryClient.invalidateQueries({ queryKey: ["manifest"] });
		},
	});

	const error = collectionsError || orphansError;
	if (error) {
		return <ErrorScreen error={error.message} />;
	}

	return (
		<ContentTypeList
			collections={collections ?? []}
			orphanedTables={orphanedTables}
			isLoading={collectionsLoading || orphansLoading}
			onDelete={(slug) => deleteMutation.mutate(slug)}
			onRegisterOrphan={(slug) => registerOrphanMutation.mutate(slug)}
		/>
	);
}

const contentTypesNewRoute = createRoute({
	getParentRoute: () => adminLayoutRoute,
	path: "/content-types/new",
	component: ContentTypesNewPage,
});

function ContentTypesNewPage() {
	const navigate = useNavigate();
	const queryClient = useQueryClient();

	const createMutation = useMutation({
		mutationFn: (input: CreateCollectionInput) => createCollection(input),
		onSuccess: (result) => {
			void queryClient.invalidateQueries({ queryKey: ["schema", "collections"] });
			void queryClient.invalidateQueries({ queryKey: ["manifest"] });
			void navigate({
				to: "/content-types/$slug",
				params: { slug: result.slug },
			});
		},
	});

	return (
		<ContentTypeEditor
			isNew
			isSaving={createMutation.isPending}
			onSave={(input) => {
				createMutation.mutate(input as CreateCollectionInput);
			}}
		/>
	);
}

const contentTypesEditRoute = createRoute({
	getParentRoute: () => adminLayoutRoute,
	path: "/content-types/$slug",
	component: ContentTypesEditPage,
});

function ContentTypesEditPage() {
	const { slug } = useParams({ from: "/_admin/content-types/$slug" });
	const queryClient = useQueryClient();

	const {
		data: collection,
		isLoading,
		error,
	} = useQuery({
		queryKey: ["schema", "collections", slug],
		queryFn: () => fetchCollection(slug),
	});

	const updateMutation = useMutation({
		mutationFn: async (input: UpdateCollectionInput) => {
			// Check if search support is being toggled
			const oldSupports = collection?.supports ?? [];
			const newSupports = input.supports ?? oldSupports;
			const hadSearch = oldSupports.includes("search");
			const hasSearch = newSupports.includes("search");

			// Update the collection first
			const result = await updateCollection(slug, input);

			// If search support changed, enable/disable search
			if (hadSearch !== hasSearch) {
				try {
					await setSearchEnabled(slug, hasSearch);
				} catch (err) {
					// Log but don't fail the mutation - search can be enabled manually
					console.error("Failed to toggle search:", err);
				}
			}

			return result;
		},
		onSuccess: () => {
			void queryClient.invalidateQueries({
				queryKey: ["schema", "collections", slug],
			});
			void queryClient.invalidateQueries({ queryKey: ["schema", "collections"] });
			void queryClient.invalidateQueries({ queryKey: ["manifest"] });
		},
	});

	const addFieldMutation = useMutation({
		mutationFn: (input: CreateFieldInput) => createField(slug, input),
		onSuccess: () => {
			void queryClient.invalidateQueries({
				queryKey: ["schema", "collections", slug],
			});
			void queryClient.invalidateQueries({ queryKey: ["manifest"] });
		},
	});

	const updateFieldMutation = useMutation({
		mutationFn: ({ fieldSlug, input }: { fieldSlug: string; input: CreateFieldInput }) =>
			updateField(slug, fieldSlug, input),
		onSuccess: () => {
			void queryClient.invalidateQueries({
				queryKey: ["schema", "collections", slug],
			});
			void queryClient.invalidateQueries({ queryKey: ["manifest"] });
		},
	});

	const deleteFieldMutation = useMutation({
		mutationFn: (fieldSlug: string) => deleteField(slug, fieldSlug),
		onSuccess: () => {
			void queryClient.invalidateQueries({
				queryKey: ["schema", "collections", slug],
			});
			void queryClient.invalidateQueries({ queryKey: ["manifest"] });
		},
	});

	if (error) {
		return <ErrorScreen error={error.message} />;
	}

	if (isLoading) {
		return <LoadingScreen />;
	}

	return (
		<ContentTypeEditor
			collection={collection}
			isSaving={updateMutation.isPending}
			onSave={(input) => updateMutation.mutate(input as UpdateCollectionInput)}
			onAddField={(input) => addFieldMutation.mutateAsync(input)}
			onUpdateField={(fieldSlug, input) => updateFieldMutation.mutateAsync({ fieldSlug, input })}
			onDeleteField={(fieldSlug) => deleteFieldMutation.mutate(fieldSlug)}
		/>
	);
}

// Plugin page route
const pluginRoute = createRoute({
	getParentRoute: () => adminLayoutRoute,
	path: "/plugins/$pluginId/$",
	component: PluginPage,
});

function PluginPage() {
	const { pluginId } = useParams({ from: "/_admin/plugins/$pluginId/$" });
	const { _splat } = useParams({ from: "/_admin/plugins/$pluginId/$" });
	const pagePath = "/" + (_splat || "");

	// Get plugin page component from context (trusted plugins with React)
	const PluginComponent = usePluginPage(pluginId, pagePath);

	if (PluginComponent) {
		return <PluginComponent />;
	}

	// No React component — fall back to Block Kit rendering
	return <SandboxedPluginPage pluginId={pluginId} page={pagePath} />;
}

// Catch-all 404 route
const notFoundRoute = createRoute({
	getParentRoute: () => adminLayoutRoute,
	path: "*",
	component: () => <NotFoundPage />,
});

// Create route tree with admin routes under layout and setup route separate
const adminRoutes = adminLayoutRoute.addChildren([
	dashboardRoute,
	contentListRoute,
	contentNewRoute,
	contentEditRoute,
	contentTypesListRoute,
	contentTypesNewRoute,
	contentTypesEditRoute,
	mediaRoute,
	commentsRoute,
	menuListRoute,
	menuEditorRoute,
	pluginManagerRoute,
	marketplaceDetailRoute,
	marketplaceBrowseRoute,
	themeMarketplaceBrowseRoute,
	themeMarketplaceDetailRoute,
	pluginRoute,
	redirectsRoute,
	sectionsListRoute,
	sectionEditRoute,
	taxonomyRoute,
	usersRoute,
	bylinesRoute,
	widgetsRoute,
	settingsRoute,
	generalSettingsRoute,
	socialSettingsRoute,
	seoSettingsRoute,
	securitySettingsRoute,
	allowedDomainsSettingsRoute,
	apiTokenSettingsRoute,
	emailSettingsRoute,
	wordpressImportRoute,
	notFoundRoute,
]);

const routeTree = baseRootRoute.addChildren([
	setupRoute,
	loginRoute,
	signupRoute,
	deviceRoute,
	adminRoutes,
]);

// Create router
export function createAdminRouter(queryClient: QueryClient) {
	return createRouter({
		routeTree,
		context: { queryClient },
		basepath: "/_emdash/admin",
		defaultPreload: "intent",
	});
}

// Declare router type
declare module "@tanstack/react-router" {
	interface Register {
		router: ReturnType<typeof createAdminRouter>;
	}
}

// Shared components

function LoadingScreen() {
	return (
		<div className="flex items-center justify-center min-h-screen">
			<div className="text-center">
				<Loader />
				<p className="mt-4 text-kumo-subtle">Loading configuration...</p>
			</div>
		</div>
	);
}

function ErrorScreen({ error }: { error: string }) {
	return (
		<div className="flex items-center justify-center min-h-screen">
			<div className="text-center">
				<h1 className="text-xl font-bold text-kumo-danger">Error</h1>
				<p className="mt-2 text-kumo-subtle">{error}</p>
				<button
					onClick={() => window.location.reload()}
					className="mt-4 px-4 py-2 bg-kumo-brand text-white rounded-md"
				>
					Retry
				</button>
			</div>
		</div>
	);
}

function NotFoundPage({ message }: { message?: string }) {
	return (
		<div className="flex items-center justify-center min-h-[50vh]">
			<div className="text-center">
				<h1 className="text-2xl font-bold">Page Not Found</h1>
				<p className="mt-2 text-kumo-subtle">
					{message || "The page you're looking for doesn't exist."}
				</p>
				<Link to="/" className="mt-4 inline-block text-kumo-brand">
					Go to Dashboard
				</Link>
			</div>
		</div>
	);
}

export { Link, useNavigate, useParams };
