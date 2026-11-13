import { Banner, Button, Tabs, useKumoToastManager } from "@cloudflare/kumo";
import { useLingui as useLinguiContext } from "@lingui/react";
import { useLingui } from "@lingui/react/macro";
import { ArrowCounterClockwise } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import * as React from "react";

import type { LayoutScope } from "../../lib/admin-layout.js";
import { useAdminLayoutEditor } from "../../lib/api/admin-layout.js";
import { fetchManifest } from "../../lib/api/client.js";
import { useCurrentUser } from "../../lib/api/current-user.js";
import { listEditorSections } from "../../lib/editor-sections.js";
import { usePluginAdmins } from "../../lib/plugin-context.js";
import { buildNavGroups, declaredLabelTranslator } from "../Sidebar.js";
import { LayoutList, type LayoutRowItem } from "./LayoutList.js";
import { SettingsFrame } from "./SettingsLayout.js";

export type SidebarsSettingsTab = "navigation" | "editor";

interface SidebarsSettingsProps {
	tab: SidebarsSettingsTab;
}

const SCOPE: Record<SidebarsSettingsTab, LayoutScope> = { navigation: "nav", editor: "editor" };

export function SidebarsSettings({ tab }: SidebarsSettingsProps) {
	const { t } = useLingui();
	// `_` is rebound on locale switches, so it invalidates the memos below.
	const { _: translate, i18n } = useLinguiContext();
	const navigate = useNavigate();
	const toastManager = useKumoToastManager();
	const pluginAdmins = usePluginAdmins();
	const role = useCurrentUser().data?.role ?? 0;
	const { data: manifest } = useQuery({ queryKey: ["manifest"], queryFn: fetchManifest });

	const navGroups = React.useMemo(
		() => (manifest ? buildNavGroups({ manifest, pluginAdmins, role, i18n, translate }) : []),
		[manifest, pluginAdmins, role, i18n, translate],
	);
	const editorSections = React.useMemo((): LayoutRowItem[] => {
		if (!manifest) return [];
		const translateDeclared = declaredLabelTranslator(i18n, (id) => translate(id));
		return listEditorSections(manifest, pluginAdmins, role).map((section) =>
			section.kind === "built-in"
				? { id: section.id, label: translate(section.label) }
				: { id: section.id, label: translateDeclared(section.label), meta: section.meta },
		);
	}, [manifest, pluginAdmins, role, i18n, translate]);

	const sidebars = useAdminLayoutEditor({ navGroups, editorSections });
	const scope = SCOPE[tab];
	const disabled = !sidebars.ready;
	const toolbarRef = React.useRef<HTMLDivElement>(null);

	const setVisible = (id: string, visible: boolean) => sidebars.setVisible(scope, id, visible);
	const move = (activeId: string, overId: string) => sidebars.move(scope, activeId, overId);

	const reset = () => {
		const undo = sidebars.reset(scope);
		// Reset disables itself, which would drop focus to the page.
		toolbarRef.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus();
		const toastId: string = toastManager.add({
			title: scope === "nav" ? t`Navigation reset` : t`Editor sidebar reset`,
			description: t`Everything is shown again, in the default order.`,
			actions: [
				{
					children: t`Undo`,
					onClick: () => {
						undo();
						toastManager.close(toastId);
					},
				},
			],
		});
	};

	return (
		<SettingsFrame
			title={t`Sidebars`}
			description={t`Choose what your sidebars show and in what order. Only you see your layout, and it follows you to any browser.`}
		>
			<div className="grid max-w-2xl gap-3">
				{sidebars.reloadError && (
					<Banner
						variant="error"
						role="alert"
						title={t`Couldn't load your sidebars`}
						description={sidebars.reloadError.message}
						action={
							<Button variant="secondary" size="sm" onClick={sidebars.retry}>
								{t`Retry`}
							</Button>
						}
					/>
				)}
				<div ref={toolbarRef} className="flex items-center justify-between gap-3">
					<Tabs
						variant="segmented"
						value={tab}
						onValueChange={(next) =>
							void navigate({
								to: "/settings/sidebars",
								search: next === "editor" ? { tab: "editor" } : {},
								replace: true,
							})
						}
						tabs={[
							{ value: "navigation", label: t`Navigation` },
							{ value: "editor", label: t`Editor sidebar` },
						]}
					/>
					<Button
						variant="ghost"
						size="sm"
						icon={<ArrowCounterClockwise />}
						disabled={disabled || !sidebars.customized[scope]}
						onClick={reset}
						aria-label={scope === "nav" ? t`Reset navigation` : t`Reset editor sidebar`}
					>
						{t`Reset`}
					</Button>
				</div>
				<p className="text-sm text-kumo-subtle">
					{scope === "nav"
						? t`Turn off pages you don't use, and drag to reorder them within their group.`
						: t`Applies to every collection. Sections a collection doesn't use are skipped.`}
				</p>

				<div className="rounded-xl border border-kumo-line bg-kumo-base p-1">
					{scope === "nav" ? (
						sidebars.nav.map((group) => (
							<div key={group.key} className="[&+&]:mt-2">
								{group.label && (
									<p className="px-2 pb-1 pt-2 text-sm text-kumo-subtle">{group.label}</p>
								)}
								<LayoutList
									label={group.label ?? t`Top`}
									entries={group.entries}
									disabled={disabled}
									onToggle={setVisible}
									onMove={move}
								/>
							</div>
						))
					) : (
						<LayoutList
							label={t`Editor sidebar sections`}
							entries={sidebars.editor}
							disabled={disabled}
							onToggle={setVisible}
							onMove={move}
						/>
					)}
				</div>
			</div>
		</SettingsFrame>
	);
}
