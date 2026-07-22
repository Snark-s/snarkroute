import { lstat, unlink } from "node:fs/promises";
import { resolve } from "node:path";
const target = resolve(process.env.APPDATA ?? "", "Adobe", "CEP", "extensions", "com.snarkroute.aftereffects");
try { const stat = await lstat(target); if (!stat.isSymbolicLink()) throw new Error(`Refusing to remove non-link path: ${target}`); await unlink(target); console.log(`Removed development junction: ${target}`); } catch (error) { if (error?.code === "ENOENT") console.log("Extension is not installed."); else throw error; }
