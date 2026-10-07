import {afterEach,expect,it,vi} from "vitest";
import Fastify from "fastify";
import {registerSystemRoutes} from "../src/routes/system";
afterEach(()=>{vi.unstubAllGlobals();vi.unstubAllEnvs();vi.restoreAllMocks();});
it("forwards restart to the external owner and reports startup failure",async()=>{
  vi.stubEnv("APP_MODE","local");const fetcher=vi.fn(async()=>new Response(JSON.stringify({ok:true,service:"snarkroute-launcher-control",apiPort:4317,managed:true})));
  vi.stubGlobal("fetch",fetcher);const app=Fastify();await registerSystemRoutes(app);
  try{
    const response=await app.inject({method:"POST",url:"/api/system/restart"});expect(response.statusCode).toBe(202);
    expect(fetcher.mock.calls[0]).toMatchObject(["http://127.0.0.1:5176/restart",{method:"POST",body:"{}"}]);
    fetcher.mockImplementationOnce(async()=>new Response(JSON.stringify({ok:false,error:"start failed"}),{status:409}));
    const failed=await app.inject({method:"POST",url:"/api/system/restart"});expect(failed.statusCode).toBe(503);expect(failed.json().error).toBe("start failed");
  }finally{await app.close();}
});
it("rejects foreign origins and cannot stop a server without its launcher secret",async()=>{
  const app=Fastify();await registerSystemRoutes(app);
  try{
    expect((await app.inject({method:"POST",url:"/api/system/restart",headers:{origin:"https://evil.example"}})).statusCode).toBe(403);
    expect((await app.inject({method:"POST",url:"/api/system/restart/shutdown"})).statusCode).toBe(403);
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
