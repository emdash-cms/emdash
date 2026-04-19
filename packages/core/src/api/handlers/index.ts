/**
 * API handler implementations for EmDash REST endpoints
 *
 * Re-exports all handlers from their respective modules
 */

// Content handlers
export {
	handleContentList,
	handleContentGet,
	handleContentGetIncludingTrashed,
	handleContentCreate,
	handleContentUpdate,
	handleContentDuplicate,
	handleContentDelete,
	handleContentRestore,
	handleContentPermanentDelete,
	handleContentListTrashed,
	handleContentCountTrashed,
	handleContentSchedule,
	handleContentUnschedule,
	handleContentPublish,
	handleContentUnpublish,
	handleContentCountScheduled,
	handleContentDiscardDraft,
	handleContentCompare,
	handleContentTranslations,
	type TrashedContentItem,
} from "./content.js";

// Dashboard stats
export {
	handleDashboardStats,
	type CollectionStats,
	type DashboardStats,
	type RecentItem,
} from "./dashboard.js";

// Manifest generation
export { generateManifest } from "./manifest.js";

// Revision handlers
export {
	handleRevisionList,
	handleRevisionGet,
	handleRevisionRestore,
	type RevisionListResponse,
	type RevisionResponse,
} from "./revision.js";

// Media handlers
export {
	handleMediaList,
	handleMediaGet,
	handleMediaCreate,
	handleMediaUpdate,
	handleMediaDelete,
	type MediaListResponse,
	type MediaResponse,
} from "./media.js";

// Schema handlers
export {
	handleSchemaCollectionList,
	handleSchemaCollectionGet,
	handleSchemaCollectionCreate,
	handleSchemaCollectionUpdate,
	handleSchemaCollectionDelete,
	handleSchemaFieldList,
	handleSchemaFieldGet,
	handleSchemaFieldCreate,
	handleSchemaFieldUpdate,
	handleSchemaFieldDelete,
	handleSchemaFieldReorder,
	handleOrphanedTableList,
	handleOrphanedTableRegister,
	type CollectionListResponse,
	type CollectionResponse,
	type CollectionWithFieldsResponse,
	type FieldListResponse,
	type FieldResponse,
	type OrphanedTable,
	type OrphanedTableListResponse,
} from "./schema.js";

// SEO handlers
export {
	handleSitemapData,
	type SitemapCollectionData,
	type SitemapContentEntry,
	type SitemapDataResponse,
} from "./seo.js";

// Plugin handlers
export {
	handlePluginList,
	handlePluginGet,
	handlePluginEnable,
	handlePluginDisable,
	type PluginInfo,
	type PluginListResponse,
	type PluginResponse,
} from "./plugins.js";

// Menu handlers
export {
	handleMenuList,
	handleMenuCreate,
	handleMenuGet,
	handleMenuUpdate,
	handleMenuDelete,
	handleMenuItemCreate,
	handleMenuItemUpdate,
	handleMenuItemDelete,
	handleMenuItemReorder,
	type MenuListItem,
	type MenuWithItems,
	type CreateMenuItemInput,
	type UpdateMenuItemInput,
	type ReorderItem,
} from "./menus.js";

// Section handlers
export {
	handleSectionList,
	handleSectionCreate,
	handleSectionGet,
	handleSectionUpdate,
	handleSectionDelete,
	type SectionListResponse,
} from "./sections.js";

// Settings handlers
export { handleSettingsGet, handleSettingsUpdate } from "./settings.js";

// Taxonomy handlers
export {
	handleTaxonomyList,
	handleTermList,
	handleTermCreate,
	handleTermGet,
	handleTermUpdate,
	handleTermDelete,
	type TaxonomyDef,
	type TaxonomyListResponse,
	type TermData,
	type TermWithCount,
	type TermListResponse,
	type TermResponse,
	type TermGetResponse,
} from "./taxonomies.js";

// Marketplace handlers
export {
	handleMarketplaceInstall,
	handleMarketplaceUpdate,
	handleMarketplaceUninstall,
	handleMarketplaceUpdateCheck,
	handleMarketplaceSearch,
	handleMarketplaceGetPlugin,
	handleMarketplaceGetCategories,
	handleThemeSearch,
	handleThemeGetDetail,
	loadBundleFromR2,
	type MarketplaceInstallResult,
	type MarketplaceUpdateResult,
	type MarketplaceUpdateCheck,
	type MarketplaceUninstallResult,
} from "./marketplace.js";
