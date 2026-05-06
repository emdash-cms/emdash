/**
 * Menu List component
 *
 * Displays all menus with ability to create, edit, and delete.
 */

import { Button, Dialog, Input, Toast, buttonVariants } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import { Plus, Pencil, Trash, List as ListIcon } from "@phosphor-icons/react";
import { X } from "@phosphor-icons/react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import * as React from "react";

import { fetchMenus, createMenu, deleteMenu } from "../lib/api";
import { fetchManifest } from "../lib/api/client.js";
import { ConfirmDialog } from "./ConfirmDialog.js";
import { DialogError, getMutationError } from "./DialogError.js";
import { LocaleSwitcher, useI18nConfig } from "./LocaleSwitcher.js";

export function MenuList() {
	const { t } = useLingui();
	const queryClient = useQueryClient();
	const navigate = useNavigate();
	const toastManager = Toast.useToastManager();
	const [isCreateOpen, setIsCreateOpen] = React.useState(false);
	const [deleteMenuName, setDeleteMenuName] = React.useState<string | null>(null);
	const [createError, setCreateError] = React.useState<string | null>(null);

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
		onError: (error: Error) => {
			setCreateError(error.message);
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

	const handleCreate = (e: React.FormEvent<HTMLFormElement>) => {
		e.preventDefault();
		setCreateError(null);
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
			<div className="flex items-center justify-between gap-4 flex-wrap">
				<div>
					<h1 className="text-3xl font-bold">{t`Menus`}</h1>
					<p className="text-kumo-subtle">{t`Manage navigation menus for your site`}</p>
				</div>
				<div className="flex items-center gap-2">
					{i18n && activeLocale ? (
						<LocaleSwitcher
							locales={i18n.locales}
							defaultLocale={i18n.defaultLocale}
							value={activeLocale}
							onChange={setActiveLocale}
						/>
					) : null}
				</div>
				<Dialog.Root
					open={isCreateOpen}
					onOpenChange={(open) => {
						setIsCreateOpen(open);
						if (!open) setCreateError(null);
					}}
				>
					<Dialog.Trigger
						render={(props) => (
							<Button {...props} icon={<Plus />}>
								{t`Create Menu`}
							</Button>
						)}
					/>
					<Dialog className="p-6" size="lg">
						<div className="flex items-start justify-between gap-4 mb-4">
							<Dialog.Title className="text-lg font-semibold leading-none tracking-tight">
								{t`Create New Menu`}
							</Dialog.Title>
							<Dialog.Close
								aria-label={t`Close`}
								render={(props) => (
									<Button
										{...props}
										variant="ghost"
										shape="square"
										aria-label={t`Close`}
										className="absolute end-4 top-4"
									>
										<X className="h-4 w-4" />
										<span className="sr-only">{t`Close`}</span>
									</Button>
								)}
							/>
						</div>
						<form onSubmit={handleCreate} className="space-y-4">
							<div>
								<Input
									label={t`Name`}
									name="name"
									required
									placeholder="primary"
									pattern="[a-z0-9\-]+"
									title={t`Only lowercase letters, numbers, and hyphens`}
								/>
								<p className="text-sm text-kumo-subtle mt-1">
									{t`URL-friendly identifier (e.g., "primary", "footer")`}
								</p>
							</div>
							<div>
								<Input label={t`Label`} name="label" required placeholder={t`Primary Navigation`} />
								<p className="text-sm text-kumo-subtle mt-1">{t`Display name for admin interface`}</p>
							</div>
							<DialogError message={createError || getMutationError(createMutation.error)} />
							<div className="flex justify-end gap-2">
								<Button type="button" variant="outline" onClick={() => setIsCreateOpen(false)}>
									{t`Cancel`}
								</Button>
								<Button type="submit" disabled={createMutation.isPending}>
									{createMutation.isPending ? t`Creating...` : t`Create`}
								</Button>
							</div>
						</form>
					</Dialog>
				</Dialog.Root>
			</div>

			{!menus || menus.length === 0 ? (
				<div className="border rounded-lg p-12 text-center">
					<ListIcon className="mx-auto h-12 w-12 text-kumo-subtle mb-4" />
					<h3 className="text-lg font-semibold mb-2">{t`No menus yet`}</h3>
					<p className="text-kumo-subtle mb-4">{t`Create your first navigation menu to get started`}</p>
					<Button icon={<Plus />} onClick={() => setIsCreateOpen(true)}>
						{t`Create Menu`}
					</Button>
				</div>
			) : (
				<div className="grid gap-4">
					{menus.map((menu) => (
						<div
							key={menu.id}
							className="border rounded-lg p-6 flex items-center justify-between hover:bg-kumo-tint transition-colors"
						>
							<Link
								to="/menus/$name"
								params={{ name: menu.name }}
								search={{ locale: menu.locale }}
								className="flex-1"
							>
								<div>
									<h3 className="font-semibold text-lg">
										{menu.label}
										{i18n ? (
											<span className="ms-2 text-xs font-mono uppercase text-kumo-subtle">
												{menu.locale}
											</span>
										) : null}
									</h3>
									<p className="text-sm text-kumo-subtle">
										{menu.name} • {menu.itemCount || 0} items
									</p>
								</div>
							</Link>
							<div className="flex gap-2">
								<Link
									to="/menus/$name"
									params={{ name: menu.name }}
									search={{ locale: menu.locale }}
									className={buttonVariants({ variant: "outline", size: "sm" })}
								>
									<Pencil className="h-4 w-4 me-2" />
									{t`Edit`}
								</Link>
								<Button
									variant="outline"
									size="sm"
									onClick={() => setDeleteMenuName(menu.name)}
									aria-label={t`Delete ${menu.name} menu`}
								>
									<Trash className="h-4 w-4" />
								</Button>
							</div>
						</div>
					))}
				</div>
			)}

			<ConfirmDialog
				open={deleteMenuName !== null}
				onClose={() => {
					setDeleteMenuName(null);
					deleteMutation.reset();
				}}
				title={t`Delete Menu`}
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
