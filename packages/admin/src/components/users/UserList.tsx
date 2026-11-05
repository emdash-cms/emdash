import { Button, Loader, Select } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import { UserPlus, Prohibit, CheckCircle } from "@phosphor-icons/react";
import * as React from "react";

import type { UserListItem } from "../../lib/api";
import { cn, formatDate } from "../../lib/utils.js";
import {
	DataTable,
	DataTableMessage,
	RowMeta,
	RowTitleButton,
	secondaryColumn,
	tertiaryColumn,
} from "../DataTable.js";
import { TableToolbar, TableToolbarSearch } from "../TableToolbar.js";
import { RoleBadge } from "./RoleBadge";
import { useRolesConfig } from "./useRolesConfig.js";

export interface UserListProps {
	users: UserListItem[];
	isLoading?: boolean;
	hasMore?: boolean;
	searchQuery: string;
	roleFilter: number | undefined;
	onSearchChange: (query: string) => void;
	onRoleFilterChange: (role: number | undefined) => void;
	onSelectUser: (id: string) => void;
	onInviteUser: () => void;
	onLoadMore?: () => void;
}

/**
 * User list component with search, filter, and table display
 */
export function UserList({
	users,
	isLoading,
	hasMore,
	searchQuery,
	roleFilter,
	onSearchChange,
	onRoleFilterChange,
	onSelectUser,
	onInviteUser,
	onLoadMore,
}: UserListProps) {
	const { t } = useLingui();
	const { roles, roleLabels } = useRolesConfig();
	const roleFilterSelectItems = React.useMemo(
		() => ({ all: t`All roles`, ...roleLabels }),
		[t, roleLabels],
	);
	const roleFilterSelectOptions = React.useMemo(
		() => [{ value: "all", label: t`All roles` }, ...roles],
		[t, roles],
	);

	return (
		<div className="space-y-4">
			{/* Header */}
			<div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
				<h1 className="min-w-0 text-2xl font-semibold leading-tight">{t`Users`}</h1>
				<Button onClick={onInviteUser} icon={<UserPlus />}>
					{t`Invite User`}
				</Button>
			</div>

			<TableToolbar>
				<TableToolbarSearch
					placeholder={t`Search by name or email...`}
					value={searchQuery}
					onChange={(e) => onSearchChange(e.target.value)}
					aria-label={t`Search users`}
				/>
				<Select
					size="sm"
					value={roleFilter?.toString() ?? "all"}
					onValueChange={(value) =>
						onRoleFilterChange(value === "all" || value === null ? undefined : parseInt(value, 10))
					}
					items={roleFilterSelectItems}
					aria-label={t`Filter by role`}
				>
					{roleFilterSelectOptions.map((option) => (
						<Select.Option key={option.value} value={option.value}>
							{option.label}
						</Select.Option>
					))}
				</Select>
			</TableToolbar>

			<DataTable>
				<thead>
					<tr>
						<th scope="col">{t`User`}</th>
						<th scope="col" {...secondaryColumn}>
							{t`Role`}
						</th>
						<th scope="col" {...secondaryColumn}>
							{t`Status`}
						</th>
						<th scope="col" {...tertiaryColumn}>
							{t`Last Login`}
						</th>
						<th scope="col" {...tertiaryColumn}>
							{t`Passkeys`}
						</th>
					</tr>
				</thead>
				<tbody>
					{users.length === 0 && !isLoading ? (
						<DataTableMessage colSpan={5}>
							{searchQuery || roleFilter !== undefined ? (
								<>
									{t`No users found matching your filters.`}{" "}
									<button
										type="button"
										className="text-kumo-link underline"
										onClick={() => {
											onSearchChange("");
											onRoleFilterChange(undefined);
										}}
									>
										{t`Clear filters`}
									</button>
								</>
							) : (
								<>
									{t`No users yet.`}{" "}
									<button type="button" className="text-kumo-link underline" onClick={onInviteUser}>
										{t`Invite your first team member`}
									</button>
								</>
							)}
						</DataTableMessage>
					) : (
						users.map((user) => (
							<UserListRow key={user.id} user={user} onSelect={() => onSelectUser(user.id)} />
						))
					)}
					{isLoading && (
						<DataTableMessage colSpan={5}>
							<div className="flex items-center justify-center gap-2">
								<Loader size="sm" />
								{t`Loading...`}
							</div>
						</DataTableMessage>
					)}
				</tbody>
			</DataTable>

			{/* Load more */}
			{hasMore && !isLoading && (
				<div className="flex justify-center">
					<Button variant="outline" onClick={onLoadMore}>
						{t`Load More`}
					</Button>
				</div>
			)}
		</div>
	);
}

interface UserListRowProps {
	user: UserListItem;
	onSelect: () => void;
}

function UserListRow({ user, onSelect }: UserListRowProps) {
	const displayName = user.name || user.email;
	const { t, i18n } = useLingui();
	const lastLogin = user.lastLogin ? formatDate(user.lastLogin, i18n.locale) : t`Never`;
	const roleBadge = <RoleBadge role={user.role} />;
	const disabledStatus = (
		<span className="inline-flex items-center gap-1 text-kumo-danger">
			<Prohibit className="h-3.5 w-3.5" aria-hidden="true" />
			{t`Disabled`}
		</span>
	);

	return (
		<tr>
			<td>
				<div className="flex items-center gap-3">
					{/* Avatar */}
					{user.avatarUrl ? (
						<img
							src={user.avatarUrl}
							alt=""
							className="h-8 w-8 shrink-0 rounded-full object-cover"
						/>
					) : (
						<div className="h-8 w-8 shrink-0 rounded-full bg-kumo-tint flex items-center justify-center text-sm font-medium">
							{(user.name || user.email)?.[0]?.toUpperCase() ?? "?"}
						</div>
					)}
					<div className="wrap-anywhere">
						<RowTitleButton dir="auto" onClick={onSelect}>
							{displayName}
						</RowTitleButton>
						{user.name && (
							<div className="text-sm text-kumo-subtle">
								<bdi dir="ltr">{user.email}</bdi>
							</div>
						)}
						<RowMeta>
							{roleBadge}
							{user.disabled && disabledStatus}
						</RowMeta>
					</div>
				</div>
			</td>
			<td {...secondaryColumn}>{roleBadge}</td>
			<td {...secondaryColumn}>
				{user.disabled ? (
					disabledStatus
				) : (
					<span className="inline-flex items-center gap-1 text-kumo-success">
						<CheckCircle className="h-3.5 w-3.5" aria-hidden="true" />
						{t`Active`}
					</span>
				)}
			</td>
			<td className="whitespace-nowrap text-kumo-subtle" {...tertiaryColumn}>
				<bdi>{lastLogin}</bdi>
			</td>
			<td {...tertiaryColumn}>
				<span className={cn(user.credentialCount === 0 && "text-kumo-subtle")}>
					{user.credentialCount}
				</span>
			</td>
		</tr>
	);
}

/** Loading skeleton for user list */
export function UserListSkeleton() {
	return (
		<div className="space-y-4">
			{/* Header skeleton */}
			<div className="flex items-center justify-between">
				<div className="h-8 w-24 bg-kumo-tint animate-pulse rounded" />
				<div className="h-10 w-32 bg-kumo-tint animate-pulse rounded" />
			</div>

			{/* Filters skeleton */}
			<div className="flex gap-4">
				<div className="h-10 w-64 bg-kumo-tint animate-pulse rounded" />
				<div className="h-10 w-44 bg-kumo-tint animate-pulse rounded" />
			</div>

			<DataTable aria-hidden="true">
				<thead>
					<tr>
						<th colSpan={5}>
							<div className="h-5 w-full animate-pulse rounded bg-kumo-tint" />
						</th>
					</tr>
				</thead>
				<tbody>
					{Array.from({ length: 5 }, (_, i) => (
						<tr key={i}>
							<td colSpan={5}>
								<div className="h-9 w-full animate-pulse rounded bg-kumo-tint" />
							</td>
						</tr>
					))}
				</tbody>
			</DataTable>
		</div>
	);
}
