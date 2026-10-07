import { loadRootEnv } from "./apps/server/src/services/env-loader.ts";
import { createReplicateClient } from "./packages/adapters/replicate/src/index.ts";

loadRootEnv();
const client=createReplicateClient();
const p=await client.getPrediction("5sfz1brm6xrn80d11ratphhvt8");
console.log(JSON.stringify({
  id:p?.id,
  status:p?.status,
  model:p?.model,
  version:p?.version,
  input:p?.input,
  output:p?.output,
  error:p?.error,
  metrics:p?.metrics,
  urls:p?.urls
},null,2));
