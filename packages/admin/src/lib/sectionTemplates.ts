import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";

import type { PluginBlockDef } from "../components/PortableTextEditor";
import type { CreateSectionInput, Section } from "./api/sections";

/**
 * Section categories for organizing and filtering starter templates.
 */
export const SECTION_CATEGORIES: readonly {
	id: string;
	label: MessageDescriptor;
	icon: string;
}[] = [
	{ id: "layout", label: msg`Layout`, icon: "layout" },
	{ id: "content", label: msg`Content`, icon: "content" },
	{ id: "marketing", label: msg`Marketing`, icon: "marketing" },
	{ id: "media", label: msg`Media`, icon: "media" },
	{ id: "navigation", label: msg`Navigation`, icon: "navigation" },
	{ id: "social", label: msg`Social Proof`, icon: "social" },
];

export type SectionCategoryId =
	| "layout"
	| "content"
	| "marketing"
	| "media"
	| "navigation"
	| "social";

/**
 * Get a category by its ID.
 */
export function getCategoryById(id: string) {
	return SECTION_CATEGORIES.find((cat) => cat.id === id) ?? null;
}

export interface SectionStarterTemplate {
	id: string;
	slug: string;
	title: string;
	description: string;
	keywords: string[];
	content: unknown[];
	/** Category for grouping and filtering templates */
	category: SectionCategoryId;
}

export const SECTION_STARTER_TEMPLATES: SectionStarterTemplate[] = [
	{
		id: "starter-hero-cover",
		slug: "hero-cover",
		title: "Hero / Cover",
		description: "A full-width hero section with heading, intro copy, image, and optional CTA.",
		keywords: ["hero", "cover", "landing", "cta"],
		category: "layout",
		content: [
			{
				_type: "cover",
				_key: "starterHeroCover",
				heading: "Hero section",
				body: "Write a short intro or callout for this page.",
				minHeight: "360px",
				alignment: "center",
				overlayOpacity: 0.45,
				ctaText: "Learn more",
				ctaUrl: "/",
			},
		],
	},
	{
		id: "starter-cta",
		slug: "cta-section",
		title: "CTA Section",
		description: "A compact call-to-action section with copy and a styled button.",
		keywords: ["cta", "button", "conversion"],
		category: "marketing",
		content: [
			{
				_type: "block",
				_key: "starterCtaHeading",
				style: "h2",
				children: [
					{
						_type: "span",
						_key: "starterCtaHeadingText",
						text: "Ready to publish?",
						marks: [],
					},
				],
				markDefs: [],
			},
			{
				_type: "block",
				_key: "starterCtaBody",
				style: "normal",
				children: [
					{
						_type: "span",
						_key: "starterCtaBodyText",
						text: "Add a focused message and send readers to the next step.",
						marks: [],
					},
				],
				markDefs: [],
			},
			{
				_type: "button",
				_key: "starterCtaButton",
				text: "Get started",
				url: "/",
				style: "fill",
			},
		],
	},
	{
		id: "starter-pullquote",
		slug: "pullquote",
		title: "Pullquote",
		description: "A highlighted quote block for essays, posts, and editorial pages.",
		keywords: ["quote", "editorial", "highlight"],
		category: "content",
		content: [
			{
				_type: "pullquote",
				_key: "starterPullquote",
				text: "A strong quote or highlighted idea.",
				citation: "",
			},
		],
	},
	{
		id: "starter-accordion",
		slug: "accordion",
		title: "Accordion",
		description: "Collapsible content rows for FAQs and structured information.",
		keywords: ["faq", "accordion", "expand", "collapse", "questions"],
		category: "navigation",
		content: [
			{
				_type: "accordion",
				_key: "starterAccordion",
				items: [
					{
						_key: "starterAccordionItemOne",
						label: "What is EmDash?",
						body: "EmDash is a Cloudflare-native CMS built for modern web applications.",
						blocks: [
							{
								_type: "block",
								_key: "starterAccordionItemOneBody",
								style: "normal",
								children: [
									{
										_type: "span",
										_key: "starterAccordionItemOneText",
										text: "EmDash is a Cloudflare-native CMS built for modern web applications.",
										marks: [],
									},
								],
								markDefs: [],
							},
						],
					},
					{
						_key: "starterAccordionItemTwo",
						label: "How do I get started?",
						body: "Create a reusable section, edit its content, then insert it into a page or post.",
						blocks: [
							{
								_type: "block",
								_key: "starterAccordionItemTwoBody",
								style: "normal",
								children: [
									{
										_type: "span",
										_key: "starterAccordionItemTwoText",
										text: "Create a reusable section, edit its content, then insert it into a page or post.",
										marks: [],
									},
								],
								markDefs: [],
							},
						],
					},
				],
			},
		],
	},
	{
		id: "starter-alert",
		slug: "alert",
		title: "Alert / Notice",
		description: "An inline alert or notice for important messages, warnings, and updates.",
		keywords: ["alert", "notice", "warning", "error", "info"],
		category: "content",
		content: [
			{
				_type: "banner",
				_key: "starterAlert",
				variant: "alert",
				title: "Important notice",
				description: "This is an alert message for important information.",
			},
		],
	},
	{
		id: "starter-testimonial",
		slug: "testimonial-section",
		title: "Testimonial",
		description: "A testimonial section showcasing quotes and attribution.",
		keywords: ["testimonial", "quote", "review", "customer"],
		category: "social",
		content: [
			{
				_type: "testimonial",
				_key: "starterTestimonial",
				items: [
					{
						_key: "starterTestimonialItem",
						quote: "This product transformed how our team works.",
						author: "Jane Smith",
						title: "Engineering Manager",
						company: "Acme Corp",
						avatar: "",
					},
				],
			},
		],
	},
	{
		id: "starter-card",
		slug: "card",
		title: "Card",
		description: "A single card with image, title, description, and optional CTA.",
		keywords: ["card", "feature", "product", "showcase"],
		category: "content",
		content: [
			{
				_type: "card",
				_key: "starterCard",
				title: "Feature or product",
				description: "A short description for this card.",
				image: "",
				ctaText: "Learn more",
				ctaUrl: "/",
			},
		],
	},
	{
		id: "starter-card-grid",
		slug: "card-grid",
		title: "Card Grid",
		description: "A responsive grid of cards for features, products, or people.",
		keywords: ["card", "grid", "features", "products", "showcase"],
		category: "layout",
		content: [
			{
				_type: "cardGrid",
				_key: "starterCardGrid",
				title: "Featured items",
				description: "Use cards to compare or present related content.",
				columns: 3,
				items: [
					{
						_key: "starterCardGridItemOne",
						title: "First card",
						description: "A short description for the first card.",
						image: "",
						ctaText: "Learn more",
						ctaUrl: "/",
					},
					{
						_key: "starterCardGridItemTwo",
						title: "Second card",
						description: "A short description for the second card.",
						image: "",
						ctaText: "Learn more",
						ctaUrl: "/",
					},
					{
						_key: "starterCardGridItemThree",
						title: "Third card",
						description: "A short description for the third card.",
						image: "",
						ctaText: "Learn more",
						ctaUrl: "/",
					},
				],
			},
		],
	},
	{
		id: "starter-tabs",
		slug: "tabs",
		title: "Tabs",
		description: "Tabbed content panels for comparisons, details, and grouped information.",
		keywords: ["tabs", "panels", "comparison", "details"],
		category: "navigation",
		content: [
			{
				_type: "tab",
				_key: "starterTabs",
				default_tab: 0,
				panels: [
					{
						label: "Overview",
						body: "Introduce the main idea or summary in this panel.",
						blocks: [
							{
								_type: "block",
								_key: "starterTabsOverviewBody",
								style: "normal",
								children: [
									{
										_type: "span",
										_key: "starterTabsOverviewText",
										text: "Introduce the main idea or summary in this panel.",
										marks: [],
									},
								],
								markDefs: [],
							},
						],
					},
					{
						label: "Details",
						body: "Add supporting details, process notes, or comparison copy.",
						blocks: [
							{
								_type: "block",
								_key: "starterTabsDetailsBody",
								style: "normal",
								children: [
									{
										_type: "span",
										_key: "starterTabsDetailsText",
										text: "Add supporting details, process notes, or comparison copy.",
										marks: [],
									},
								],
								markDefs: [],
							},
						],
					},
				],
			},
		],
	},
	{
		id: "starter-stats",
		slug: "stats-counter",
		title: "Stats / Counter",
		description: "A compact metrics row for numbers, counters, and trend callouts.",
		keywords: ["stats", "counter", "metrics", "numbers", "kpi"],
		category: "marketing",
		content: [
			{
				_type: "stats",
				_key: "starterStats",
				items: [
					{
						label: "Projects",
						value: "128",
						description: "Published sections",
						trend: "up",
					},
					{
						label: "Latency",
						value: "42ms",
						description: "Median API response",
						trend: "down",
					},
					{
						label: "Uptime",
						value: "99.9%",
						description: "Last 30 days",
						trend: "neutral",
					},
				],
			},
		],
	},
	{
		id: "starter-feature-list",
		slug: "feature-list",
		title: "Feature List",
		description: "A list of features with icons, titles, and descriptions.",
		keywords: ["feature", "list", "icon", "features", "benefits"],
		category: "marketing",
		content: [
			{
				_type: "featureList",
				_key: "starterFeatureList",
				title: "Key features",
				description: "Everything you need to know about this product.",
				columns: 3,
				items: [
					{
						_key: "starterFeatureItemOne",
						icon: "lightning",
						title: "Fast setup",
						description: "Get started in minutes, not hours.",
						url: "",
					},
					{
						_key: "starterFeatureItemTwo",
						icon: "shield",
						title: "Secure by default",
						description: "Enterprise-grade security built in.",
						url: "",
					},
					{
						_key: "starterFeatureItemThree",
						icon: "users",
						title: "Team collaboration",
						description: "Work together seamlessly across teams.",
						url: "",
					},
				],
			},
		],
	},
	{
		id: "starter-logo-cloud",
		slug: "logo-cloud",
		title: "Logo Cloud",
		description: "A row of logos for partners, sponsors, or technologies.",
		keywords: ["logo", "cloud", "partners", "sponsors", "brands"],
		category: "social",
		content: [
			{
				_type: "logoCloud",
				_key: "starterLogoCloud",
				title: "Trusted by leading companies",
				items: [
					{
						_key: "starterLogoOne",
						name: "Company One",
						logoUrl: "",
						url: "",
					},
					{
						_key: "starterLogoTwo",
						name: "Company Two",
						logoUrl: "",
						url: "",
					},
					{
						_key: "starterLogoThree",
						name: "Company Three",
						logoUrl: "",
						url: "",
					},
				],
			},
		],
	},
	{
		id: "starter-steps",
		slug: "steps-timeline",
		title: "Steps / Timeline",
		description: "A numbered timeline or step-by-step process.",
		keywords: ["steps", "timeline", "process", "numbered", "guide"],
		category: "content",
		content: [
			{
				_type: "steps",
				_key: "starterSteps",
				title: "How it works",
				items: [
					{
						_key: "starterStepOne",
						icon: "lightning",
						title: "Sign up",
						description: "Create your free account in seconds.",
					},
					{
						_key: "starterStepTwo",
						icon: "gear",
						title: "Configure",
						description: "Set up your workspace and preferences.",
					},
					{
						_key: "starterStepThree",
						icon: "check",
						title: "Launch",
						description: "Go live and start seeing results.",
					},
				],
			},
		],
	},
	{
		id: "starter-faq",
		slug: "faq",
		title: "FAQ",
		description: "Frequently asked questions with expandable answers.",
		keywords: ["faq", "questions", "answers", "help", "support"],
		category: "navigation",
		content: [
			{
				_type: "faq",
				_key: "starterFaq",
				items: [
					{
						_key: "starterFaqOne",
						question: "What is EmDash?",
						answer: "EmDash is a Cloudflare-native CMS built for modern web applications.",
					},
					{
						_key: "starterFaqTwo",
						question: "How do I get started?",
						answer:
							"Create a reusable section, edit its content, then insert it into a page or post.",
					},
				],
			},
		],
	},
	{
		id: "starter-video-embed",
		slug: "video-embed",
		title: "Video Embed",
		description: "Embed a video from YouTube, Vimeo, or any other provider.",
		keywords: ["video", "embed", "youtube", "vimeo", "media"],
		category: "media",
		content: [
			{
				_type: "videoEmbed",
				_key: "starterVideoEmbed",
				title: "Introduction Video",
				provider: "youtube",
				embedUrl: "https://www.youtube.com/embed/dQw4w9WgXcQ",
				caption: "Watch our introduction video to learn more.",
			},
		],
	},
	{
		id: "starter-pricing-table",
		slug: "pricing-table",
		title: "Pricing Table",
		description: "A comparison table for pricing tiers with features and CTAs.",
		keywords: ["pricing", "table", "tier", "plan", "comparison", "subscription"],
		category: "marketing",
		content: [
			{
				_type: "pricingTable",
				_key: "starterPricingTable",
				title: "Simple, transparent pricing",
				description: "Choose the plan that fits your needs. All plans include a 14-day free trial.",
				columns: 3,
				highlightedTier: 1,
				items: [
					{
						_key: "starterPricingStarter",
						name: "Starter",
						price: "29",
						period: "month",
						description: "Perfect for individuals and small projects.",
						features: "5 pages\n1GB storage\nEmail support\nBasic analytics",
						ctaText: "Get started",
						ctaUrl: "/signup",
						featured: false,
					},
					{
						_key: "starterPricingPro",
						name: "Pro",
						price: "79",
						period: "month",
						description: "Best for growing teams and businesses.",
						features:
							"Unlimited pages\n50GB storage\nPriority support\nAdvanced analytics\nCustom domain\nAPI access",
						ctaText: "Start free trial",
						ctaUrl: "/signup?plan=pro",
						featured: true,
					},
					{
						_key: "starterPricingEnterprise",
						name: "Enterprise",
						price: "199",
						period: "month",
						description: "For large organizations with custom needs.",
						features:
							"Everything in Pro\nUnlimited storage\n24/7 support\nSSO & SAML\nCustom integrations\nDedicated account manager",
						ctaText: "Contact sales",
						ctaUrl: "/contact",
						featured: false,
					},
				],
			},
		],
	},
	{
		id: "starter-cta-banner",
		slug: "cta-banner",
		title: "CTA Banner",
		description: "A full-width call-to-action banner with heading and button.",
		keywords: ["cta", "banner", "call to action", "conversion", "promotion"],
		category: "marketing",
		content: [
			{
				_type: "ctaBanner",
				_key: "starterCtaBanner",
				title: "Ready to get started?",
				description: "Join thousands of teams using our platform to build better products.",
				backgroundColor: "brand",
				buttonText: "Start for free",
				buttonUrl: "/signup",
				buttonStyle: "fill",
				alignment: "center",
			},
		],
	},
];

export const SECTION_TEMPLATE_PLUGIN_BLOCKS: PluginBlockDef[] = [
	{
		type: "cover",
		pluginId: "emdash-sections",
		label: "Hero / Cover",
		icon: "link-external",
		category: "Sections",
		description: "Visual hero section content",
		insertable: false,
		fields: [
			{
				type: "text_input",
				action_id: "heading",
				label: "Heading",
				initial_value: "Hero section",
			},
			{
				type: "text_input",
				action_id: "body",
				label: "Body",
				multiline: true,
				initial_value: "Write a short intro or callout for this page.",
			},
			{
				type: "media_picker",
				action_id: "backgroundImage",
				label: "Background image",
				mime_type_filter: "image/",
				placeholder: "Select or upload an image",
			},
			{
				type: "text_input",
				action_id: "minHeight",
				label: "Height",
				initial_value: "360px",
				placeholder: "360px",
			},
			{
				type: "select",
				action_id: "alignment",
				label: "Alignment",
				initial_value: "center",
				options: [
					{ label: "Left", value: "left" },
					{ label: "Center", value: "center" },
					{ label: "Right", value: "right" },
				],
			},
			{
				type: "number_input",
				action_id: "overlayOpacity",
				label: "Overlay opacity",
				initial_value: 0.45,
				min: 0,
				max: 1,
			},
			{
				type: "text_input",
				action_id: "ctaText",
				label: "Button text",
				placeholder: "Optional",
			},
			{
				type: "text_input",
				action_id: "ctaUrl",
				label: "Button URL",
				placeholder: "/about",
			},
		],
	},
	{
		type: "button",
		pluginId: "emdash-sections",
		label: "Button",
		icon: "link",
		category: "Sections",
		description: "Styled call-to-action button",
		insertable: false,
		fields: [
			{
				type: "text_input",
				action_id: "text",
				label: "Text",
				initial_value: "Learn more",
			},
			{
				type: "text_input",
				action_id: "url",
				label: "URL",
				placeholder: "/about",
			},
			{
				type: "select",
				action_id: "style",
				label: "Style",
				initial_value: "fill",
				options: [
					{ label: "Fill", value: "fill" },
					{ label: "Outline", value: "outline" },
					{ label: "Default", value: "default" },
				],
			},
		],
	},
	{
		type: "pullquote",
		pluginId: "emdash-sections",
		label: "Pullquote",
		icon: "code",
		category: "Sections",
		description: "Highlighted editorial quote",
		insertable: false,
		fields: [
			{
				type: "text_input",
				action_id: "text",
				label: "Quote",
				multiline: true,
				initial_value: "A strong quote or highlighted idea.",
			},
			{
				type: "text_input",
				action_id: "citation",
				label: "Citation",
				placeholder: "Optional",
			},
		],
	},
	{
		type: "accordion",
		pluginId: "emdash-sections",
		label: "Accordion",
		icon: "list",
		category: "Sections",
		description: "Collapsible content rows for FAQs",
		insertable: false,
		fields: [
			{
				type: "repeater",
				action_id: "items",
				label: "Accordion items",
				item_label: "Accordion item",
				fields: [
					{
						type: "text_input",
						action_id: "label",
						label: "Item label",
						initial_value: "New question",
					},
					{
						type: "text_input",
						action_id: "body",
						label: "Item body",
						multiline: true,
						initial_value: "Add the answer or expanded content.",
					},
				],
				min_items: 1,
				max_items: 20,
				initial_value: [
					{
						label: "What is EmDash?",
						body: "EmDash is a Cloudflare-native CMS built for modern web applications.",
					},
					{
						label: "How do I get started?",
						body: "Create a reusable section, edit its content, then insert it into a page or post.",
					},
				],
			},
		],
	},
	{
		type: "banner",
		pluginId: "emdash-sections",
		label: "Alert / Notice",
		icon: "warning",
		category: "Sections",
		description: "Inline alert or notice for important messages",
		insertable: false,
		fields: [
			{
				type: "select",
				action_id: "variant",
				label: "Variant",
				initial_value: "alert",
				options: [
					{ label: "Info", value: "default" },
					{ label: "Warning", value: "alert" },
					{ label: "Error", value: "error" },
				],
			},
			{
				type: "text_input",
				action_id: "title",
				label: "Title",
				initial_value: "Important notice",
			},
			{
				type: "text_input",
				action_id: "description",
				label: "Description",
				multiline: true,
				initial_value: "This is an alert message for important information.",
			},
		],
	},
	{
		type: "testimonial",
		pluginId: "emdash-sections",
		label: "Testimonial",
		icon: "quote",
		category: "Sections",
		description: "Testimonials with quote and attribution",
		insertable: false,
		fields: [
			{
				type: "repeater",
				action_id: "items",
				label: "Testimonials",
				item_label: "Testimonial",
				fields: [
					{
						type: "text_input",
						action_id: "quote",
						label: "Quote",
						multiline: true,
						initial_value: "This product transformed how our team works.",
					},
					{
						type: "text_input",
						action_id: "author",
						label: "Author name",
						initial_value: "Jane Smith",
					},
					{
						type: "text_input",
						action_id: "title",
						label: "Title",
						initial_value: "Engineering Manager",
					},
					{
						type: "text_input",
						action_id: "company",
						label: "Company",
						initial_value: "Acme Corp",
					},
					{
						type: "text_input",
						action_id: "avatar",
						label: "Avatar URL",
						placeholder: "https://example.com/avatar.jpg",
					},
				],
				min_items: 1,
				max_items: 6,
				initial_value: [
					{
						quote: "This product transformed how our team works.",
						author: "Jane Smith",
						title: "Engineering Manager",
						company: "Acme Corp",
						avatar: "",
					},
				],
			},
		],
	},
	{
		type: "card",
		pluginId: "emdash-sections",
		label: "Card",
		icon: "cube",
		category: "Sections",
		description: "Single card with image, text, and optional CTA",
		insertable: false,
		fields: [
			{
				type: "text_input",
				action_id: "title",
				label: "Title",
				initial_value: "Feature or product",
			},
			{
				type: "text_input",
				action_id: "description",
				label: "Description",
				multiline: true,
				initial_value: "A short description for this card.",
			},
			{
				type: "media_picker",
				action_id: "image",
				label: "Image",
				mime_type_filter: "image/",
				placeholder: "Select or upload an image",
			},
			{
				type: "text_input",
				action_id: "ctaText",
				label: "Button text",
				placeholder: "Optional",
			},
			{
				type: "text_input",
				action_id: "ctaUrl",
				label: "Button URL",
				placeholder: "/about",
			},
		],
	},
	{
		type: "cardGrid",
		pluginId: "emdash-sections",
		label: "Card Grid",
		icon: "list",
		category: "Sections",
		description: "Responsive grid of repeatable cards",
		insertable: false,
		fields: [
			{
				type: "text_input",
				action_id: "title",
				label: "Title",
				initial_value: "Featured items",
			},
			{
				type: "text_input",
				action_id: "description",
				label: "Description",
				multiline: true,
				initial_value: "Use cards to compare or present related content.",
			},
			{
				type: "select",
				action_id: "columns",
				label: "Columns",
				initial_value: "3",
				options: [
					{ label: "2 columns", value: "2" },
					{ label: "3 columns", value: "3" },
					{ label: "4 columns", value: "4" },
				],
			},
			{
				type: "repeater",
				action_id: "items",
				label: "Cards",
				item_label: "Card",
				fields: [
					{
						type: "text_input",
						action_id: "title",
						label: "Title",
						initial_value: "Card title",
					},
					{
						type: "text_input",
						action_id: "description",
						label: "Description",
						multiline: true,
						initial_value: "A short description for this card.",
					},
					{
						type: "text_input",
						action_id: "image",
						label: "Image URL",
						placeholder: "https://example.com/image.jpg",
					},
					{
						type: "text_input",
						action_id: "ctaText",
						label: "Button text",
						placeholder: "Optional",
					},
					{
						type: "text_input",
						action_id: "ctaUrl",
						label: "Button URL",
						placeholder: "/about",
					},
				],
				min_items: 1,
				max_items: 12,
				initial_value: [
					{
						title: "First card",
						description: "A short description for the first card.",
						image: "",
						ctaText: "Learn more",
						ctaUrl: "/",
					},
					{
						title: "Second card",
						description: "A short description for the second card.",
						image: "",
						ctaText: "Learn more",
						ctaUrl: "/",
					},
					{
						title: "Third card",
						description: "A short description for the third card.",
						image: "",
						ctaText: "Learn more",
						ctaUrl: "/",
					},
				],
			},
		],
	},
	{
		type: "tab",
		pluginId: "emdash-sections",
		label: "Tabs",
		icon: "list",
		category: "Sections",
		description: "Tabbed panels for grouped section content",
		insertable: false,
		fields: [
			{
				type: "number_input",
				action_id: "default_tab",
				label: "Default tab",
				initial_value: 0,
				min: 0,
				max: 10,
			},
			{
				type: "repeater",
				action_id: "panels",
				label: "Panels",
				item_label: "Panel",
				fields: [
					{
						type: "text_input",
						action_id: "label",
						label: "Label",
						initial_value: "Panel",
					},
					{
						type: "text_input",
						action_id: "body",
						label: "Body",
						multiline: true,
						initial_value: "Add panel content.",
					},
				],
				min_items: 1,
				max_items: 8,
				initial_value: [
					{
						label: "Overview",
						body: "Introduce the main idea or summary in this panel.",
					},
					{
						label: "Details",
						body: "Add supporting details, process notes, or comparison copy.",
					},
				],
			},
		],
	},
	{
		type: "stats",
		pluginId: "emdash-sections",
		label: "Stats / Counter",
		icon: "list",
		category: "Sections",
		description: "Metrics, counters, and trend callouts",
		insertable: false,
		fields: [
			{
				type: "repeater",
				action_id: "items",
				label: "Stats",
				item_label: "Stat",
				fields: [
					{
						type: "text_input",
						action_id: "label",
						label: "Label",
						initial_value: "Metric",
					},
					{
						type: "text_input",
						action_id: "value",
						label: "Value",
						initial_value: "100",
					},
					{
						type: "text_input",
						action_id: "description",
						label: "Description",
						initial_value: "Supporting detail",
					},
					{
						type: "select",
						action_id: "trend",
						label: "Trend",
						initial_value: "neutral",
						options: [
							{ label: "Up", value: "up" },
							{ label: "Down", value: "down" },
							{ label: "Neutral", value: "neutral" },
						],
					},
				],
				min_items: 1,
				max_items: 8,
				initial_value: [
					{
						label: "Projects",
						value: "128",
						description: "Published sections",
						trend: "up",
					},
					{
						label: "Latency",
						value: "42ms",
						description: "Median API response",
						trend: "down",
					},
					{
						label: "Uptime",
						value: "99.9%",
						description: "Last 30 days",
						trend: "neutral",
					},
				],
			},
		],
	},
	{
		type: "featureList",
		pluginId: "emdash-sections",
		label: "Feature List",
		icon: "list",
		category: "Sections",
		description: "Features with icons, titles, and descriptions",
		insertable: false,
		fields: [
			{
				type: "text_input",
				action_id: "title",
				label: "Title",
				initial_value: "Key features",
			},
			{
				type: "text_input",
				action_id: "description",
				label: "Description",
				multiline: true,
				initial_value: "Everything you need to know about this product.",
			},
			{
				type: "select",
				action_id: "columns",
				label: "Columns",
				initial_value: "3",
				options: [
					{ label: "2 columns", value: "2" },
					{ label: "3 columns", value: "3" },
					{ label: "4 columns", value: "4" },
				],
			},
			{
				type: "repeater",
				action_id: "items",
				label: "Features",
				item_label: "Feature",
				fields: [
					{
						type: "select",
						action_id: "icon",
						label: "Icon",
						initial_value: "star",
						options: [
							{ label: "Star", value: "star" },
							{ label: "Check", value: "check" },
							{ label: "Lightning", value: "lightning" },
							{ label: "Gear", value: "gear" },
							{ label: "Users", value: "users" },
							{ label: "Clock", value: "clock" },
							{ label: "Bell", value: "bell" },
							{ label: "Shield", value: "shield" },
							{ label: "Chart", value: "chart" },
							{ label: "Heart", value: "heart" },
							{ label: "Flag", value: "flag" },
							{ label: "Target", value: "target" },
							{ label: "Key", value: "key" },
							{ label: "Lock", value: "lock" },
							{ label: "Globe", value: "globe" },
						],
					},
					{
						type: "text_input",
						action_id: "title",
						label: "Title",
						initial_value: "Feature title",
					},
					{
						type: "text_input",
						action_id: "description",
						label: "Description",
						multiline: true,
						initial_value: "A short description for this feature.",
					},
					{
						type: "text_input",
						action_id: "url",
						label: "URL",
						placeholder: "Optional",
					},
				],
				min_items: 1,
				max_items: 12,
				initial_value: [
					{
						icon: "lightning",
						title: "Fast setup",
						description: "Get started in minutes, not hours.",
						url: "",
					},
					{
						icon: "shield",
						title: "Secure by default",
						description: "Enterprise-grade security built in.",
						url: "",
					},
					{
						icon: "users",
						title: "Team collaboration",
						description: "Work together seamlessly across teams.",
						url: "",
					},
				],
			},
		],
	},
	{
		type: "logoCloud",
		pluginId: "emdash-sections",
		label: "Logo Cloud",
		icon: "globe",
		category: "Sections",
		description: "Row of logos for partners or sponsors",
		insertable: false,
		fields: [
			{
				type: "text_input",
				action_id: "title",
				label: "Title",
				initial_value: "Trusted by leading companies",
			},
			{
				type: "repeater",
				action_id: "items",
				label: "Logos",
				item_label: "Logo",
				fields: [
					{
						type: "text_input",
						action_id: "name",
						label: "Company name",
						initial_value: "Company name",
					},
					{
						type: "text_input",
						action_id: "logoUrl",
						label: "Logo URL",
						placeholder: "https://example.com/logo.png",
					},
					{
						type: "text_input",
						action_id: "url",
						label: "Link URL",
						placeholder: "https://example.com (optional)",
					},
				],
				min_items: 1,
				max_items: 20,
				initial_value: [
					{ name: "Company One", logoUrl: "", url: "" },
					{ name: "Company Two", logoUrl: "", url: "" },
					{ name: "Company Three", logoUrl: "", url: "" },
				],
			},
		],
	},
	{
		type: "steps",
		pluginId: "emdash-sections",
		label: "Steps / Timeline",
		icon: "list",
		category: "Sections",
		description: "Numbered timeline or step-by-step process",
		insertable: false,
		fields: [
			{
				type: "text_input",
				action_id: "title",
				label: "Title",
				initial_value: "How it works",
			},
			{
				type: "repeater",
				action_id: "items",
				label: "Steps",
				item_label: "Step",
				fields: [
					{
						type: "select",
						action_id: "icon",
						label: "Icon",
						initial_value: "lightning",
						options: [
							{ label: "Star", value: "star" },
							{ label: "Check", value: "check" },
							{ label: "Lightning", value: "lightning" },
							{ label: "Gear", value: "gear" },
							{ label: "Users", value: "users" },
							{ label: "Clock", value: "clock" },
							{ label: "Bell", value: "bell" },
							{ label: "Shield", value: "shield" },
							{ label: "Chart", value: "chart" },
							{ label: "Heart", value: "heart" },
							{ label: "Flag", value: "flag" },
							{ label: "Target", value: "target" },
							{ label: "Key", value: "key" },
							{ label: "Lock", value: "lock" },
							{ label: "Globe", value: "globe" },
						],
					},
					{
						type: "text_input",
						action_id: "title",
						label: "Title",
						initial_value: "Step title",
					},
					{
						type: "text_input",
						action_id: "description",
						label: "Description",
						multiline: true,
						initial_value: "A short description for this step.",
					},
				],
				min_items: 1,
				max_items: 10,
				initial_value: [
					{
						icon: "lightning",
						title: "Sign up",
						description: "Create your free account in seconds.",
					},
					{
						icon: "gear",
						title: "Configure",
						description: "Set up your workspace and preferences.",
					},
					{ icon: "check", title: "Launch", description: "Go live and start seeing results." },
				],
			},
		],
	},
	{
		type: "faq",
		pluginId: "emdash-sections",
		label: "FAQ",
		icon: "list",
		category: "Sections",
		description: "Frequently asked questions with expandable answers",
		insertable: false,
		fields: [
			{
				type: "repeater",
				action_id: "items",
				label: "FAQ items",
				item_label: "FAQ item",
				fields: [
					{
						type: "text_input",
						action_id: "question",
						label: "Question",
						initial_value: "New question",
					},
					{
						type: "text_input",
						action_id: "answer",
						label: "Answer",
						multiline: true,
						initial_value: "Add the answer here.",
					},
				],
				min_items: 1,
				max_items: 20,
				initial_value: [
					{
						question: "What is EmDash?",
						answer: "EmDash is a Cloudflare-native CMS built for modern web applications.",
					},
					{
						question: "How do I get started?",
						answer:
							"Create a reusable section, edit its content, then insert it into a page or post.",
					},
				],
			},
		],
	},
	{
		type: "videoEmbed",
		pluginId: "emdash-sections",
		label: "Video Embed",
		icon: "globe",
		category: "Sections",
		description: "Embed a video from YouTube, Vimeo, or any other provider",
		insertable: false,
		fields: [
			{
				type: "text_input",
				action_id: "title",
				label: "Title",
				initial_value: "Introduction Video",
			},
			{
				type: "select",
				action_id: "provider",
				label: "Provider",
				initial_value: "youtube",
				options: [
					{ label: "YouTube", value: "youtube" },
					{ label: "Vimeo", value: "vimeo" },
					{ label: "Custom", value: "custom" },
				],
			},
			{
				type: "text_input",
				action_id: "embedUrl",
				label: "Embed URL",
				initial_value: "https://www.youtube.com/embed/dQw4w9WgXcQ",
			},
			{
				type: "text_input",
				action_id: "caption",
				label: "Caption",
				placeholder: "Optional video caption",
			},
		],
	},
	{
		type: "pricingTable",
		pluginId: "emdash-sections",
		label: "Pricing Table",
		icon: "list",
		category: "Sections",
		description: "Comparison table for pricing tiers with features and CTAs",
		insertable: false,
		fields: [
			{
				type: "text_input",
				action_id: "title",
				label: "Title",
				initial_value: "Simple, transparent pricing",
			},
			{
				type: "text_input",
				action_id: "description",
				label: "Description",
				multiline: true,
				initial_value:
					"Choose the plan that fits your needs. All plans include a 14-day free trial.",
			},
			{
				type: "select",
				action_id: "columns",
				label: "Columns",
				initial_value: "3",
				options: [
					{ label: "2 columns", value: "2" },
					{ label: "3 columns", value: "3" },
					{ label: "4 columns", value: "4" },
				],
			},
			{
				type: "number_input",
				action_id: "highlightedTier",
				label: "Highlighted tier (0-indexed)",
				initial_value: 1,
				min: 0,
				max: 10,
			},
			{
				type: "repeater",
				action_id: "items",
				label: "Pricing tiers",
				item_label: "Tier",
				fields: [
					{
						type: "text_input",
						action_id: "name",
						label: "Tier name",
						initial_value: "Plan name",
					},
					{
						type: "text_input",
						action_id: "price",
						label: "Price",
						initial_value: "99",
					},
					{
						type: "select",
						action_id: "period",
						label: "Period",
						initial_value: "month",
						options: [
							{ label: "Monthly", value: "month" },
							{ label: "Yearly", value: "year" },
							{ label: "One-time", value: "once" },
						],
					},
					{
						type: "text_input",
						action_id: "description",
						label: "Description",
						multiline: true,
						initial_value: "Perfect for your needs.",
					},
					{
						type: "text_input",
						action_id: "features",
						label: "Features (comma-separated)",
						multiline: true,
						initial_value: "Feature 1\nFeature 2\nFeature 3",
					},
					{
						type: "text_input",
						action_id: "ctaText",
						label: "Button text",
						initial_value: "Get started",
					},
					{
						type: "text_input",
						action_id: "ctaUrl",
						label: "Button URL",
						placeholder: "/signup",
					},
					{
						type: "select",
						action_id: "featured",
						label: "Featured tier",
						initial_value: "false",
						options: [
							{ label: "No", value: "false" },
							{ label: "Yes", value: "true" },
						],
					},
				],
				min_items: 1,
				max_items: 4,
				initial_value: [
					{
						name: "Starter",
						price: "29",
						period: "month",
						description: "Perfect for individuals and small projects.",
						features: "5 pages\n1GB storage\nEmail support",
						ctaText: "Get started",
						ctaUrl: "/signup",
						featured: "false",
					},
					{
						name: "Pro",
						price: "79",
						period: "month",
						description: "Best for growing teams and businesses.",
						features: "Unlimited pages\n50GB storage\nPriority support\nAPI access",
						ctaText: "Start free trial",
						ctaUrl: "/signup?plan=pro",
						featured: "true",
					},
					{
						name: "Enterprise",
						price: "199",
						period: "month",
						description: "For large organizations with custom needs.",
						features: "Everything in Pro\nUnlimited storage\n24/7 support\nCustom integrations",
						ctaText: "Contact sales",
						ctaUrl: "/contact",
						featured: "false",
					},
				],
			},
		],
	},
	{
		type: "ctaBanner",
		pluginId: "emdash-sections",
		label: "CTA Banner",
		icon: "megaphone",
		category: "Sections",
		description: "Full-width call-to-action banner with heading and button",
		insertable: false,
		fields: [
			{
				type: "text_input",
				action_id: "title",
				label: "Title",
				initial_value: "Ready to get started?",
			},
			{
				type: "text_input",
				action_id: "description",
				label: "Description",
				multiline: true,
				initial_value: "Join thousands of teams using our platform to build better products.",
			},
			{
				type: "select",
				action_id: "backgroundColor",
				label: "Background color",
				initial_value: "brand",
				options: [
					{ label: "Brand", value: "brand" },
					{ label: "Dark", value: "dark" },
					{ label: "Light", value: "light" },
					{ label: "Gradient", value: "gradient" },
				],
			},
			{
				type: "select",
				action_id: "alignment",
				label: "Alignment",
				initial_value: "center",
				options: [
					{ label: "Left", value: "left" },
					{ label: "Center", value: "center" },
					{ label: "Right", value: "right" },
				],
			},
			{
				type: "text_input",
				action_id: "buttonText",
				label: "Button text",
				initial_value: "Start for free",
			},
			{
				type: "text_input",
				action_id: "buttonUrl",
				label: "Button URL",
				placeholder: "/signup",
			},
			{
				type: "select",
				action_id: "buttonStyle",
				label: "Button style",
				initial_value: "fill",
				options: [
					{ label: "Fill", value: "fill" },
					{ label: "Outline", value: "outline" },
					{ label: "Ghost", value: "ghost" },
				],
			},
		],
	},
];

function cloneContent(content: unknown[]): unknown[] {
	return JSON.parse(JSON.stringify(content)) as unknown[];
}

export function templateToCreateInput(template: SectionStarterTemplate): CreateSectionInput {
	return {
		slug: template.slug,
		title: template.title,
		description: template.description,
		keywords: [...template.keywords],
		content: cloneContent(template.content),
	};
}

export function templateToSection(template: SectionStarterTemplate): Section {
	return {
		id: template.id,
		slug: template.slug,
		title: template.title,
		description: template.description,
		keywords: [...template.keywords],
		content: cloneContent(template.content),
		source: "theme",
		category: template.category,
		createdAt: "",
		updatedAt: "",
	};
}

export function matchesSectionTemplate(template: SectionStarterTemplate, query: string): boolean {
	const normalized = query.trim().toLowerCase();
	if (!normalized) return true;
	const haystack = [template.title, template.description, ...template.keywords]
		.filter(Boolean)
		.join(" ")
		.toLowerCase();
	return haystack.includes(normalized);
}

// =============================================================================
// Schema-Constrained Section Draft Helper
// Ready for future AI-backed provider - currently deterministic/rule-based
// =============================================================================

/**
 * Intent-to-template mapping for schema-constrained section drafting.
 * Maps common user intents to registered section templates.
 *
 * This is intentionally deterministic and rule-based, providing a foundation
 * for future AI-assisted drafting. The interface is designed to be compatible
 * with an AI provider that would return structured suggestions.
 */
interface IntentMapping {
	/** Keywords that trigger this mapping */
	keywords: string[];
	/** Template ID to suggest */
	templateId: string;
	/** Confidence level for AI integration */
	confidence: "high" | "medium" | "low";
}

const INTENT_MAPPINGS: IntentMapping[] = [
	// Hero / Cover
	{
		keywords: ["hero", "cover", "landing", "banner", "header", "intro", "welcome", "jumbotron"],
		templateId: "starter-hero-cover",
		confidence: "high",
	},
	// CTA Section
	{
		keywords: [
			"cta",
			"call to action",
			"conversion",
			"button",
			"get started",
			"signup",
			"subscribe",
		],
		templateId: "starter-cta",
		confidence: "high",
	},
	// CTA Banner
	{
		keywords: [
			"cta banner",
			"promotion",
			"marketing banner",
			"full width cta",
			"promotional banner",
			"ad banner",
		],
		templateId: "starter-cta-banner",
		confidence: "high",
	},
	// Pullquote
	{
		keywords: ["quote", "pullquote", "highlight", "editorial", "blockquote", "testimonial single"],
		templateId: "starter-pullquote",
		confidence: "high",
	},
	// Accordion
	{
		keywords: ["accordion", "expandable", "collapsible", "faq accordion", "expand", "collapse"],
		templateId: "starter-accordion",
		confidence: "high",
	},
	// Alert / Notice
	{
		keywords: ["alert", "notice", "warning", "info", "message", "banner alert", "notification"],
		templateId: "starter-alert",
		confidence: "high",
	},
	// Testimonial
	{
		keywords: [
			"testimonial",
			"testimonials",
			"review",
			"reviews",
			"quote social",
			"customer review",
		],
		templateId: "starter-testimonial",
		confidence: "high",
	},
	// Card
	{
		keywords: ["card", "single card", "product card", "feature card", "item card"],
		templateId: "starter-card",
		confidence: "high",
	},
	// Card Grid
	{
		keywords: [
			"card grid",
			"cards",
			"features grid",
			"products",
			"showcase",
			"grid layout",
			"cards layout",
		],
		templateId: "starter-card-grid",
		confidence: "high",
	},
	// Tabs
	{
		keywords: [
			"tabs",
			"tabbed",
			"panels",
			"tab panels",
			"comparison tabs",
			"comparison",
			"tabbed content",
		],
		templateId: "starter-tabs",
		confidence: "high",
	},
	// Stats / Counter
	{
		keywords: [
			"stats",
			"stats counter",
			"metrics",
			"numbers",
			"kpi",
			"counter",
			"statistics",
			"data",
		],
		templateId: "starter-stats",
		confidence: "high",
	},
	// Feature List
	{
		keywords: [
			"feature list",
			"features",
			"benefits",
			"icons features",
			"feature grid",
			"capabilities",
		],
		templateId: "starter-feature-list",
		confidence: "high",
	},
	// Logo Cloud
	{
		keywords: ["logo cloud", "logos", "partners", "sponsors", "brands", "companies", "clients"],
		templateId: "starter-logo-cloud",
		confidence: "high",
	},
	// Steps / Timeline
	{
		keywords: ["steps", "step by step", "timeline", "process", "guide", "how to", "workflow"],
		templateId: "starter-steps",
		confidence: "high",
	},
	// FAQ
	{
		keywords: ["faq", "faqs", "questions", "help", "support", "q&a", "knowledge base"],
		templateId: "starter-faq",
		confidence: "high",
	},
	// Video Embed
	{
		keywords: ["video", "youtube", "vimeo", "embed", "media", "tutorial", "video player"],
		templateId: "starter-video-embed",
		confidence: "high",
	},
	// Pricing Table
	{
		keywords: [
			"pricing",
			"price",
			"plans",
			"tier",
			"subscription",
			"comparison table",
			"cost",
			"billing",
		],
		templateId: "starter-pricing-table",
		confidence: "high",
	},
];

/**
 * Scoring weights for intent matching.
 * Higher weights = more important for matching.
 */
const SCORING_WEIGHTS = {
	/** Exact keyword match (case-insensitive) */
	EXACT_KEYWORD: 10,
	/** Intent starts with keyword (prefix match) */
	PREFIX_MATCH: 8,
	/** Intent contains keyword as substring */
	SUBSTRING_MATCH: 5,
	/** Template title word matches intent word */
	TITLE_WORD_MATCH: 3,
	/** Template description contains intent word */
	DESCRIPTION_MATCH: 2,
	/** Template keyword matches intent word */
	KEYWORD_MATCH: 4,
	/** Multi-word phrase matches (bonus) */
	PHRASE_MATCH_BONUS: 5,
	/** Number of matching words (per word bonus) */
	MATCHED_WORDS_BONUS: 1,
} as const;

/**
 * Score result for a template match.
 */
interface TemplateScore {
	template: SectionStarterTemplate;
	score: number;
	confidence: "high" | "medium" | "low" | "none";
	matchedWords: string[];
	matchType: "exact" | "fuzzy" | "partial";
}

/**
 * Normalize text for comparison (lowercase, trim, collapse whitespace).
 */
function normalizeText(text: string): string {
	return text.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Tokenize text into words (removing punctuation).
 */
function tokenize(text: string): string[] {
	return text.toLowerCase().split(/\s+/).filter(Boolean);
}

/**
 * Check if haystack contains needle as a phrase (consecutive words).
 */
function containsPhrase(haystack: string, phrase: string): boolean {
	return haystack.includes(phrase.toLowerCase());
}

/**
 * Calculate weighted score for intent matching against a template.
 */
function scoreTemplateAgainstIntent(
	template: SectionStarterTemplate,
	normalizedIntent: string,
): TemplateScore {
	let score = 0;
	const matchedWords: Set<string> = new Set();
	let matchType: "exact" | "fuzzy" | "partial" = "partial";
	const intentWords = tokenize(normalizedIntent);
	const intentTokens = new Set(intentWords);

	// 1. Check INTENT_MAPPINGS keywords (highest priority)
	for (const mapping of INTENT_MAPPINGS) {
		if (mapping.templateId !== template.id) continue;

		for (const keyword of mapping.keywords) {
			// Exact phrase match
			if (normalizedIntent === keyword) {
				score += SCORING_WEIGHTS.EXACT_KEYWORD * 2; // Double weight for exact match
				matchedWords.add(keyword);
				matchType = "exact";
			}
			// Prefix match (intent starts with keyword)
			else if (normalizedIntent.startsWith(keyword) || keyword.startsWith(normalizedIntent)) {
				score += SCORING_WEIGHTS.PREFIX_MATCH;
				matchedWords.add(keyword);
				matchType = "exact";
			}
			// Substring/phrase match
			else if (containsPhrase(normalizedIntent, keyword)) {
				score += SCORING_WEIGHTS.SUBSTRING_MATCH;
				matchedWords.add(keyword);
				if (matchType !== "exact") matchType = "exact";
			}
		}
	}

	// 2. Check template title
	const titleTokens = tokenize(template.title);
	for (const token of titleTokens) {
		if (token.length < 3) continue;
		if (intentTokens.has(token)) {
			score += SCORING_WEIGHTS.TITLE_WORD_MATCH;
			matchedWords.add(token);
		}
	}

	// 3. Check template description
	const descriptionTokens = tokenize(template.description);
	for (const token of descriptionTokens) {
		if (token.length < 3) continue;
		if (intentTokens.has(token)) {
			score += SCORING_WEIGHTS.DESCRIPTION_MATCH;
			matchedWords.add(token);
		}
	}

	// 4. Check template keywords
	for (const keyword of template.keywords) {
		const keywordTokens = tokenize(keyword);
		for (const token of keywordTokens) {
			if (token.length < 3) continue;
			if (intentTokens.has(token)) {
				score += SCORING_WEIGHTS.KEYWORD_MATCH;
				matchedWords.add(token);
			}
		}
	}

	// 5. Bonus for phrase coverage (multiple consecutive matches)
	const haystack = normalizeText(
		[template.title, template.description, ...template.keywords].join(" "),
	);
	for (const keyword of template.keywords) {
		if (keyword.length > 5 && containsPhrase(normalizedIntent, keyword)) {
			score += SCORING_WEIGHTS.PHRASE_MATCH_BONUS;
		}
	}

	// 6. Bonus for each matched word (capped)
	const matchedWordCount = Math.min(matchedWords.size, 5);
	score += matchedWordCount * SCORING_WEIGHTS.MATCHED_WORDS_BONUS;

	// Determine confidence based on score thresholds
	let confidence: "high" | "medium" | "low" | "none" = "none";
	if (score >= 15) confidence = "high";
	else if (score >= 8) confidence = "medium";
	else if (score >= 3) confidence = "low";

	return {
		template,
		score,
		confidence,
		matchedWords: Array.from(matchedWords),
		matchType,
	};
}

/**
 * Result of a section draft attempt.
 * Structured to be compatible with future AI providers.
 */
export interface SectionDraftResult {
	/** The matched template, if found */
	template: SectionStarterTemplate | null;
	/** The original intent query */
	intent: string;
	/** Confidence level of the match */
	confidence: "high" | "medium" | "low" | "none";
	/** Human-readable suggestion text */
	suggestion: string;
	/** Whether a match was found */
	found: boolean;
	/** Alternative suggestions (for autocomplete) */
	alternatives?: SectionStarterTemplate[];
}

/**
 * Options for draft section from intent.
 */
export interface DraftFromIntentOptions {
	/** Limit results to this many alternatives */
	maxAlternatives?: number;
	/** Existing sections to consider for context-aware suggestions */
	existingSections?: Section[];
	/** Minimum confidence threshold (0-1 normalized, default 0.2) */
	minConfidenceThreshold?: number;
}

/**
 * Draft a section from a user intent query.
 *
 * This function maps natural language intents to registered section templates
 * using a weighted scoring algorithm. It's intentionally deterministic and can
 * serve as the foundation for a future AI-backed provider that would return
 * structured suggestions.
 *
 * @param intent - Natural language intent describing the desired section
 * @param options - Optional configuration for the draft
 * @returns Structured draft result with template and suggestion
 *
 * @example
 * ```ts
 * const result = draftSectionFromIntent("I need a pricing table");
 * if (result.found) {
 *   console.log(`Suggested: ${result.template.title}`);
 * }
 * ```
 */
export function draftSectionFromIntent(
	intent: string,
	options: DraftFromIntentOptions = {},
): SectionDraftResult {
	const normalizedIntent = intent.trim().toLowerCase();
	const { maxAlternatives = 3, existingSections, minConfidenceThreshold = 0.2 } = options;

	if (!normalizedIntent) {
		return {
			template: null,
			intent,
			confidence: "none",
			suggestion: "Enter a description of the section you want to create.",
			found: false,
		};
	}

	// Score all templates
	const scores: TemplateScore[] = SECTION_STARTER_TEMPLATES.map((template) =>
		scoreTemplateAgainstIntent(template, normalizedIntent),
	);

	// Sort by score descending
	scores.sort((a, b) => b.score - a.score);

	// Filter out zero-score results and apply threshold
	const validScores = scores.filter(
		(s) =>
			s.score > 0 &&
			(s.confidence === "high" || s.confidence === "medium" || s.confidence === "low"),
	);

	if (validScores.length === 0) {
		// No match found - provide helpful suggestions
		return {
			template: null,
			intent,
			confidence: "none",
			suggestion: `No matching section found for "${intent}". Try words like: pricing, faq, testimonials, hero, features, video, tabs, stats, steps, logos`,
			found: false,
		};
	}

	const bestMatch: TemplateScore = validScores[0]!;
	const alternatives = validScores
		.slice(1, maxAlternatives + 1)
		.filter((s) => s.confidence !== "none")
		.map((s) => s.template);

	// Build suggestion message
	let suggestion: string;
	if (bestMatch.matchType === "exact" && bestMatch.confidence === "high") {
		suggestion = `Found a great match: ${bestMatch.template.title}`;
	} else if (bestMatch.confidence === "high") {
		suggestion = `Found a good match: ${bestMatch.template.title}`;
	} else if (bestMatch.confidence === "medium") {
		suggestion = `Based on "${intent}", try: ${bestMatch.template.title}`;
	} else {
		suggestion = `Maybe you're looking for: ${bestMatch.template.title}`;
	}

	const result: SectionDraftResult = {
		template: bestMatch.template,
		intent,
		confidence: bestMatch.confidence,
		suggestion,
		found: true,
	};

	if (alternatives.length > 0) {
		result.alternatives = alternatives;
	}

	// Page-context-aware enhancement: boost templates similar to existing sections
	if (existingSections && existingSections.length > 0) {
		const contextualBoost = contextualRelevanceBoost(bestMatch.template, existingSections);
		if (contextualBoost) {
			result.suggestion = `${result.suggestion} (frequently used on this page)`;
		}
	}

	return result;
}

/**
 * Calculate a contextual relevance boost based on existing sections on the page.
 * This helps suggest sections that complement what's already there.
 */
function contextualRelevanceBoost(
	template: SectionStarterTemplate,
	existingSections: Section[],
): boolean {
	// Check if this template type is commonly used with existing sections
	// Cast content items to have _type property
	const existingTypes = new Set(
		existingSections
			.map((s) => {
				const firstItem = s.content?.[0] as { _type?: string } | undefined;
				return firstItem?._type;
			})
			.filter(Boolean) as string[],
	);

	// Define complementary section relationships
	const complementaryPairs: Record<string, string[]> = {
		"hero-cover": ["card-grid", "stats", "feature-list", "cta-banner", "testimonial"],
		"card-grid": ["cta-banner", "testimonial", "steps"],
		"feature-list": ["card-grid", "stats", "cta-banner"],
		stats: ["feature-list", "card-grid", "steps"],
		faq: ["cta-banner", "hero-cover", "testimonial"],
		"pricing-table": ["faq", "testimonial", "cta-banner", "feature-list"],
		testimonial: ["cta-banner", "card-grid", "feature-list"],
		steps: ["cta-banner", "feature-list", "card-grid"],
	};

	const complements = complementaryPairs[template.slug] || [];
	return existingTypes.size > 0 && complements.some((c) => existingTypes.has(c));
}

/**
 * Get all available intent keywords for autocomplete hints.
 */
export function getIntentKeywords(): string[] {
	return INTENT_MAPPINGS.flatMap((m) => m.keywords);
}

/**
 * Get keyword suggestions for autocomplete.
 * Filters keywords that start with the given prefix.
 */
export function getIntentSuggestions(prefix: string, maxResults = 10): string[] {
	const normalizedPrefix = prefix.trim().toLowerCase();
	if (!normalizedPrefix || normalizedPrefix.length < 2) return [];

	const keywords = getIntentKeywords();
	const suggestions = new Set<string>();

	for (const keyword of keywords) {
		if (keyword.startsWith(normalizedPrefix) || keyword.includes(normalizedPrefix)) {
			suggestions.add(keyword);
			if (suggestions.size >= maxResults) break;
		}
	}

	return Array.from(suggestions).slice(0, maxResults);
}

/**
 * Get template suggestions based on partial input.
 * Useful for autocomplete dropdown in the UI.
 */
export function getTemplateSuggestions(
	partialInput: string,
	maxResults = 5,
): Array<{ template: SectionStarterTemplate; matchScore: number; matchedOn: string[] }> {
	const normalizedInput = partialInput.trim().toLowerCase();
	if (!normalizedInput || normalizedInput.length < 2) return [];

	const scores = SECTION_STARTER_TEMPLATES.map((template) => {
		const score = scoreTemplateAgainstIntent(template, normalizedInput);
		return {
			template,
			matchScore: score.score,
			matchedOn: score.matchedWords,
		};
	});

	// Filter and sort
	return scores
		.filter((s) => s.matchScore > 0)
		.sort((a, b) => b.matchScore - a.matchScore)
		.slice(0, maxResults);
}
