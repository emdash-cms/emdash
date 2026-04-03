// Main App
export { AdminApp, default as App } from "./App";

// Router
export { createAdminRouter, Link, useNavigate, useParams } from "./router";

// Components
export * from "./components";

// API client
export * from "./lib/api";

// Utilities
export { cn } from "./lib/utils";

// Plugin admin context (for accessing plugin components)
export {
	PluginAdminProvider,
	usePluginAdmins,
	usePluginWidget,
	usePluginPage,
	usePluginField,
	usePluginHasPages,
	usePluginHasWidgets,
	type PluginAdminModule,
	type PluginAdmins,
} from "./lib/plugin-context";

// i18n
export { I18nProvider, useTranslation } from "./i18n/index.js";
export type { Translations, I18nProviderProps } from "./i18n/index.js";
