/**
 * Menu List component
 *
 * Displays all menus with ability to create, edit, and delete.
 */

import { Button, Dialog, Input, LayerCard, Toast } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import { Plus, X } from "@phosphor-icons/react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import * as React from "react";

import { fetchMenus, createMenu, deleteMenu } from "../lib/api";
import { fetchManifest } from "../lib/api/client.js";
import { ADMIN_NAV_ICONS } from "./admin-navigation-icons.js";
import { ConfirmDialog } from "./ConfirmDialog.js";
import { DialogError, getMutationError } from "./DialogError.js";
import { LocaleSwitcher, useI18nConfig } from "./LocaleSwitcher.js";
import { MenuCard } from "./MenuCard.js";

export function MenuList() {
	const { t } = useLingui();
	const queryClient = useQueryClient();
	const navigate = useNavigate();
	const toastManager = Toast.useToastManager();
	const [isCreateOpen, setIsCreateOpen] = React.useState(false);
	const [deleteMenuName, setDeleteMenuName] = React.useState<string | null>(null);

	const { data: manifest } = useQuery({
		queryKey: ["manifest"],
		queryFn: fetchManifest,
	});
	const i18n = useI18nConfig(manifest);
	const [activeLocale, setActiveLocale] = React.useState<string | undefined>(undefined);
	React.useEffect(() => {
		if (i18n && !activeLocale) setActiveLocale(i18n.defaultLocale);
	}, [i18n, activeLocale]);

	const { data: menus, isLoading } = useQuery({
		queryKey: ["menus", activeLocale],
		queryFn: () => fetchMenus({ locale: activeLocale }),
	});

	const createMutation = useMutation({
		mutationFn: createMenu,
		onSuccess: (menu) => {
			void queryClient.invalidateQueries({ queryKey: ["menus"] });
			setIsCreateOpen(false);
			toastManager.add({
				title: t`Menu created`,
				description: t`Menu "${menu.label}" has been created.`,
			});
			void navigate({
				to: "/menus/$name",
				params: { name: menu.name },
				search: { locale: menu.locale },
			});
		},
	});

	const deleteMutation = useMutation({
		mutationFn: (name: string) => deleteMenu(name, { locale: activeLocale }),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: ["menus"] });
			setDeleteMenuName(null);
			toastManager.add({
				title: t`Menu deleted`,
				description: t`The menu has been deleted.`,
			});
		},
	});

	const handleCreateOpenChange = (open: boolean) => {
		setIsCreateOpen(open);
		if (!createMutation.isPending) createMutation.reset();
	};

	const handleCreate = (e: React.FormEvent<HTMLFormElement>) => {
		e.preventDefault();
		const formData = new FormData(e.currentTarget);
		const nameVal = formData.get("name");
		const name = typeof nameVal === "string" ? nameVal : "";
		const labelVal = formData.get("label");
		const label = typeof labelVal === "string" ? labelVal : "";
		createMutation.mutate({ name, label, locale: activeLocale });
	};

	if (isLoading) {
		return (
			<div className="flex items-center justify-center h-64">
				<div className="text-kumo-subtle">{t`Loading menus...`}</div>
			</div>
		);
	}

	return (
		<div className="space-y-6">
			<header className="flex flex-col gap-4 border-b border-kumo-line pb-4 sm:flex-row sm:items-start sm:justify-between">
				<div className="min-w-0">
					<h1 className="text-2xl font-semibold leading-tight">{t`Menus`}</h1>
					<p className="mt-1 text-sm leading-5 text-pretty text-kumo-subtle">
						{t`Manage navigation menus for your site`}
					</p>
				</div>
				<div className="flex flex-wrap items-center gap-2">
					{i18n && activeLocale ? (
						<LocaleSwitcher
							locales={i18n.locales}
							defaultLocale={i18n.defaultLocale}
							value={activeLocale}
							onChange={setActiveLocale}
						/>
					) : null}
					<Dialog.Root open={isCreateOpen} onOpenChange={handleCreateOpenChange}>
						<Dialog.Trigger
							render={(props) => (
								<Button {...props} icon={<Plus aria-hidden="true" />}>
									{t`Create Menu`}
								</Button>
							)}
						/>
						<Dialog
							className="flex max-h-[calc(100dvh-2rem)] min-w-0 w-[calc(100vw-2rem)] flex-col overflow-hidden p-0 sm:w-[32rem]"
							size="lg"
						>
							<form onSubmit={handleCreate} className="flex min-h-0 flex-1 flex-col">
								<div className="flex shrink-0 items-start justify-between gap-4 border-b border-kumo-line px-6 py-5">
									<div className="min-w-0">
										<Dialog.Title className="text-lg font-semibold leading-6">
											{t`Create menu`}
										</Dialog.Title>
										<Dialog.Description className="mt-1 text-sm leading-5 text-kumo-subtle">
											{t`Give this navigation a label and a site identifier.`}
										</Dialog.Description>
									</div>
									<Dialog.Close
										render={(props) => (
											<Button
												{...props}
												type="button"
												variant="ghost"
												shape="square"
												icon={<X className="size-4" aria-hidden="true" />}
												aria-label={t`Close`}
											/>
										)}
									/>
								</div>
								<div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 py-5">
									<div>
										<Input
											label={t`Label`}
											name="label"
											required
											placeholder={t`Primary navigation`}
										/>
										<p className="mt-1 text-sm text-kumo-subtle">{t`Shown in the admin menu list.`}</p>
									</div>
									<div>
										<Input
											label={t`Name`}
											name="name"
											dir="ltr"
											required
											placeholder={t`primary`}
											pattern="[a-z0-9\-]+"
											title={t`Only lowercase letters, numbers, and hyphens`}
										/>
										<p className="mt-1 text-sm text-kumo-subtle">
											{t`Stable identifier for your site, such as primary or footer.`}
										</p>
									</div>
									<DialogError message={getMutationError(createMutation.error)} />
								</div>
								<div className="flex shrink-0 justify-end gap-2 border-t border-kumo-line px-6 py-4">
									<Button
										type="button"
										variant="secondary"
										onClick={() => handleCreateOpenChange(false)}
									>
										{t`Cancel`}
									</Button>
									<Button type="submit" variant="primary" disabled={createMutation.isPending}>
										{createMutation.isPending ? t`Creating...` : t`Create`}
									</Button>
								</div>
							</form>
						</Dialog>
					</Dialog.Root>
				</div>
			</header>

			{!menus || menus.length === 0 ? (
				<LayerCard className="flex flex-col items-center px-6 py-16 text-center">
					<span className="mb-5 flex size-14 items-center justify-center rounded-xl bg-kumo-tint text-kumo-brand">
						<ADMIN_NAV_ICONS.menus size={28} aria-hidden="true" />
					</span>
					<h2 className="text-lg font-semibold leading-6">{t`No menus yet`}</h2>
					<p className="mt-2 max-w-sm text-sm leading-5 text-pretty text-kumo-subtle">
						{t`Create your first navigation menu to get started`}
					</p>
					<Button
						className="mt-5"
						icon={<Plus aria-hidden="true" />}
						onClick={() => handleCreateOpenChange(true)}
					>
						{t`Create Menu`}
					</Button>
				</LayerCard>
			) : (
				<ul className="grid gap-4 lg:grid-cols-2">
					{menus.map((menu) => (
						<li key={menu.id}>
							<MenuCard
								menu={menu}
								showLocale={!!i18n}
								onDelete={() => setDeleteMenuName(menu.name)}
							/>
						</li>
					))}
				</ul>
			)}

			<ConfirmDialog
				open={deleteMenuName !== null}
				onClose={() => {
					setDeleteMenuName(null);
					deleteMutation.reset();
				}}
				title={t`Delete menu`}
				description={t`Are you sure you want to delete this menu? This will also delete all menu items. This action cannot be undone.`}
				confirmLabel={t`Delete`}
				pendingLabel={t`Deleting...`}
				isPending={deleteMutation.isPending}
				error={deleteMutation.error}
				onConfirm={() => deleteMenuName && deleteMutation.mutate(deleteMenuName)}
			/>
		</div>
	);
}
