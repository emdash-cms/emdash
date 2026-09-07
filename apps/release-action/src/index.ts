import { executeAction } from "./run.js";
import { DefaultActionRuntime } from "./runtime.js";

await executeAction(new DefaultActionRuntime());
