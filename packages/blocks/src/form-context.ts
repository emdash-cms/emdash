import { createContext } from "react";

// Empty form ownership detaches supported native controls from the editor.
// Kumo's Checkbox.Item, Radio.Item and Switch do not forward form to their hidden
// inputs; these Block Kit elements do not expose native validation constraints.
export const FormOwnerContext = createContext<string | undefined>(undefined);
