import * as en from "./locales/en/index.js";

/** Flat key-value translation map, namespaced by dot: "common.save" */
export type Translations = Record<string, string>;

/** Available namespace names, derived from the default locale barrel. */
export type Namespace = keyof typeof en;

/** Runtime array of namespace names. */
export const NAMESPACES = Object.keys(en) as Namespace[];

/** Map each namespace to its valid translation keys. */
export type TranslationKeyMap = {
	[NS in Namespace]: Extract<keyof (typeof en)[NS], string>;
};
