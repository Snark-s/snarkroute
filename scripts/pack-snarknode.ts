import { packNodePackage } from "@snarkroute/nodes";

const source = process.argv[2];
const output = process.argv[3];

if (!source) {
  console.error("Usage: pnpm snarknode:pack <node-package-folder> [output.snarknode]");
  process.exit(1);
}

try {
  const result = await packNodePackage(source, output);
  const manifest = result.manifest;
  console.log(`Packed ${manifest.id}`);
  console.log(`Title: ${manifest.title}`);
  console.log(`Author: ${manifest.author.name}`);
  console.log(`Version: ${manifest.version}`);
  console.log(`Executor: ${manifest.executor.type}${manifest.executor.runtime ? `/${manifest.executor.runtime}` : ""}`);
  console.log(`Permissions: ${JSON.stringify(manifest.permissions)}`);
  console.log(`Files: ${result.files.length}`);
  console.log(`Output: ${result.outputPath}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
