import dotenv from "dotenv";
import { envPath } from "../server-paths";

let loaded = false;

export function loadRootEnv(): void {
  if (loaded) return;
  dotenv.config({ path: envPath, override: false });
  loaded = true;
}
