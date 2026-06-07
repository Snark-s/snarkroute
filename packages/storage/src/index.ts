import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
export { CloudPostgresStorageAdapter, runCloudPostgresMigrations, type CloudAdminUserListing, type CloudRouteRecord, type CloudRouteSummary, type CloudStorageUser, type SaveRouteInput, type SaveRouteVersionInput } from "./cloud-postgres";

export interface LocalRunStorage {
  rootDirectory: string;
  createRunDirectory: (runId: string) => Promise<string>;
  writeRunFile: (runId: string, filename: string, data: string | Buffer) => Promise<string>;
  readRunResult: (runId: string) => Promise<unknown>;
}

export function createLocalRunStorage(rootDirectory = join(process.cwd(), "data", "runs")): LocalRunStorage {
  return {
    rootDirectory,
    async createRunDirectory(runId) {
      const directory = join(rootDirectory, runId);
      await mkdir(directory, { recursive: true });
      return directory;
    },
    async writeRunFile(runId, filename, data) {
      const directory = await this.createRunDirectory(runId);
      const path = join(directory, filename);
      await writeFile(path, data);
      return path;
    },
    async readRunResult(runId) {
      return JSON.parse(await readFile(join(rootDirectory, runId, "run.json"), "utf8"));
    }
  };
}
