import * as React from "react";

import { useAdminBranding } from "../lib/admin-branding-context.js";

interface PageTitleOverride {
	pageKey: string;
	title: string;
}

const PageTitleContext = React.createContext<{
	pageKey: string;
	setOverride: React.Dispatch<React.SetStateAction<PageTitleOverride | null>>;
} | null>(null);

export function AdminDocumentTitle({
	children,
	siteName,
	pageKey,
	pageTitle,
}: {
	children: React.ReactNode;
	siteName?: string;
	pageKey: string;
	pageTitle: string;
}) {
	const { siteName: brandName } = useAdminBranding();
	const siteLabel = siteName?.trim() || brandName?.trim() || "EmDash";
	const [override, setOverride] = React.useState<PageTitleOverride | null>(null);
	const context = React.useMemo(() => ({ pageKey, setOverride }), [pageKey]);
	const title = override?.pageKey === pageKey ? override.title : pageTitle;
	React.useEffect(() => {
		document.title = `${title} · ${siteLabel}`;
	}, [title, siteLabel]);
	return <PageTitleContext.Provider value={context}>{children}</PageTitleContext.Provider>;
}

export function useAdminPageTitle(title: string) {
	const context = React.useContext(PageTitleContext);
	React.useEffect(() => {
		if (!context) return;
		const override = { pageKey: context.pageKey, title };
		context.setOverride(override);
		return () => context.setOverride((current) => (current === override ? null : current));
	}, [context, title]);
}
