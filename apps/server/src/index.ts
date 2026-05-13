import dotenv from "dotenv";
import { startServer } from "./server";

export { buildServer } from "./app";

dotenv.config();

if (process.env.SNARKROUTE_NO_LISTEN !== "1") {
  startServer();
}
