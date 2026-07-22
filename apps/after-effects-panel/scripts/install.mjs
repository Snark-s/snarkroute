import { lstat, mkdir, symlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
const source = resolve(import.meta.dirname, "..");
const target = resolve(process.env.APPDATA ?? "", "Adobe", "CEP", "extensions", "com.snarkroute.aftereffects");
await mkdir(dirname(target), { recursive: true });
try { const stat = await lstat(target); if (!stat.isSymbolicLink()) throw new Error(`Refusing to replace non-link path: ${target}`); console.log(`Already installed: ${target}`); } catch (error) { if (error?.code !== "ENOENT") throw error; await symlink(source, target, "junction"); console.log(`Installed development junction: ${target}`); }
