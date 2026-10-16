import { createContext } from "react";

// An empty form attribute keeps plugin controls out of a surrounding editor form.
export const FormOwnerContext = createContext<string | undefined>(undefined);
