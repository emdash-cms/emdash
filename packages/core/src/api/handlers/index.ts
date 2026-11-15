/**
 * API handler implementations for EmDash REST endpoints
 *
 * Re-exports all handlers from their respective modules
 */

// Content handlers
export {
	handleContentList,
	handleContentAuthors,
	type ContentAuthor,
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

export {
	aggregateMediaUsageCoverageStatus,
	handleMediaUsageDetails,
	handleMediaUsageSummaries,
	handleMediaUsageRepair,
	toMediaUsageRepairResponse,
	type MediaUsageCoverage,
	type MediaUsageCoverageStatus,
	type MediaUsageDetailsResponse,
	type MediaUsageEntryDetail,
	type MediaUsageOccurrenceDetail,
	type MediaUsageRepairResponse,
	type MediaUsageSourceDetail,
	type MediaUsageSummary,
} from "./media-usage.js";

export {
	handleMediaUsageWorkList,
	handleMediaUsageWorkRetry,
	type MediaUsageWorkItem,
	type MediaUsageWorkListQuery,
	type MediaUsageWorkListResponse,
	type MediaUsageWorkRetryRequest,
	type MediaUsageWorkRetryResponse,
} from "./media-usage-work.js";

// Schema handlers
export {
	handleSchemaCollectionList,
	handleSchemaCollectionGet,
	handleSchemaCollectionCreate,
	handleSchemaCollectionUpdate,
	handleSchemaCollectionDelete,
	handleSchemaCollectionReorder,
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
export {
	handlePluginSettingsGet,
	handlePluginSettingsUpdate,
	getPluginSettingsSchema,
	type PluginSettingsResponse,
} from "./plugin-settings.js";

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
	handleMenuSetItems,
	type MenuListItem,
	type MenuWithItems,
	type CreateMenuItemInput,
	type UpdateMenuItemInput,
	type ReorderItem,
	type MenuSetItemsInput,
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
export {
	handlePromotionalCampaignGet,
	handlePromotionalCampaignList,
	handlePromotionalCampaignCreate,
	handlePromotionalCampaignUpdate,
	handlePromotionalCampaignDelete,
	type PromotionalCampaign,
	type PromotionalCampaignInput,
} from "./promotions.js";

// Ecommerce handlers
export {
	handleShopSettingsGet,
	handleShopPublicSettingsGet,
	handleShopSettingsUpdate,
	resolveShopPaymentGatewayCredentials,
	handleShopDeliveryZoneList,
	handleShopDeliveryZoneCreate,
	handleShopDeliveryZoneUpdate,
	handleShopDeliveryZoneDelete,
	handleShopProductList,
	handleShopProductRelatedList,
	handleShopProductGet,
	handleShopServiceList,
	handleShopServiceGet,
	handleShopOrderCreate,
	handleShopOrderList,
	handleShopCustomerList,
	handleShopOrderGet,
	handleShopOrderWhatsAppUrl,
	handleShopPaymentConfirm,
	handleShopDeliveryUpdate,
	type ShopSettings,
	type ShopPublicSettings,
	type ShopSettingsUpdateInput,
	type ShopPaymentGatewayCredentials,
	type ShopDeliveryZone,
	type ShopDeliveryZoneInput,
	type ShopOrderInput,
	type ShopOrderSummary,
	type ShopOrderDetail,
	type ShopCustomerSummary,
} from "./shop.js";
export {
	handleShopBookingAvailability,
	handleShopBookingHold,
	handleShopBookingHoursGet,
	handleShopBookingHoursUpdate,
	handleShopReservationList,
	handleShopReservationUpdate,
	expireShopReservations,
	handleShopBookingBlocksList,
	handleShopBookingBlockCreate,
	handleShopBookingBlockDelete,
	type ShopBookingSlot,
	type ShopBookingHold,
	type ShopBookingHoldInput,
	type ShopBookingHour,
	type ShopBookingHoursUpdateInput,
	type ShopReservationSummary,
	type ShopBookingBlock,
} from "./booking.js";
export {
	handleShopEnrollmentList,
	handleShopEnrollmentUpdate,
	type ShopEnrollmentSummary,
} from "./enrollment.js";

// Taxonomy handlers
export {
	handleTaxonomyList,
	handleTaxonomyGet,
	handleTaxonomyUpdate,
	handleTaxonomyDelete,
	handleTaxonomyDefTranslations,
	handleTermList,
	handleTermCreate,
	handleTermGet,
	handleTermUpdate,
	handleTermDelete,
	type TaxonomyDef,
	type TaxonomyListResponse,
	type TaxonomyResponse,
	type TaxonomyDefTranslationsResponse,
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
	handleThemeSearch,
	handleThemeGetDetail,
	loadBundleFromR2,
	type MarketplaceInstallResult,
	type MarketplaceUpdateResult,
	type MarketplaceUpdateCheck,
	type MarketplaceUninstallResult,
} from "./marketplace.js";

// Registry handlers (experimental)
export {
	assertEnvCompatible,
	assertSafeArtifactUrl,
	handleRegistryInstall,
	handleRegistryUninstall,
	handleRegistryUpdate,
	handleRegistryUpdateCheck,
	type RegistryInstallInput,
	type RegistryInstallResult,
	type RegistryUninstallResult,
	type RegistryUpdateCheck,
	type RegistryUpdateResult,
} from "./registry.js";
