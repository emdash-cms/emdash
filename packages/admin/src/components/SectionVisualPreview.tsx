import {
	Star,
	CheckCircle,
	Lightning,
	Gear,
	Users,
	Clock,
	Bell,
	Shield,
	ChartBar,
	Heart,
	Flag,
	Target,
	Key,
	LockSimple,
	Globe,
	Megaphone,
	CurrencyDollar,
} from "@phosphor-icons/react";
import * as React from "react";

type PortableTextBlock = Record<string, unknown>;

interface SectionVisualPreviewProps {
	value: unknown[];
}

export function SectionVisualPreview({ value }: SectionVisualPreviewProps) {
	const blocks = Array.isArray(value) ? value : [];

	if (blocks.length === 0) {
		return (
			<div className="rounded-lg border border-dashed bg-kumo-tint/40 p-8 text-center text-sm text-kumo-subtle">
				No preview content
			</div>
		);
	}

	return (
		<div className="space-y-5 rounded-lg border bg-kumo-base p-5">
			{blocks.map((block, index) => (
				<React.Fragment key={getKey(block, index)}>{renderBlock(block)}</React.Fragment>
			))}
		</div>
	);
}

function getKey(block: unknown, index: number): string {
	if (isRecord(block) && typeof block._key === "string") return block._key;
	return `preview-${index}`;
}

function renderBlock(block: unknown): React.ReactNode {
	if (!isRecord(block)) return null;

	switch (block._type) {
		case "block":
			return renderTextBlock(block);
		case "cover":
			return <CoverPreview block={block} />;
		case "button":
			return <ButtonPreview block={block} />;
		case "pullquote":
			return <PullquotePreview block={block} />;
		case "image":
			return <ImagePreview block={block} />;
		case "accordion":
			return <AccordionPreview block={block} />;
		case "banner":
			return <BannerPreview block={block} />;
		case "testimonial":
			return <TestimonialPreview block={block} />;
		case "card":
			return <CardPreview block={block} />;
		case "cardGrid":
			return <CardGridPreview block={block} />;
		case "tab":
			return <TabsPreview block={block} />;
		case "stats":
			return <StatsPreview block={block} />;
		case "featureList":
			return <FeatureListPreview block={block} />;
		case "logoCloud":
			return <LogoCloudPreview block={block} />;
		case "steps":
			return <StepsPreview block={block} />;
		case "faq":
			return <FaqPreview block={block} />;
		case "videoEmbed":
			return <VideoEmbedPreview block={block} />;
		case "pricingTable":
			return <PricingTablePreview block={block} />;
		case "ctaBanner":
			return <CtaBannerPreview block={block} />;
		default:
			return <UnknownBlockPreview block={block} />;
	}
}

function renderTextBlock(block: PortableTextBlock): React.ReactNode {
	const style = typeof block.style === "string" ? block.style : "normal";
	const text = renderChildren(block.children);
	const listItem = typeof block.listItem === "string" ? block.listItem : "";

	if (listItem) {
		return (
			<p className="pl-4 text-sm leading-7 text-kumo-default">
				{listItem === "number" ? "1. " : "- "}
				{text}
			</p>
		);
	}

	switch (style) {
		case "h1":
			return <h1 className="text-3xl font-bold leading-tight">{text}</h1>;
		case "h2":
			return <h2 className="text-2xl font-semibold leading-tight">{text}</h2>;
		case "h3":
			return <h3 className="text-xl font-semibold leading-snug">{text}</h3>;
		case "blockquote":
			return (
				<blockquote className="border-s-4 border-kumo-line ps-4 text-kumo-subtle italic">
					{text}
				</blockquote>
			);
		default:
			return <p className="text-sm leading-7 text-kumo-default">{text}</p>;
	}
}

function renderChildren(children: unknown): React.ReactNode {
	if (!Array.isArray(children)) return null;
	return children.map((child, index) => {
		if (!isRecord(child)) return null;
		const text = typeof child.text === "string" ? child.text : "";
		const marks = Array.isArray(child.marks) ? child.marks : [];
		let node: React.ReactNode = text;

		if (marks.includes("code")) {
			node = <code className="rounded bg-kumo-tint px-1 py-0.5 text-xs">{node}</code>;
		}
		if (marks.includes("em")) {
			node = <em>{node}</em>;
		}
		if (marks.includes("strong")) {
			node = <strong>{node}</strong>;
		}

		return (
			<React.Fragment key={typeof child._key === "string" ? child._key : index}>
				{node}
			</React.Fragment>
		);
	});
}

function CoverPreview({ block }: { block: PortableTextBlock }) {
	const heading = typeof block.heading === "string" ? block.heading : "";
	const body = typeof block.body === "string" ? block.body : "";
	const ctaText = typeof block.ctaText === "string" ? block.ctaText : "";
	const ctaUrl = typeof block.ctaUrl === "string" ? block.ctaUrl : "";
	const backgroundImage = typeof block.backgroundImage === "string" ? block.backgroundImage : "";
	const minHeight = typeof block.minHeight === "string" ? block.minHeight : "320px";
	const alignment =
		block.alignment === "left" || block.alignment === "right" || block.alignment === "center"
			? block.alignment
			: "center";
	const overlayOpacity = typeof block.overlayOpacity === "number" ? block.overlayOpacity : 0.45;
	const structuredContent = Array.isArray(block.content) ? block.content : [];

	return (
		<section
			className="relative flex overflow-hidden rounded bg-neutral-900 p-8 text-white"
			style={{
				minHeight,
				alignItems: "center",
				justifyContent:
					alignment === "left" ? "flex-start" : alignment === "right" ? "flex-end" : "center",
				textAlign: alignment,
			}}
		>
			{backgroundImage && (
				<img src={backgroundImage} alt="" className="absolute inset-0 h-full w-full object-cover" />
			)}
			<div
				className="absolute inset-0 bg-black"
				style={{ opacity: backgroundImage ? overlayOpacity : 0 }}
			/>
			<div className="relative z-10 max-w-2xl">
				{structuredContent.length > 0 ? (
					<div className="space-y-4">
						{structuredContent.map((item, index) => (
							<React.Fragment key={getKey(item, index)}>{renderBlock(item)}</React.Fragment>
						))}
					</div>
				) : (
					<>
						{heading && <h2 className="text-4xl font-bold leading-tight">{heading}</h2>}
						{body && <p className="mt-4 text-base leading-7 text-white/85">{body}</p>}
						{ctaText && (
							<a
								href={safeHref(ctaUrl)}
								className="mt-6 inline-flex rounded bg-white px-4 py-2 text-sm font-semibold text-neutral-950"
								style={{ color: "#111827" }}
							>
								{ctaText}
							</a>
						)}
					</>
				)}
			</div>
		</section>
	);
}

function ButtonPreview({ block }: { block: PortableTextBlock }) {
	const text = typeof block.text === "string" ? block.text : "Button";
	const href =
		typeof block.url === "string" ? block.url : typeof block.id === "string" ? block.id : "";
	const style = block.style === "outline" ? "outline" : "fill";

	return (
		<a
			href={safeHref(href)}
			className={
				style === "outline"
					? "inline-flex rounded border border-kumo-line px-4 py-2 text-sm font-medium"
					: "inline-flex rounded bg-kumo-brand px-4 py-2 text-sm font-medium text-white"
			}
			style={style === "outline" ? undefined : { color: "#fff" }}
		>
			{text}
		</a>
	);
}

function PullquotePreview({ block }: { block: PortableTextBlock }) {
	const text = typeof block.text === "string" ? block.text : "";
	const citation = typeof block.citation === "string" ? block.citation : "";

	return (
		<figure className="border-y-4 border-kumo-line px-6 py-5 text-center">
			<blockquote className="text-xl italic leading-relaxed">{text}</blockquote>
			{citation && <figcaption className="mt-3 text-sm text-kumo-subtle">{citation}</figcaption>}
		</figure>
	);
}

function ImagePreview({ block }: { block: PortableTextBlock }) {
	const src =
		typeof block.url === "string" ? block.url : typeof block.src === "string" ? block.src : "";
	const alt = typeof block.alt === "string" ? block.alt : "";

	if (!src) return <UnknownBlockPreview block={block} />;

	return <img src={src} alt={alt} className="max-h-96 w-full rounded object-cover" />;
}

function AccordionPreview({ block }: { block: PortableTextBlock }) {
	const items = Array.isArray(block.items) ? block.items : [];

	if (items.length === 0) {
		return (
			<div className="rounded border border-dashed bg-kumo-tint/40 p-4 text-sm text-kumo-subtle">
				No accordion items
			</div>
		);
	}

	return (
		<div className="space-y-2 rounded-lg border border-kumo-line p-4">
			{items.map((item, index) => {
				if (!isRecord(item)) return null;
				const label = typeof item.label === "string" ? item.label : `Item ${index + 1}`;
				const itemBlocks = Array.isArray(item.blocks) ? item.blocks : [];
				const body =
					typeof item.body === "string"
						? item.body
						: typeof item.text === "string"
							? item.text
							: "";

				return (
					<details key={getKey(item, index)} className="group">
						<summary className="flex cursor-pointer list-none items-center justify-between rounded bg-kumo-tint/50 px-4 py-3 text-sm font-medium text-kumo-default hover:bg-kumo-tint">
							<span>{label}</span>
							<span className="text-kumo-subtle transition-transform group-open:rotate-180">
								<svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
									<path
										strokeLinecap="round"
										strokeLinejoin="round"
										strokeWidth={2}
										d="M19 9l-7 7-7-7"
									/>
								</svg>
							</span>
						</summary>
						<div className="mt-2 space-y-3 rounded-b bg-kumo-base p-4">
							{itemBlocks.length > 0 ? (
								itemBlocks.map((itemBlock, itemIndex) => (
									<React.Fragment key={getKey(itemBlock, itemIndex)}>
										{renderBlock(itemBlock)}
									</React.Fragment>
								))
							) : body ? (
								<p className="text-sm leading-7 text-kumo-default">{body}</p>
							) : (
								<p className="text-sm text-kumo-subtle">No content</p>
							)}
						</div>
					</details>
				);
			})}
		</div>
	);
}

function BannerPreview({ block }: { block: PortableTextBlock }) {
	const title = typeof block.title === "string" ? block.title : "";
	const description = typeof block.description === "string" ? block.description : "";
	const variant =
		block.variant === "alert" ? "alert" : block.variant === "error" ? "error" : "default";

	const variantStyles = {
		default: "border-kumo-line bg-kumo-tint",
		alert: "border-kumo-brand/40 bg-kumo-brand/10",
		error: "border-red-400/40 bg-red-50 dark:bg-red-950/20",
	};

	const iconColors = {
		default: "text-kumo-subtle",
		alert: "text-kumo-brand",
		error: "text-red-500",
	};

	return (
		<div
			className={`rounded-lg border px-4 py-3 ${variantStyles[variant]}`}
			role={variant === "default" ? "status" : "alert"}
		>
			<div className="flex gap-3">
				{variant === "alert" && (
					<svg
						className={`mt-0.5 h-5 w-5 flex-shrink-0 ${iconColors[variant]}`}
						fill="currentColor"
						viewBox="0 0 20 20"
					>
						<path
							fillRule="evenodd"
							d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z"
							clipRule="evenodd"
						/>
					</svg>
				)}
				{variant === "error" && (
					<svg
						className={`mt-0.5 h-5 w-5 flex-shrink-0 ${iconColors[variant]}`}
						fill="currentColor"
						viewBox="0 0 20 20"
					>
						<path
							fillRule="evenodd"
							d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z"
							clipRule="evenodd"
						/>
					</svg>
				)}
				{variant === "default" && (
					<svg
						className={`mt-0.5 h-5 w-5 flex-shrink-0 ${iconColors[variant]}`}
						fill="currentColor"
						viewBox="0 0 20 20"
					>
						<path
							fillRule="evenodd"
							d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z"
							clipRule="evenodd"
						/>
					</svg>
				)}
				<div className="min-w-0 flex-1">
					{title && <p className="text-sm font-medium leading-tight text-kumo-default">{title}</p>}
					{description && (
						<p className="mt-1 text-sm leading-relaxed text-kumo-subtle">{description}</p>
					)}
				</div>
			</div>
		</div>
	);
}

function TestimonialPreview({ block }: { block: PortableTextBlock }) {
	const items = Array.isArray(block.items) ? block.items : [];

	if (items.length === 0) {
		return (
			<div className="rounded border border-dashed bg-kumo-tint/40 p-4 text-sm text-kumo-subtle">
				No testimonials
			</div>
		);
	}

	return (
		<div className="grid gap-4 sm:grid-cols-2">
			{items.map((item, index) => {
				if (!isRecord(item)) return null;
				const quote = typeof item.quote === "string" ? item.quote : "";
				const author = typeof item.author === "string" ? item.author : "";
				const title = typeof item.title === "string" ? item.title : "";
				const company = typeof item.company === "string" ? item.company : "";
				const avatar = typeof item.avatar === "string" ? item.avatar : "";

				return (
					<figure
						key={getKey(item, index)}
						className="rounded-lg border border-kumo-line bg-kumo-base p-5"
					>
						<blockquote className="text-base leading-relaxed text-kumo-default">{quote}</blockquote>
						<figcaption className="mt-4 flex items-center gap-3">
							{avatar && (
								<img src={avatar} alt={author} className="h-10 w-10 rounded-full object-cover" />
							)}
							<div>
								{author && <div className="text-sm font-medium text-kumo-default">{author}</div>}
								{(title || company) && (
									<div className="text-sm text-kumo-subtle">
										{title}
										{title && company && ", "}
										{company}
									</div>
								)}
							</div>
						</figcaption>
					</figure>
				);
			})}
		</div>
	);
}

function CardPreview({ block }: { block: PortableTextBlock }) {
	return <CardShell item={block} />;
}

function CardGridPreview({ block }: { block: PortableTextBlock }) {
	const title = typeof block.title === "string" ? block.title : "";
	const description = typeof block.description === "string" ? block.description : "";
	const columns = normalizeColumns(block.columns);
	const items = Array.isArray(block.items) ? block.items : [];
	const columnClass =
		columns === 2
			? "sm:grid-cols-2"
			: columns === 4
				? "sm:grid-cols-2 lg:grid-cols-4"
				: "sm:grid-cols-2 lg:grid-cols-3";

	return (
		<section className="space-y-4">
			{(title || description) && (
				<div>
					{title && (
						<h2 className="text-xl font-semibold leading-tight text-kumo-default">{title}</h2>
					)}
					{description && <p className="mt-2 text-sm leading-6 text-kumo-subtle">{description}</p>}
				</div>
			)}
			{items.length > 0 ? (
				<div className={`grid gap-4 ${columnClass}`}>
					{items.map((item, index) =>
						isRecord(item) ? <CardShell key={getKey(item, index)} item={item} /> : null,
					)}
				</div>
			) : (
				<div className="rounded border border-dashed bg-kumo-tint/40 p-4 text-sm text-kumo-subtle">
					No cards
				</div>
			)}
		</section>
	);
}

function CardShell({ item }: { item: PortableTextBlock }) {
	const title = typeof item.title === "string" ? item.title : "Card title";
	const description = typeof item.description === "string" ? item.description : "";
	const image = typeof item.image === "string" ? item.image : "";
	const ctaText = typeof item.ctaText === "string" ? item.ctaText : "";
	const ctaUrl = typeof item.ctaUrl === "string" ? item.ctaUrl : "";

	return (
		<article className="overflow-hidden rounded-lg border border-kumo-line bg-kumo-base text-kumo-default">
			{image ? (
				<img src={image} alt={title} className="h-36 w-full object-cover" />
			) : (
				<div className="flex h-36 items-center justify-center border-b border-kumo-line bg-kumo-tint text-sm text-kumo-subtle">
					Image
				</div>
			)}
			<div className="p-4">
				<h3 className="text-sm font-semibold leading-tight text-kumo-default">{title}</h3>
				{description && <p className="mt-2 text-sm leading-6 text-kumo-subtle">{description}</p>}
				{ctaText && (
					<a
						href={safeHref(ctaUrl)}
						className="mt-3 inline-flex text-sm font-medium text-kumo-brand hover:underline"
					>
						{ctaText}
					</a>
				)}
			</div>
		</article>
	);
}

function TabsPreview({ block }: { block: PortableTextBlock }) {
	const panels = Array.isArray(block.panels) ? block.panels.filter(isRecord) : [];
	const defaultTab = typeof block.default_tab === "number" ? block.default_tab : 0;
	const activePanel = panels[Math.min(Math.max(defaultTab, 0), Math.max(panels.length - 1, 0))];

	if (panels.length === 0) {
		return (
			<div className="rounded border border-dashed bg-kumo-tint/40 p-4 text-sm text-kumo-subtle">
				No tab panels
			</div>
		);
	}

	return (
		<section className="rounded-lg border border-kumo-line bg-kumo-base text-kumo-default">
			<div className="flex gap-1 overflow-x-auto border-b border-kumo-line px-3 pt-3">
				{panels.map((panel, index) => {
					const label = typeof panel.label === "string" ? panel.label : `Tab ${index + 1}`;
					const isActive = panel === activePanel;

					return (
						<div
							key={getKey(panel, index)}
							className={
								isActive
									? "rounded-t bg-kumo-tint px-3 py-2 text-sm font-medium text-kumo-default"
									: "px-3 py-2 text-sm text-kumo-subtle"
							}
						>
							{label}
						</div>
					);
				})}
			</div>
			<div className="space-y-3 p-4">
				{activePanel && Array.isArray(activePanel.blocks) && activePanel.blocks.length > 0 ? (
					activePanel.blocks.map((item, index) => (
						<React.Fragment key={getKey(item, index)}>{renderBlock(item)}</React.Fragment>
					))
				) : activePanel && typeof activePanel.body === "string" ? (
					<p className="text-sm leading-7 text-kumo-default">{activePanel.body}</p>
				) : (
					<p className="text-sm text-kumo-subtle">No panel content</p>
				)}
			</div>
		</section>
	);
}

function StatsPreview({ block }: { block: PortableTextBlock }) {
	const items = Array.isArray(block.items) ? block.items.filter(isRecord) : [];

	if (items.length === 0) {
		return (
			<div className="rounded border border-dashed bg-kumo-tint/40 p-4 text-sm text-kumo-subtle">
				No stats
			</div>
		);
	}

	return (
		<section className="grid gap-3 sm:grid-cols-3">
			{items.map((item, index) => {
				const label = typeof item.label === "string" ? item.label : `Metric ${index + 1}`;
				const value =
					typeof item.value === "string" || typeof item.value === "number" ? item.value : "";
				const description = typeof item.description === "string" ? item.description : "";
				const trend =
					item.trend === "up" || item.trend === "down" || item.trend === "neutral"
						? item.trend
						: "neutral";
				const trendLabel = trend === "up" ? "up" : trend === "down" ? "down" : "flat";
				const trendClass =
					trend === "up"
						? "text-green-600"
						: trend === "down"
							? "text-red-600"
							: "text-kumo-subtle";

				return (
					<div
						key={getKey(item, index)}
						className="rounded-lg border border-kumo-line bg-kumo-base p-4"
					>
						<div className="text-xs font-medium uppercase text-kumo-subtle">{label}</div>
						<div className="mt-2 flex items-baseline gap-2">
							<div className="text-2xl font-semibold leading-none text-kumo-default">{value}</div>
							<span className={`text-sm font-medium ${trendClass}`}>{trendLabel}</span>
						</div>
						{description && (
							<div className="mt-2 text-sm leading-5 text-kumo-subtle">{description}</div>
						)}
					</div>
				);
			})}
		</section>
	);
}

const FEATURE_ICON_MAP: Record<string, React.ComponentType<{ className?: string }>> = {
	star: Star,
	check: CheckCircle,
	lightning: Lightning,
	gear: Gear,
	users: Users,
	clock: Clock,
	bell: Bell,
	shield: Shield,
	chart: ChartBar,
	heart: Heart,
	flag: Flag,
	target: Target,
	key: Key,
	lock: LockSimple,
	globe: Globe,
};

function resolveFeatureIcon(iconKey?: string): React.ComponentType<{ className?: string }> {
	if (iconKey && FEATURE_ICON_MAP[iconKey]) {
		return FEATURE_ICON_MAP[iconKey];
	}
	return Star;
}

function FeatureListPreview({ block }: { block: PortableTextBlock }) {
	const title = typeof block.title === "string" ? block.title : "";
	const description = typeof block.description === "string" ? block.description : "";
	const columns = normalizeColumns(block.columns);
	const items = Array.isArray(block.items) ? block.items : [];
	const columnClass =
		columns === 2
			? "sm:grid-cols-2"
			: columns === 4
				? "sm:grid-cols-2 lg:grid-cols-4"
				: "sm:grid-cols-2 lg:grid-cols-3";

	return (
		<section className="space-y-4">
			{(title || description) && (
				<div>
					{title && (
						<h2 className="text-xl font-semibold leading-tight text-kumo-default">{title}</h2>
					)}
					{description && <p className="mt-2 text-sm leading-6 text-kumo-subtle">{description}</p>}
				</div>
			)}
			{items.length > 0 ? (
				<div className={`grid gap-4 ${columnClass}`}>
					{items.map((item, index) =>
						isRecord(item) ? (
							<div
								key={getKey(item, index)}
								className="flex gap-4 rounded-lg border border-kumo-line bg-kumo-base p-4"
							>
								<div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg bg-kumo-brand/10 text-kumo-brand">
									{(() => {
										const IconComponent = resolveFeatureIcon(
											typeof item.icon === "string" ? item.icon : "",
										);
										return <IconComponent className="h-5 w-5" />;
									})()}
								</div>
								<div className="min-w-0 flex-1">
									<h3 className="text-sm font-semibold leading-tight text-kumo-default">
										{typeof item.title === "string" ? item.title : "Feature"}
									</h3>
									{typeof item.description === "string" && item.description && (
										<p className="mt-1 text-sm leading-5 text-kumo-subtle">{item.description}</p>
									)}
									{typeof item.url === "string" && item.url && (
										<a
											href={safeHref(item.url)}
											className="mt-2 inline-flex text-sm font-medium text-kumo-brand hover:underline"
										>
											Learn more
										</a>
									)}
								</div>
							</div>
						) : null,
					)}
				</div>
			) : (
				<div className="rounded border border-dashed bg-kumo-tint/40 p-4 text-sm text-kumo-subtle">
					No features
				</div>
			)}
		</section>
	);
}

function LogoCloudPreview({ block }: { block: PortableTextBlock }) {
	const title = typeof block.title === "string" ? block.title : "";
	const items = Array.isArray(block.items) ? block.items : [];

	return (
		<section className="space-y-4">
			{title && <h2 className="text-xl font-semibold text-kumo-default">{title}</h2>}
			{items.length > 0 ? (
				<div className="flex flex-wrap gap-6 items-center justify-center">
					{items.map((item, index) =>
						isRecord(item) ? (
							<div key={getKey(item, index)} className="flex items-center">
								{item.logoUrl ? (
									<img
										src={typeof item.logoUrl === "string" ? item.logoUrl : ""}
										alt={typeof item.name === "string" ? item.name : ""}
										className="max-h-12 w-auto object-contain"
									/>
								) : (
									<div className="flex h-12 w-24 items-center justify-center rounded border border-dashed border-kumo-line bg-kumo-tint/40 text-xs text-kumo-subtle">
										{typeof item.name === "string" ? item.name : "Logo"}
									</div>
								)}
							</div>
						) : null,
					)}
				</div>
			) : (
				<div className="rounded border border-dashed bg-kumo-tint/40 p-4 text-sm text-kumo-subtle">
					No logos
				</div>
			)}
		</section>
	);
}

function FaqPreview({ block }: { block: PortableTextBlock }) {
	const items = Array.isArray(block.items) ? block.items : [];

	if (items.length === 0) {
		return (
			<div className="rounded border border-dashed bg-kumo-tint/40 p-4 text-sm text-kumo-subtle">
				No FAQ items
			</div>
		);
	}

	return (
		<div className="flex flex-col gap-3">
			{items.map((item, index) =>
				isRecord(item) ? (
					<details key={getKey(item, index)} className="group rounded-lg border border-kumo-line">
						<summary className="flex cursor-pointer list-none items-center justify-between rounded-lg bg-kumo-tint/50 px-4 py-3 text-sm font-medium text-kumo-default hover:bg-kumo-tint">
							<span>
								{typeof item.question === "string" ? item.question : `Question ${index + 1}`}
							</span>
							<span className="text-kumo-subtle transition-transform group-open:rotate-180">
								<svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
									<path
										strokeLinecap="round"
										strokeLinejoin="round"
										strokeWidth={2}
										d="M19 9l-7 7-7-7"
									/>
								</svg>
							</span>
						</summary>
						<div className="rounded-b-lg border-t-0 border border-kumo-line bg-kumo-base px-4 py-3">
							<p className="text-sm leading-7 text-kumo-default">
								{typeof item.answer === "string" ? item.answer : "No answer provided"}
							</p>
						</div>
					</details>
				) : null,
			)}
		</div>
	);
}

function VideoEmbedPreview({ block }: { block: PortableTextBlock }) {
	const embedUrl = typeof block.embedUrl === "string" ? block.embedUrl : "";
	const title = typeof block.title === "string" ? block.title : "Video";
	const caption = typeof block.caption === "string" ? block.caption : "";

	if (!embedUrl) {
		return (
			<div className="rounded-lg border border-dashed border-kumo-line bg-kumo-tint/40 p-6 text-center text-sm text-kumo-subtle">
				No video URL provided
			</div>
		);
	}

	return (
		<figure className="space-y-3">
			<div className="relative overflow-hidden rounded-lg border border-kumo-line bg-kumo-tint">
				<iframe
					src={embedUrl}
					title={title}
					allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
					allowFullScreen
					className="aspect-video w-full"
					loading="lazy"
				/>
			</div>
			{caption && (
				<figcaption className="text-center text-sm text-kumo-subtle">{caption}</figcaption>
			)}
		</figure>
	);
}

function PricingTablePreview({ block }: { block: PortableTextBlock }) {
	const title = typeof block.title === "string" ? block.title : "";
	const description = typeof block.description === "string" ? block.description : "";
	const columns = normalizeColumns(block.columns);
	const items = Array.isArray(block.items) ? block.items : [];
	const highlightedTier = typeof block.highlightedTier === "number" ? block.highlightedTier : -1;

	if (items.length === 0) {
		return (
			<div className="rounded border border-dashed bg-kumo-tint/40 p-4 text-sm text-kumo-subtle">
				No pricing tiers
			</div>
		);
	}

	const columnClass =
		columns === 2
			? "grid-cols-2"
			: columns === 4
				? "grid-cols-2 lg:grid-cols-4"
				: "grid-cols-2 lg:grid-cols-3";

	return (
		<section className="space-y-4">
			{(title || description) && (
				<div className="text-center">
					{title && (
						<h2 className="text-xl font-semibold leading-tight text-kumo-default">{title}</h2>
					)}
					{description && <p className="mt-2 text-sm leading-6 text-kumo-subtle">{description}</p>}
				</div>
			)}
			<div className={`grid gap-4 ${columnClass}`}>
				{items.map((item, index) =>
					isRecord(item) ? (
						<div
							key={getKey(item, index)}
							className={`rounded-lg border p-4 ${
								index === highlightedTier || item.featured === true
									? "border-kumo-brand bg-kumo-brand/5"
									: "border-kumo-line bg-kumo-base"
							}`}
						>
							<div className="text-center">
								<div className="text-sm font-medium text-kumo-default">
									{typeof item.name === "string" ? item.name : `Tier ${index + 1}`}
								</div>
								<div className="mt-2 flex items-baseline justify-center gap-1">
									<span className="text-2xl font-bold text-kumo-default">
										{typeof item.price === "string" ? item.price : "—"}
									</span>
									<span className="text-sm text-kumo-subtle">
										/{typeof item.period === "string" ? item.period : "mo"}
									</span>
								</div>
								{typeof item.description === "string" && item.description && (
									<p className="mt-2 text-xs text-kumo-subtle">{item.description}</p>
								)}
							</div>
							{(index === highlightedTier || item.featured === true) && (
								<div className="mt-2 text-center">
									<span className="inline-block rounded bg-kumo-brand px-2 py-0.5 text-xs font-medium text-white">
										Popular
									</span>
								</div>
							)}
							<div className="mt-4 space-y-2">
								{typeof item.features === "string" &&
									item.features
										.split("\n")
										.filter(Boolean)
										.map((feature: string, featIndex: number) => (
											<div key={featIndex} className="flex items-start gap-2 text-sm">
												<CheckCircle className="mt-0.5 h-4 w-4 flex-shrink-0 text-kumo-brand" />
												<span className="text-kumo-default">{feature.trim()}</span>
											</div>
										))}
							</div>
							{typeof item.ctaText === "string" && item.ctaText && (
								<a
									href={safeHref(typeof item.ctaUrl === "string" ? item.ctaUrl : "")}
									className={`mt-4 flex w-full items-center justify-center rounded px-4 py-2 text-sm font-medium ${
										index === highlightedTier || item.featured === true
											? "bg-kumo-brand text-white hover:bg-kumo-brand/90"
											: "border border-kumo-line text-kumo-default hover:bg-kumo-tint"
									}`}
								>
									{item.ctaText}
								</a>
							)}
						</div>
					) : null,
				)}
			</div>
		</section>
	);
}

function CtaBannerPreview({ block }: { block: PortableTextBlock }) {
	const title = typeof block.title === "string" ? block.title : "";
	const description = typeof block.description === "string" ? block.description : "";
	const backgroundColor =
		block.backgroundColor === "dark"
			? "dark"
			: block.backgroundColor === "light"
				? "light"
				: block.backgroundColor === "gradient"
					? "gradient"
					: "brand";
	const buttonText = typeof block.buttonText === "string" ? block.buttonText : "";
	const buttonUrl = typeof block.buttonUrl === "string" ? block.buttonUrl : "";
	const buttonStyle =
		block.buttonStyle === "outline" ? "outline" : block.buttonStyle === "ghost" ? "ghost" : "fill";
	const alignment =
		block.alignment === "left" ? "left" : block.alignment === "right" ? "right" : "center";

	const bgStyles = {
		brand: "bg-kumo-brand",
		dark: "bg-neutral-900",
		light: "bg-kumo-tint",
		gradient: "bg-gradient-to-r from-kumo-brand to-purple-600",
	};

	const textStyles = {
		brand: "text-white",
		dark: "text-white",
		light: "text-kumo-default",
		gradient: "text-white",
	};

	const buttonStyles = {
		fill:
			buttonStyle === "fill"
				? backgroundColor === "light"
					? "bg-kumo-brand text-white hover:bg-kumo-brand/90"
					: "bg-white text-kumo-brand hover:bg-white/90"
				: "",
		outline:
			buttonStyle === "outline"
				? backgroundColor === "light"
					? "border-2 border-kumo-brand text-kumo-brand hover:bg-kumo-brand/10"
					: "border-2 border-white text-white hover:bg-white/10"
				: "",
		ghost:
			buttonStyle === "ghost"
				? backgroundColor === "light"
					? "text-kumo-brand hover:bg-kumo-brand/10"
					: "text-white hover:bg-white/10"
				: "",
	};

	return (
		<section className={`rounded-lg ${bgStyles[backgroundColor]} px-8 py-10`}>
			<div
				className={`flex flex-col gap-4 ${
					alignment === "left"
						? "items-start text-left"
						: alignment === "right"
							? "items-end text-right"
							: "items-center text-center"
				}`}
			>
				{title && <h2 className={`text-2xl font-bold ${textStyles[backgroundColor]}`}>{title}</h2>}
				{description && (
					<p
						className={`max-w-xl text-base ${backgroundColor === "light" ? "text-kumo-default" : "text-white/85"}`}
					>
						{description}
					</p>
				)}
				{buttonText && (
					<a
						href={safeHref(buttonUrl)}
						className={`inline-flex rounded px-6 py-3 text-sm font-semibold transition-colors ${
							buttonStyle === "fill"
								? buttonStyles.fill
								: buttonStyle === "outline"
									? buttonStyles.outline
									: buttonStyles.ghost
						}`}
					>
						{buttonText}
					</a>
				)}
			</div>
		</section>
	);
}

function StepsPreview({ block }: { block: PortableTextBlock }) {
	const title = typeof block.title === "string" ? block.title : "";
	const items = Array.isArray(block.items) ? block.items : [];

	return (
		<section className="space-y-4">
			{title && <h2 className="text-xl font-semibold text-kumo-default">{title}</h2>}
			{items.length > 0 ? (
				<ol className="relative border-s-2 border-kumo-line ps-6 space-y-6">
					{items.map((item, index) =>
						isRecord(item) ? (
							<li key={getKey(item, index)} className="relative">
								<div className="absolute -start-3 flex h-6 w-6 items-center justify-center rounded-full bg-kumo-brand text-white text-xs font-bold">
									{index + 1}
								</div>
								<div className="flex gap-3">
									{typeof item.icon === "string" && item.icon && (
										<span className="mt-0.5 text-lg">
											{(() => {
												const IconComp = resolveFeatureIcon(item.icon);
												return <IconComp className="h-5 w-5 text-kumo-brand" />;
											})()}
										</span>
									)}
									<div>
										<h3 className="text-base font-semibold text-kumo-default">
											{typeof item.title === "string" ? item.title : `Step ${index + 1}`}
										</h3>
										{typeof item.description === "string" && item.description && (
											<p className="mt-1 text-sm text-kumo-subtle">{item.description}</p>
										)}
									</div>
								</div>
							</li>
						) : null,
					)}
				</ol>
			) : (
				<div className="rounded border border-dashed bg-kumo-tint/40 p-4 text-sm text-kumo-subtle">
					No steps
				</div>
			)}
		</section>
	);
}

function UnknownBlockPreview({ block }: { block: PortableTextBlock }) {
	const type = typeof block._type === "string" ? block._type : "unknown";

	return (
		<div className="rounded border border-dashed bg-kumo-tint/40 p-4 text-sm text-kumo-subtle">
			Unsupported preview block: <span className="font-mono">{type}</span>
		</div>
	);
}

function safeHref(value: string): string {
	if (!value) return "#";
	if (value.startsWith("/") || value.startsWith("#")) return value;
	try {
		const url = new URL(value);
		if (url.protocol === "http:" || url.protocol === "https:" || url.protocol === "mailto:") {
			return value;
		}
	} catch {
		return "#";
	}
	return "#";
}

function isRecord(value: unknown): value is PortableTextBlock {
	return typeof value === "object" && value !== null;
}

function normalizeColumns(value: unknown): 2 | 3 | 4 {
	if (value === 2 || value === "2") return 2;
	if (value === 4 || value === "4") return 4;
	return 3;
}
