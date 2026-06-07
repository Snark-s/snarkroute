import { loadRootEnv } from "./services/env-loader";
import { startServer } from "./server";

export { buildServer } from "./app";

loadRootEnv();

if (process.env.SNARKROUTE_NO_LISTEN !== "1") {
  startServer();
}
