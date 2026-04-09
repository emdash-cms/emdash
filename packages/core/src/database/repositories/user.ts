import type { Kysely, Selectable, Updateable } from "kysely";
import { ulid } from "ulidx";

import type { Database, UserTable } from "../types.js";
import { encodeCursor, decodeCursor, type FindManyResult } from "./types.js";

type UserRow = Selectable<UserTable>;

/**
 * Valid role levels matching the database schema.
 * 10=subscriber, 20=contributor, 30=author, 40=editor, 50=admin
 */
export type UserRole = 10 | 20 | 30 | 40 | 50;

/** String role names for convenience APIs */
export type UserRoleName = "subscriber" | "contributor" | "author" | "editor" | "admin";

export interface User {
	id: string;
	email: string;
	name: string | null;
	role: UserRole;
	avatarUrl: string | null;
	emailVerified: boolean;
	data: Record<string, unknown> | null;
	createdAt: string;
}

export interface CreateUserInput {
	email: string;
	name?: string;
	role?: UserRole | UserRoleName;
	avatarUrl?: string;
	data?: Record<string, unknown>;
}

export interface UpdateUserInput {
	name?: string;
	role?: UserRole | UserRoleName;
	avatarUrl?: string | null;
	data?: Record<string, unknown>;
}

/**
 * User repository for CRUD operations
 */
export class UserRepository {
	constructor(private db: Kysely<Database>) {}

	/**
	 * Create a new user
	 */
	async create(input: CreateUserInput): Promise<User> {
		const id = ulid();

		const row: Omit<UserTable, "created_at" | "updated_at" | "disabled"> = {
			id,
			email: input.email.toLowerCase(),
			name: input.name ?? null,
			role: UserRepository.resolveRole(input.role ?? 10),
			avatar_url: input.avatarUrl ?? null,
			email_verified: 0,
			data: input.data ? JSON.stringify(input.data) : null,
			atproto_did: null,
		};

		await this.db.insertInto("users").values(row).execute();

		const user = await this.findById(id);
		if (!user) {
			throw new Error("Failed to create user");
		}
		return user;
	}

	/**
	 * Find user by ID
	 */
	async findById(id: string): Promise<User | null> {
		const row = await this.db
			.selectFrom("users")
			.selectAll()
			.where("id", "=", id)
			.executeTakeFirst();

		return row ? this.rowToUser(row) : null;
	}

	/**
	 * Find user by email (case-insensitive)
	 */
	async findByEmail(email: string): Promise<User | null> {
		const row = await this.db
			.selectFrom("users")
			.selectAll()
			.where("email", "=", email.toLowerCase())
			.executeTakeFirst();

		return row ? this.rowToUser(row) : null;
	}

	/**
	 * List all users with cursor-based pagination
	 */
	async findMany(
		options: {
			role?: UserRole | UserRoleName;
			limit?: number;
			cursor?: string;
		} = {},
	): Promise<FindManyResult<User>> {
		const limit = Math.min(Math.max(1, options.limit || 50), 100);

		let query = this.db
			.selectFrom("users")
			.selectAll()
			.orderBy("created_at", "desc")
			.orderBy("id", "desc")
			.limit(limit + 1);

		if (options.role !== undefined) {
			query = query.where("role", "=", UserRepository.resolveRole(options.role));
		}

		if (options.cursor) {
			const decoded = decodeCursor(options.cursor);
			if (decoded) {
				query = query.where((eb) =>
					eb.or([
						eb("created_at", "<", decoded.orderValue),
						eb.and([eb("created_at", "=", decoded.orderValue), eb("id", "<", decoded.id)]),
					]),
				);
			}
		}

		const rows = await query.execute();
		const items = rows.slice(0, limit).map((row) => this.rowToUser(row));
		const result: FindManyResult<User> = { items };

		if (rows.length > limit && items.length > 0) {
			const last = items.at(-1)!;
			result.nextCursor = encodeCursor(last.createdAt, last.id);
		}

		return result;
	}

	/**
	 * Update a user
	 */
	async update(id: string, input: UpdateUserInput): Promise<User | null> {
		const existing = await this.findById(id);
		if (!existing) return null;

		const updates: Updateable<UserTable> = {};
		if (input.name !== undefined) updates.name = input.name;
		if (input.role !== undefined) updates.role = UserRepository.resolveRole(input.role);
		if (input.avatarUrl !== undefined) updates.avatar_url = input.avatarUrl;
		if (input.data !== undefined) updates.data = JSON.stringify(input.data);

		if (Object.keys(updates).length > 0) {
			await this.db.updateTable("users").set(updates).where("id", "=", id).execute();
		}

		return this.findById(id);
	}

	/**
	 * Delete a user
	 */
	async delete(id: string): Promise<boolean> {
		const result = await this.db.deleteFrom("users").where("id", "=", id).executeTakeFirst();

		return (result.numDeletedRows ?? 0) > 0;
	}

	/**
	 * Count users
	 */
	async count(role?: UserRole | UserRoleName): Promise<number> {
		let query = this.db.selectFrom("users").select((eb) => eb.fn.count("id").as("count"));

		if (role !== undefined) {
			query = query.where("role", "=", UserRepository.resolveRole(role));
		}

		const result = await query.executeTakeFirst();
		return Number(result?.count || 0);
	}

	/**
	 * Check if email exists
	 */
	async emailExists(email: string): Promise<boolean> {
		const row = await this.db
			.selectFrom("users")
			.select("id")
			.where("email", "=", email.toLowerCase())
			.executeTakeFirst();

		return !!row;
	}

	/**
	 * Convert database row to User object
	 */
	private rowToUser(row: UserRow): User {
		return {
			id: row.id,
			email: row.email,
			name: row.name,
			role: UserRepository.toRole(row.role),
			avatarUrl: row.avatar_url,
			emailVerified: row.email_verified === 1,
			data: row.data ? JSON.parse(row.data) : null,
			createdAt: row.created_at,
		};
	}

	/** Map of role name strings to numeric levels */
	private static readonly ROLE_NAME_TO_LEVEL: Record<UserRoleName, UserRole> = {
		subscriber: 10,
		contributor: 20,
		author: 30,
		editor: 40,
		admin: 50,
	};

	/** Valid numeric role levels */
	private static readonly VALID_LEVELS = new Set<number>([10, 20, 30, 40, 50]);

	/**
	 * Resolve a role name or number to a valid numeric UserRole.
	 * Accepts both string names ("admin") and numeric levels (50).
	 */
	static resolveRole(role: UserRole | UserRoleName): UserRole {
		if (typeof role === "string") {
			const level = UserRepository.ROLE_NAME_TO_LEVEL[role];
			if (level === undefined) {
				throw new Error(`Invalid role name: ${role}`);
			}
			return level;
		}
		if (!UserRepository.VALID_LEVELS.has(role)) {
			throw new Error(`Invalid role level: ${role}`);
		}
		return role;
	}

	/**
	 * Convert a raw DB integer to a typed UserRole.
	 * Falls back to subscriber (10) for unknown values.
	 */
	private static toRole(level: number): UserRole {
		if (UserRepository.VALID_LEVELS.has(level)) return level as UserRole;
		return 10;
	}
}
