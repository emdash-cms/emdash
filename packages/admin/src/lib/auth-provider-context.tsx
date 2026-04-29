/**
 * Auth Provider Context
 *
 * Provides pluggable auth provider UI components (LoginButton, LoginForm, SetupStep)
 * to the admin UI via React context. Auth providers are registered in astro.config.ts
 * and their admin components are bundled via the virtual:emdash/auth-providers module.
 */

import * as React from "react";
import { createContext, useContext } from "react";

/** Shape of a single auth provider's admin exports */
export interface AuthProviderModule {
	id: string;
	label: string;
	/** Compact button for the login page (icon + label) */
	LoginButton?: React.ComponentType;
	/** Full form if the provider needs custom input (e.g., handle field) */
	LoginForm?: React.ComponentType;
	/** Component for the setup wizard admin creation step */
	SetupStep?: React.ComponentType<{ onComplete: () => void }>;
}

/** All auth provider modules keyed by provider ID */
export type AuthProviders = Record<string, AuthProviderModule>;

const AuthProviderContext = createContext<AuthProviders>({});

export interface AuthProviderContextProps {
	children: React.ReactNode;
	authProviders: AuthProviders;
}

/**
 * Provider that makes auth provider components available to all descendants
 */
export function AuthProviderProvider({ children, authProviders }: AuthProviderContextProps) {
	return (
		<AuthProviderContext.Provider value={authProviders}>{children}</AuthProviderContext.Provider>
	);
}

/**
 * Get all auth provider modules
 */
export function useAuthProviders(): AuthProviders {
	return useContext(AuthProviderContext);
}

/**
 * Get auth providers as an ordered array (buttons first, then forms)
 */
export function useAuthProviderList(): AuthProviderModule[] {
	const providers = useContext(AuthProviderContext);
	const list = Object.values(providers);
	// Sort: providers with only LoginButton first (compact), then those with LoginForm
	return list.toSorted((a, b) => {
		const aHasForm = a.LoginForm ? 1 : 0;
		const bHasForm = b.LoginForm ? 1 : 0;
		return aHasForm - bHasForm;
	});
}
