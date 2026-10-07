import { createReplicate3DNodeRunner } from "./packages/adapters/replicate/src/index.ts";
import { mkdir } from "node:fs/promises";
const out="Y:\\Приложения\\Jabberwock Mixar Local\\trellis-recovery-test";
await mkdir(out,{recursive:true});
const glb="https://replicate.delivery/yhqm/rUfZYfb8qFogiELQTLy8dtSu8MUv9JNfb543e7CfHUMlBoj6C/output.glb";
const image="https://api.replicate.com/v1/files/N2FmNGYxNmUtYzcyMy00MWUzLWI1NmYtMzAwYTM5ZTIwOTVl.png";
const fakeFetch=async (url,init={})=>{
  const u=String(url);
  if(u.includes("/models/firtoz/trellis")){
    return new Response(JSON.stringify({latest_version:{id:"e8f6c45206993f297372f5436b90350817bd9b4a0d52d2a76df50c1c8afa2b3c"}}),{status:200,headers:{"content-type":"application/json"}});
  }
  if(u.endsWith("/predictions")){
    return new Response(JSON.stringify({
      id:"5sfz1brm6xrn80d11ratphhvt8",
      status:"succeeded",
      output:{model_file:glb,color_video:null,gaussian_ply:null,normal_video:null},
      metrics:{predict_time:19.400759561,total_time:19.51794406},
      urls:{web:"https://replicate.com/p/5sfz1brm6xrn80d11ratphhvt8"}
    }),{status:200,headers:{"content-type":"application/json"}});
  }
  if(u.startsWith("https://replicate.delivery/")) return fetch(u,init);
  return new Response("unexpected "+u,{status:500});
};
const runner=createReplicate3DNodeRunner({token:"test-token",fetchImpl:fakeFetch});
const result=await runner({
  node:{id:"generate",type:"ai.3d.generate",params:{}},
  params:{
    model:"firtoz/trellis",
    providerModelId:"firtoz/trellis",
    images:[image],
    texture_size:1024,
    mesh_simplify:0.95,
    generate_normal:false,
    save_gaussian_ply:false
  },
  inputs:{},
  context:{
    runId:"recovery-test",
    outputDirectory:out,
    signal:new AbortController().signal,
    reportProgress:async()=>{}
  }
});
console.log(JSON.stringify(result.output,null,2));
