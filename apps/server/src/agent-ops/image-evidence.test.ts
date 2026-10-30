import {describe,it,expect,afterEach} from "vitest";
import {mkdtemp,writeFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {runCheck} from "./workspace";
const dirs:string[]=[];afterEach(async()=>{for(const d of dirs.splice(0))await rm(d,{recursive:true,force:true});});
describe("scoped image evidence",()=>{
 it("prepares a bounded real image input and rejects non-images or paths outside the task",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"acceptor-image-"));dirs.push(dir);
  await writeFile(join(dir,"sample.png"),Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aM6sAAAAASUVORK5CYII=","base64"));
  const result=await runCheck({type:"image",path:"sample.png"},dir);expect(result.ok).toBe(true);expect(result.imageInput?.sha256).toMatch(/^[a-f0-9]{64}$/);expect(result.imageInput?.path).toBe(join(dir,"sample.png"));expect(result.content).not.toContain("base64");
  await writeFile(join(dir,"fake.jpg"),"not an image");expect((await runCheck({type:"image",path:"fake.jpg"},dir)).ok).toBe(false);expect((await runCheck({type:"image",path:"../sample.png"},dir)).ok).toBe(false);
 });
});
