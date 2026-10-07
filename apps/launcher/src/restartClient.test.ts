import {expect,it,vi} from 'vitest';
import {restartSnarkRoute,watchRestart} from './restartClient';
const state=(phase:string)=>({ok:true,service:'snarkroute-launcher-control',apiPort:4317,managed:true,operation:{id:'job-1',state:phase}});
it('requests one restart, reports progress and waits for owner health',async()=>{
  const responses=[state('stopping'),state('starting'),state('healthy')];const states:string[]=[];
  const fetcher=vi.fn(async()=>new Response(JSON.stringify(responses.shift())));
  await restartSnarkRoute('http://127.0.0.1:5176',4317,status=>states.push(status.operation!.state),{fetcher,wait:async()=>{}});
  expect(fetcher.mock.calls).toHaveLength(3);expect(states).toEqual(['stopping','starting','healthy']);
});
it('reports owner restart failures without claiming success',async()=>{
  const fetcher=vi.fn(async()=>new Response(JSON.stringify({...state('error'),operation:{id:'job-1',state:'error',error:'health timeout'}})));
  await expect(restartSnarkRoute('http://127.0.0.1:5176',4317,()=>{}, {fetcher})).rejects.toThrow('health timeout');
});
it('rejects ownership of another configured API',async()=>{
  const fetcher=vi.fn(async()=>new Response(JSON.stringify({...state('healthy'),apiPort:9999})));
  await expect(restartSnarkRoute('http://127.0.0.1:5176',4317,()=>{}, {fetcher})).rejects.toThrow('another');
});
it('rejoins an existing restart without starting another one',async()=>{
  const fetcher=vi.fn(async(_url:Parameters<typeof fetch>[0])=>new Response(JSON.stringify(state('healthy'))));
  await watchRestart('http://127.0.0.1:5176',4317,state('starting'),()=>{}, {fetcher,wait:async()=>{}});
  expect(fetcher).toHaveBeenCalledOnce();expect(fetcher.mock.calls[0][0]).toBe('http://127.0.0.1:5176/status');
});
