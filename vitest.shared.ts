import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDirectory = dirname(fileURLToPath(import.meta.url));

export const snarkrouteAliases = {
  "@snarkroute/protocol": resolve(rootDirectory, "packages/protocol/src/index.ts"),
  "@snarkroute/executor": resolve(rootDirectory, "packages/executor/src/index.ts"),
  "@snarkroute/storage": resolve(rootDirectory, "packages/storage/src/index.ts"),
  "@snarkroute/nodes": resolve(rootDirectory, "packages/nodes/src/index.ts"),
  "@snarkroute/replicate": resolve(rootDirectory, "packages/adapters/replicate/src/index.ts")
};
