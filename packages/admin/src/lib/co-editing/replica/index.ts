/**
 * The co-editing chunk: the replica, its connection and presence. The session loads it with
 * `import()` on the first room join, so single-editor mode never downloads it.
 */

import type { ReplicaModule } from "../session.js";
import { Replica } from "./replica.js";

export { readPeers } from "./presence.js";

export const createReplica: ReplicaModule["createReplica"] = (options) => new Replica(options);
