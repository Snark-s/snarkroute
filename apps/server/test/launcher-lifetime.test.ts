import {afterEach,expect,it,vi} from "vitest";
import {EventEmitter} from "node:events";
import Fastify from "fastify";
import {attachLauncherLifetime} from "../src/server";
afterEach(()=>vi.unstubAllEnvs());
it.each(["disconnect","SIGINT","SIGTERM"])("gracefully closes an owned API on %s and exits after close",async event=>{
  vi.stubEnv("SNARKROUTE_LAUNCHER_TOKEN","owned");
  const channel=Object.assign(new EventEmitter(),{connected:true,send:()=>{},exit:vi.fn()});
  const app=Fastify();const closed=vi.fn();app.addHook("onClose",async()=>{closed();});
  expect(attachLauncherLifetime(app,channel as unknown as typeof process)).toBe(true);
  await app.ready();channel.emit(event);await vi.waitFor(()=>expect(channel.exit).toHaveBeenCalledWith(0));
  expect(closed).toHaveBeenCalledOnce();expect(channel.listenerCount("disconnect")).toBe(0);
});
it("does not start listening if its owning parent already disconnected",async()=>{
  vi.stubEnv("SNARKROUTE_LAUNCHER_TOKEN","owned");
  const channel=Object.assign(new EventEmitter(),{connected:false,send:()=>{},exit:vi.fn()});
  const app=Fastify();
  expect(attachLauncherLifetime(app,channel as unknown as typeof process)).toBe(false);
  await vi.waitFor(()=>expect(channel.exit).toHaveBeenCalledWith(0));
});
