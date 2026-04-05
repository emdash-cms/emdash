import { Button, Input, Loader, Select } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import { MagnifyingGlass, UserPlus, Prohibit, CheckCircle } from "@phosphor-icons/react";
import * as React from "react";

import type { UserListItem } from "../../lib/api";
import { cn } from "../../lib/utils";
import { RoleBadge, ROLES } from "./RoleBadge";

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

	return (
		<div className="space-y-4">
			{/* Header */}
			<div className="flex items-center justify-between">
				<h1 className="text-2xl font-bold">{t`Users`}</h1>
				<Button onClick={onInviteUser} icon={<UserPlus />}>
					{t`Invite User`}
				</Button>
			</div>

			{/* Filters */}
			<div className="flex gap-4">
				<div className="relative flex-1 max-w-sm">
					<MagnifyingGlass
						className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-kumo-subtle"
						aria-hidden="true"
					/>
					<Input
						type="search"
						placeholder={t`Search by name or email...`}
						className="pl-10"
						value={searchQuery}
						onChange={(e) => onSearchChange(e.target.value)}
						aria-label={t`Search users`}
					/>
				</div>
				<Select
					value={roleFilter?.toString() ?? "all"}
					onValueChange={(value) =>
						onRoleFilterChange(value === "all" || value === null ? undefined : parseInt(value, 10))
					}
					items={{
						all: t`All roles`,
						...Object.fromEntries(ROLES.map((r) => [r.value.toString(), r.label])),
					}}
					aria-label={t`Filter by role`}
				>
					<Select.Option value="all">{t`All roles`}</Select.Option>
					{ROLES.map((role) => (
						<Select.Option key={role.value} value={role.value.toString()}>
							{role.label}
						</Select.Option>
					))}
				</Select>
			</div>

			{/* Table */}
			<div className="rounded-md border overflow-x-auto">
				<table className="w-full">
					<thead>
						<tr className="border-b bg-kumo-tint/50">
							<th scope="col" className="px-4 py-3 text-left text-sm font-medium">
								{t`User`}
							</th>
							<th scope="col" className="px-4 py-3 text-left text-sm font-medium">
								{t`Role`}
							</th>
							<th scope="col" className="px-4 py-3 text-left text-sm font-medium">
								{t`Status`}
							</th>
							<th scope="col" className="px-4 py-3 text-left text-sm font-medium">
								{t`Last Login`}
							</th>
							<th scope="col" className="px-4 py-3 text-left text-sm font-medium">
								{t`Passkeys`}
							</th>
						</tr>
					</thead>
					<tbody>
						{users.length === 0 && !isLoading ? (
							<tr>
								<td colSpan={5} className="px-4 py-8 text-center text-kumo-subtle">
									{searchQuery || roleFilter !== undefined ? (
										<>
											{t`No users found matching your filters.`}{" "}
											<button
												className="text-kumo-brand underline"
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
											<button className="text-kumo-brand underline" onClick={onInviteUser}>
												{t`Invite your first team member`}
											</button>
										</>
									)}
								</td>
							</tr>
						) : (
							users.map((user) => (
								<UserListRow key={user.id} user={user} onSelect={() => onSelectUser(user.id)} />
							))
						)}
						{isLoading && (
							<tr>
								<td colSpan={5} className="px-4 py-4">
									<div className="flex items-center justify-center gap-2 text-kumo-subtle">
										<Loader size="sm" />
										{t`Loading...`}
									</div>
								</td>
							</tr>
						)}
					</tbody>
				</table>
			</div>

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
	const { t } = useLingui();
	const displayName = user.name || user.email;
	const lastLogin = user.lastLogin ? new Date(user.lastLogin).toLocaleDateString() : t`Never`;

	return (
		<tr className="border-b hover:bg-kumo-tint/25 cursor-pointer" onClick={onSelect}>
			<td className="px-4 py-3">
				<div className="flex items-center gap-3">
					{/* Avatar */}
					{user.avatarUrl ? (
						<img src={user.avatarUrl} alt="" className="h-8 w-8 rounded-full object-cover" />
					) : (
						<div className="h-8 w-8 rounded-full bg-kumo-tint flex items-center justify-center text-sm font-medium">
							{(user.name || user.email)?.[0]?.toUpperCase() ?? "?"}
						</div>
					)}
					<div>
						<div className="font-medium">{displayName}</div>
						{user.name && <div className="text-sm text-kumo-subtle">{user.email}</div>}
					</div>
				</div>
			</td>
			<td className="px-4 py-3">
				<RoleBadge role={user.role} />
			</td>
			<td className="px-4 py-3">
				{user.disabled ? (
					<span className="inline-flex items-center gap-1 text-sm text-kumo-danger">
						<Prohibit className="h-3.5 w-3.5" aria-hidden="true" />
						{t`Disabled`}
					</span>
				) : (
					<span className="inline-flex items-center gap-1 text-sm text-green-600 dark:text-green-400">
						<CheckCircle className="h-3.5 w-3.5" aria-hidden="true" />
						{t`Active`}
					</span>
				)}
			</td>
			<td className="px-4 py-3 text-sm text-kumo-subtle">{lastLogin}</td>
			<td className="px-4 py-3">
				<span className={cn("text-sm", user.credentialCount === 0 && "text-kumo-subtle")}>
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

			{/* Table skeleton */}
			<div className="rounded-md border">
				<div className="border-b bg-kumo-tint/50 px-4 py-3">
					<div className="h-4 w-full bg-kumo-tint animate-pulse rounded" />
				</div>
				{Array.from({ length: 5 }, (_, i) => (
					<div key={i} className="border-b px-4 py-4">
						<div className="h-8 w-full bg-kumo-tint animate-pulse rounded" />
					</div>
				))}
			</div>
		</div>
	);
}
