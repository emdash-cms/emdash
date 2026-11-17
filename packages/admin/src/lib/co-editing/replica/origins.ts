/** The origin of every update a replica applies from its room. */
export const REMOTE = Symbol("co-editing remote");

/** The origin of form writes through `fields.set`. */
export const FORM = Symbol("co-editing form");
