import {afterEach,expect,it,vi} from "vitest";
import Fastify from "fastify";
import {registerSystemRoutes} from "../src/routes/system";
afterEach(()=>{vi.unstubAllGlobals();vi.unstubAllEnvs();vi.restoreAllMocks();});
it.each([
  ["system app stop", "/api/system/apps/beamish/stop", "POST"],
  ["model exposure write", "/api/system/model-exposure", "PUT"],
  ["Secretary answer", "/api/system/secretary/questions/1/answer", "POST"],
  ["Secretary inbox read", "/api/system/secretary/questions", "GET"],
  ["launcher restart", "/api/system/restart", "POST"],
  ["SnarkBridge policy read", "/api/system/snarkbridge/policy", "GET"],
  ["SnarkBridge client level", "/api/system/snarkbridge/policy/clients/chatgpt", "POST"],
  ["SnarkBridge pending read", "/api/system/snarkbridge/pending", "GET"],
  ["SnarkBridge approval", "/api/system/snarkbridge/pending/"+"a".repeat(64)+"/approve", "POST"],
] as const)("protects %s with owner credentials, not loopback or browser headers",async(_label,url,method)=>{
  vi.stubEnv("APP_MODE","local");vi.stubEnv("SNARKROUTE_LAUNCHER_TOKEN","test-owner");
  const fetcher=vi.fn(async()=>new Response(JSON.stringify({ok:true,service:"snarkroute-launcher-control",apiPort:4317,managed:true})));
  vi.stubGlobal("fetch",fetcher);const app=Fastify();await registerSystemRoutes(app);
  try{
    const body=method==="GET"?{}:{payload:{}};
    expect((await app.inject({method,url,...body})).statusCode).toBe(401);
    expect((await app.inject({method,url,headers:{"x-snarkroute-agent-token":"agent-token"},...body})).statusCode).toBe(403);
    expect((await app.inject({method,url,headers:{origin:"http://localhost:5172",referer:"http://localhost:5172/system",host:"localhost:4317"},...body})).statusCode).toBe(401);
    expect([401,403]).not.toContain((await app.inject({method,url,headers:{authorization:"Bearer test-owner"},...body})).statusCode);
  }finally{await app.close();}
});
it("keeps ordinary system reads open to the Workshop without credentials",async()=>{
  vi.stubEnv("APP_MODE","local");vi.stubEnv("SNARKROUTE_LAUNCHER_TOKEN","test-owner");
  const app=Fastify();await registerSystemRoutes(app);
  try{expect([401,403]).not.toContain((await app.inject({method:"GET",url:"/api/system/model-exposure"})).statusCode);}
  finally{await app.close();}
});
it("leaves agent paths outside the owner guard (Factory and Tove start local runtimes under admission)",async()=>{
  vi.stubEnv("APP_MODE","local");vi.stubEnv("SNARKROUTE_LAUNCHER_TOKEN","test-owner");
  const app=Fastify();await registerSystemRoutes(app);
  try{
    const status=(await app.inject({method:"POST",url:"/api/system/local-runtimes/not-a-runtime/start",headers:{"x-snarkroute-agent-token":"agent-token"},payload:{}})).statusCode;
    expect(status).not.toBe(401);
    expect((await app.inject({method:"POST",url:"/api/system/local-runtimes/not-a-runtime/start",headers:{"x-snarkroute-agent-token":"agent-token"},payload:{}})).json()?.code).not.toBe("OWNER_ONLY");
  }finally{await app.close();}
});
it("forwards restart to the external owner and reports startup failure",async()=>{
  vi.stubEnv("APP_MODE","local");vi.stubEnv("SNARKROUTE_LAUNCHER_TOKEN","test-token");const fetcher=vi.fn(async()=>new Response(JSON.stringify({ok:true,service:"snarkroute-launcher-control",apiPort:4317,managed:true})));
  vi.stubGlobal("fetch",fetcher);const app=Fastify();await registerSystemRoutes(app);
  try{
    expect((await app.inject({method:"POST",url:"/api/system/restart"})).statusCode).toBe(401);
    expect((await app.inject({method:"POST",url:"/api/system/restart",headers:{"x-snarkroute-agent-token":"agent"}})).statusCode).toBe(403);
    expect((await app.inject({method:"POST",url:"/api/system/restart",headers:{origin:"http://localhost",host:"localhost"}})).statusCode).toBe(401);
    const response=await app.inject({method:"POST",url:"/api/system/restart",headers:{authorization:"Bearer test-token"}});expect(response.statusCode).toBe(202);
    expect(fetcher.mock.calls[0]).toMatchObject(["http://127.0.0.1:5176/restart",{method:"POST",body:"{}",headers:{Authorization:"Bearer test-token"}}]);
    fetcher.mockImplementationOnce(async()=>new Response(JSON.stringify({ok:false,error:"start failed"}),{status:409}));
    const failed=await app.inject({method:"POST",url:"/api/system/restart",headers:{authorization:"Bearer test-token"}});expect(failed.statusCode).toBe(503);expect(failed.json().error).toBe("start failed");
  }finally{await app.close();}
});
it("rejects foreign origins and cannot stop a server without its launcher secret",async()=>{
  const app=Fastify();await registerSystemRoutes(app);
  try{
    expect((await app.inject({method:"POST",url:"/api/system/restart",headers:{origin:"https://evil.example"}})).statusCode).toBe(403);
    expect((await app.inject({method:"POST",url:"/api/system/restart/shutdown"})).statusCode).toBe(401);
  }finally{await app.close();}
});
it("does not shut down when the responding launcher owns another PID",async()=>{
  vi.stubEnv("SNARKROUTE_LAUNCHER_TOKEN","test-token");
  vi.stubGlobal("fetch",vi.fn(async()=>new Response(JSON.stringify({ok:true,service:"snarkroute-launcher-control",apiPort:4317,managed:true,serverPid:process.pid+1}))));
  const app=Fastify();await registerSystemRoutes(app);
  try{expect((await app.inject({method:"POST",url:"/api/system/restart/shutdown",headers:{authorization:"Bearer test-token"}})).statusCode).toBe(409);}
  finally{await app.close();}
});
it("acknowledges before closing and only exits after confirmed owner and graceful close",async()=>{
  vi.stubEnv("SNARKROUTE_LAUNCHER_TOKEN","test-token");
  vi.stubGlobal("fetch",vi.fn(async()=>new Response(JSON.stringify({ok:true,service:"snarkroute-launcher-control",apiPort:4317,managed:true,serverPid:process.pid,operation:{state:"stopping",action:"restart"}}))));
  const app=Fastify();await registerSystemRoutes(app);
  const close=vi.spyOn(app,"close").mockResolvedValue(undefined as never);
  const exit=vi.spyOn(process,"exit").mockImplementation((()=>undefined) as never);
  vi.useFakeTimers();
  try{
    const response=await app.inject({method:"POST",url:"/api/system/restart/shutdown",headers:{authorization:"Bearer test-token"}});
    expect(response.statusCode).toBe(202);expect(close).not.toHaveBeenCalled();expect(exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);expect(close).toHaveBeenCalledOnce();expect(exit).toHaveBeenCalledWith(0);
  }finally{vi.useRealTimers();vi.restoreAllMocks();await app.close();}
});
it("exits on its own when graceful close hangs on open connections",async()=>{
  vi.stubEnv("SNARKROUTE_LAUNCHER_TOKEN","test-token");
  vi.stubGlobal("fetch",vi.fn(async()=>new Response(JSON.stringify({ok:true,service:"snarkroute-launcher-control",apiPort:4317,managed:true,serverPid:process.pid,operation:{state:"stopping",action:"restart"}}))));
  const app=Fastify();await registerSystemRoutes(app);
  const close=vi.spyOn(app,"close").mockReturnValue(new Promise(()=>{}) as never);
  const exit=vi.spyOn(process,"exit").mockImplementation((()=>undefined) as never);
  vi.useFakeTimers();
  try{
    expect((await app.inject({method:"POST",url:"/api/system/restart/shutdown",headers:{authorization:"Bearer test-token"}})).statusCode).toBe(202);
    await vi.advanceTimersByTimeAsync(100);expect(close).toHaveBeenCalledOnce();expect(exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(15_000);expect(exit).toHaveBeenCalledWith(0);
  }finally{vi.useRealTimers();vi.restoreAllMocks();await app.close();}
});
