import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createLauncherRestartControl,allowedControlOrigin,serverLaunchSpec} from './launcher-control.mjs';
function fixture(options={}){
  let clock=0,owned=true,open=true;const calls=[];
  const control=createLauncherRestartControl({apiPort:4317,timeoutMs:20,pollMs:5,
    owned:()=>owned,serverPid:()=>owned?123:undefined,now:()=>clock,wait:async ms=>{clock+=ms;},
    portOpen:async()=>open,healthy:async()=>options.healthy!==false,
    stop:async()=>{calls.push('stop');owned=false;open=false;},
    start:async()=>{calls.push('start');if(options.startFailure)throw new Error('start failed');owned=true;open=true;},
    cleanup:async()=>{calls.push('cleanup');owned=false;open=false;},
  });return {control,calls,setOwned:value=>{owned=value;}};
}
test('restart stops then starts exactly its configured server and waits for health',async()=>{
  const f=fixture();const job=f.control.restart();assert.equal(job.state,'stopping');await f.control.wait();
  assert.deepEqual(f.calls,['stop','start']);assert.equal(f.control.status().operation.state,'healthy');assert.equal(f.control.status().apiPort,4317);
  const spec=serverLaunchSpec('Y:/Процесс/SnarkRoute',4317,'token');
  assert.equal(spec.packageName,'@snarkroute/server');assert.equal(spec.script,'start');assert.equal(spec.env.PERSONA_BRIDGE_AUTO_START,'0');
  assert.match(spec.args.join(' '),/src\/index.ts/);assert.equal(spec.env.API_PORT,'4317');
});
test('duplicate restart reuses its operation and never double starts',async()=>{
  const f=fixture();const first=f.control.restart();assert.equal(f.control.restart().id,first.id);await f.control.wait();assert.deepEqual(f.calls,['stop','start']);
});
test('start failure is reported and owned child cleanup is attempted',async()=>{
  const f=fixture({startFailure:true});f.control.restart();await f.control.wait();assert.equal(f.control.status().operation.state,'error');
  assert.match(f.control.status().operation.error,/start failed/);assert.deepEqual(f.calls,['stop','start','cleanup']);
});
test('health timeout leaves no owned failed start',async()=>{
  const f=fixture({healthy:false});f.control.restart();await f.control.wait();assert.equal(f.control.status().operation.state,'error');
  assert.match(f.control.status().operation.error,/health/);assert.deepEqual(f.calls,['stop','start','cleanup']);
});
test('an unmanaged server is never killed or adopted by port alone',async()=>{
  const f=fixture();f.setOwned(false);assert.throws(()=>f.control.restart(),/owned/);assert.deepEqual(f.calls,[]);
});
test('unrelated web origins cannot issue a local restart',()=>{
  assert.equal(allowedControlOrigin('https://evil.example'),false);assert.equal(allowedControlOrigin('http://localhost.evil:5172'),false);
  assert.equal(allowedControlOrigin('http://127.0.0.1:5172'),true);assert.equal(allowedControlOrigin('chrome-extension://'+'a'.repeat(32)),true);
});
test('a port that fails to close prevents replacement and unrelated processes are untouched',async()=>{
  let clock=0;const calls=[];
  const control=createLauncherRestartControl({apiPort:4317,owned:()=>true,serverPid:()=>123,timeoutMs:10,pollMs:5,now:()=>clock,wait:async ms=>{clock+=ms;},
    stop:async()=>calls.push('stop-owned'),start:async()=>calls.push('start'),cleanup:async()=>calls.push('cleanup'),portOpen:async()=>true,healthy:async()=>true});
  control.restart();await control.wait();assert.deepEqual(calls,['stop-owned']);assert.equal(control.status().operation.state,'error');assert.match(control.status().operation.error,/port .*did not close/);
});
test('cold startup and simultaneous restart share a single start operation',async()=>{
  let open=false,owned=false;const calls=[];
  const control=createLauncherRestartControl({apiPort:4317,owned:()=>owned,serverPid:()=>123,portOpen:async()=>open,healthy:async()=>true,
    start:async()=>{calls.push('start');open=true;owned=true;},stop:async()=>calls.push('stop'),cleanup:async()=>{}});
  const starting=control.initialize();const job=control.restart();await starting;await control.wait();assert.equal(job.state,'starting');assert.deepEqual(calls,['start']);
});
test('restart button starts a fresh server when a failed restart left no owned server and the port is free',async()=>{
  const calls=[];
  const control=createLauncherRestartControl({apiPort:4317,timeoutMs:20,pollMs:5,owned:()=>false,serverPid:()=>undefined,
    portOpen:async()=>false,healthy:async()=>true,stop:async()=>calls.push('stop'),start:async()=>calls.push('start'),cleanup:async()=>calls.push('cleanup')});
  const job=await control.restartOrStart();assert.equal(job.action,'start');await control.wait();assert.deepEqual(calls,['start']);
});
test('restart button still refuses an unmanaged server that holds the port',async()=>{
  const f=fixture();f.setOwned(false);await assert.rejects(f.control.restartOrStart(),/owned/);assert.deepEqual(f.calls,[]);
});
test('launcher shutdown stops its owned API without starting a replacement',async()=>{
  const f=fixture();await f.control.shutdown();assert.deepEqual(f.calls,['stop']);
});
function dead(options={}){
  let clock=0,open=false,owned=false,startsLeftFailing=options.failStarts??0;const calls=[];const logs=[];
  const control=createLauncherRestartControl({apiPort:4317,timeoutMs:20,pollMs:5,now:()=>clock,wait:async ms=>{clock+=ms;},
    owned:()=>owned,serverPid:()=>owned?123:undefined,portOpen:async()=>open,healthy:async()=>open,
    stop:async()=>calls.push('stop'),cleanup:async()=>{calls.push('cleanup');owned=false;open=false;},
    start:async()=>{calls.push('start');if(startsLeftFailing>0){startsLeftFailing-=1;throw new Error('agents.ts: Unexpected "\\x00"');}owned=true;open=true;}});
  return {control,calls,logs,log:line=>logs.push(line),tick:ms=>{clock+=ms;},setOpen:v=>{open=v;}};
}
test('watchdog starts a dead server only after two misses in a row',async()=>{
  const f=dead();
  assert.equal(await f.control.watchdogTick({log:f.log}),'suspect');assert.deepEqual(f.calls,[]);
  assert.equal(await f.control.watchdogTick({log:f.log}),'recovered');assert.deepEqual(f.calls,['start']);
  assert.equal(await f.control.watchdogTick({log:f.log}),'alive');assert.equal(f.control.status().watchdog.lastError,null);
  assert.match(f.logs.join('\n'),/Сторож лаунчера: сервер поднят/);
});
test('watchdog never touches a live server, even an unmanaged one',async()=>{
  const f=dead();f.setOpen(true);
  for(let i=0;i<5;i+=1)assert.equal(await f.control.watchdogTick({log:f.log}),'alive');
  assert.deepEqual(f.calls,[]);
});
test('watchdog backs off after a failed start and reports the cause',async()=>{
  const f=dead({failStarts:2});
  await f.control.watchdogTick({log:f.log});assert.equal(await f.control.watchdogTick({log:f.log}),'failed');
  assert.match(f.control.status().watchdog.lastError,/x00/);
  assert.equal(await f.control.watchdogTick({log:f.log}),'backoff');assert.equal(f.calls.filter(c=>c==='start').length,1);
  f.tick(61_000);assert.equal(await f.control.watchdogTick({log:f.log}),'failed');
  f.tick(61_000);assert.equal(await f.control.watchdogTick({log:f.log}),'backoff');
  f.tick(120_000);assert.equal(await f.control.watchdogTick({log:f.log}),'recovered');
  assert.equal(f.control.status().watchdog.failures,0);
});
