import cloudflare from "@astrojs/cloudflare";
import starlight from "@astrojs/starlight";
// @ts-check
import { defineConfig } from "astro/config";

// https://astro.build/config
export default defineConfig({
	site: "https://docs.emdashcms.com",
	integrations: [
		starlight({
			title: "EmDash",
			tagline: "The Astro-native CMS",
			logo: {
				light: "./src/assets/logo-light.svg",
				dark: "./src/assets/logo-dark.svg",
				replacesTitle: true,
			},
			social: [
				{
					icon: "github",
					label: "GitHub",
					href: "https://github.com/emdash-cms/emdash",
				},
			],
			editLink: {
				baseUrl: "https://github.com/emdash-cms/emdash/tree/main/docs",
			},
			customCss: ["./src/styles/custom.css"],
			sidebar: [
				{
					label: "Start Here",
					items: [
						{ label: "Introduction", slug: "introduction" },
						{ label: "Getting Started", slug: "getting-started" },
						{ label: "Why EmDash?", slug: "why-emdash" },
						{ label: "Docs MCP for AI Tools", slug: "docs-mcp" },
					],
				},
				{
					label: "Coming From...",
					items: [
						{
							label: "EmDash for WordPress Developers",
							slug: "coming-from/wordpress",
						},
						{
							label: "Astro for WordPress Developers",
							slug: "coming-from/astro-for-wp-devs",
						},
						{
							label: "EmDash for Astro Developers",
							slug: "coming-from/astro",
						},
					],
				},
				{
					label: "Guides",
					items: [
						{ label: "Create a Blog", slug: "guides/create-a-blog" },
						{
							label: "Working with Content",
							slug: "guides/working-with-content",
						},
						{ label: "Querying Content", slug: "guides/querying-content" },
						{ label: "Media Library", slug: "guides/media-library" },
						{ label: "Taxonomies", slug: "guides/taxonomies" },
						{ label: "Navigation Menus", slug: "guides/menus" },
						{ label: "Widget Areas", slug: "guides/widgets" },
						{ label: "Page Layouts", slug: "guides/page-layouts" },
						{ label: "Sections", slug: "guides/sections" },
						{ label: "Site Settings", slug: "guides/site-settings" },
						{ label: "Authentication", slug: "guides/authentication" },
						{ label: "Atmosphere Login", slug: "guides/atmosphere-auth" },
						{ label: "AI Tools", slug: "guides/ai-tools" },
						{ label: "x402 Payments", slug: "guides/x402-payments" },
						{ label: "Preview Mode", slug: "guides/preview" },
						{
							label: "Internationalization (i18n)",
							slug: "guides/internationalization",
						},
					],
				},
				{
					label: "Plugins",
					items: [
						{ label: "Plugin Overview", slug: "plugins/overview" },
						{ label: "Installing Plugins", slug: "plugins/installing" },
						{ label: "Field Kit", slug: "plugins/field-kit" },
					],
				},
				{
					label: "Creating Sandboxed Plugins",
					items: [
						{
							label: "Choosing a Plugin Format",
							slug: "plugins/creating-plugins/choosing-a-format",
						},
						{
							label: "Your First Plugin",
							slug: "plugins/creating-plugins/your-first-plugin",
						},
						{ label: "Hooks", slug: "plugins/creating-plugins/hooks" },
						{ label: "API Routes", slug: "plugins/creating-plugins/api-routes" },
						{ label: "Storage", slug: "plugins/creating-plugins/storage" },
						{ label: "Settings", slug: "plugins/creating-plugins/settings" },
						{ label: "Block Kit", slug: "plugins/creating-plugins/block-kit" },
						{
							label: "Capabilities & Security",
							slug: "plugins/creating-plugins/capabilities",
						},
						{
							label: "Bundling & Publishing",
							slug: "plugins/creating-plugins/publishing",
						},
					],
				},
				{
					label: "Creating Native Plugins",
					items: [
						{
							label: "Your First Native Plugin",
							slug: "plugins/creating-native-plugins/your-first-native-plugin",
						},
						{
							label: "React Admin Pages & Widgets",
							slug: "plugins/creating-native-plugins/react-admin",
						},
						{
							label: "Portable Text Components",
							slug: "plugins/creating-native-plugins/portable-text-components",
						},
						{
							label: "Page Fragments",
							slug: "plugins/creating-native-plugins/page-fragments",
						},
						{
							label: "Distributing Native Plugins",
							slug: "plugins/creating-native-plugins/distributing",
						},
					],
				},
				{
					label: "Contributing",
					collapsed: true,
					items: [
						{ label: "Contributor Guide", slug: "contributing" },
						{ label: "Translating EmDash", slug: "contributing/translating" },
					],
				},

				{
					label: "Themes",
					items: [
						{ label: "Themes Overview", slug: "themes/overview" },
						{
							label: "Creating Themes",
							slug: "themes/creating-themes",
						},
						{ label: "Seed File Format", slug: "themes/seed-files" },
						{
							label: "Porting WordPress Themes",
							slug: "themes/porting-wp-themes",
						},
					],
				},
				{
					label: "Migration",
					items: [
						{
							label: "Migrate from WordPress",
							slug: "migration/from-wordpress",
						},
						{ label: "Content Import", slug: "migration/content-import" },
						{
							label: "Porting WordPress Plugins",
							slug: "migration/porting-plugins",
						},
					],
				},
				{
					label: "Deployment",
					items: [
						{ label: "Deploy to Cloudflare", slug: "deployment/cloudflare" },
						{ label: "Deploy to Node.js", slug: "deployment/nodejs" },
						{ label: "Database Options", slug: "deployment/database" },
						{ label: "Storage Options", slug: "deployment/storage" },
					],
				},
				{
					label: "Concepts",
					collapsed: true,
					items: [
						{ label: "Architecture", slug: "concepts/architecture" },
						{ label: "Collections", slug: "concepts/collections" },
						{ label: "Content Model", slug: "concepts/content-model" },
						{ label: "The Admin Panel", slug: "concepts/admin-panel" },
					],
				},
				{
					label: "Reference",
					collapsed: true,
					items: [
						{ label: "Configuration", slug: "reference/configuration" },
						{ label: "CLI Commands", slug: "reference/cli" },
						{ label: "API Reference", slug: "reference/api" },
						{ label: "Field Types", slug: "reference/field-types" },
						{ label: "Hook Reference", slug: "reference/hooks" },
						{ label: "REST API", slug: "reference/rest-api" },
						{ label: "MCP Server", slug: "reference/mcp-server" },
					],
				},
			],
		}),
	],

	adapter: cloudflare(),
});
