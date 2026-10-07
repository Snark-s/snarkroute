export type RestartStatus={ok:boolean;service:string;apiPort:number;managed:boolean;operation:null|{id:string;state:string;error?:string};error?:string};
export async function readRestartStatus(base:string,apiPort:number,fetcher:typeof fetch=fetch):Promise<RestartStatus>{
  const response=await fetcher(`${base}/status`,{signal:AbortSignal.timeout(3000)});
  const result=await response.json() as RestartStatus;
  if(!response.ok||!result.ok)throw new Error(result.error||'Launcher is unavailable');
  if(result.service!=='snarkroute-launcher-control'||result.apiPort!==apiPort)throw new Error('Launcher owns another configured API');
  return result;
}
export async function restartSnarkRoute(base:string,apiPort:number,onProgress:(status:RestartStatus)=>void,
  {fetcher=fetch,wait=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms)),timeoutMs=180000}={}){
  const response=await fetcher(`${base}/restart`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}',signal:AbortSignal.timeout(5000)});
  let status=await response.json() as RestartStatus;
  if(!response.ok||!status.ok)throw new Error(status.error||'Restart request failed');
  if(status.service!=='snarkroute-launcher-control'||status.apiPort!==apiPort)throw new Error('Launcher owns another configured API');
  return watchRestart(base,apiPort,status,onProgress,{fetcher,wait,timeoutMs});
}
export async function watchRestart(base:string,apiPort:number,status:RestartStatus,onProgress:(status:RestartStatus)=>void,
  {fetcher=fetch,wait=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms)),timeoutMs=180000}={}){
  const id=status.operation?.id;if(!id)throw new Error('Restart operation missing');
  const deadline=Date.now()+timeoutMs;
  while(Date.now()<deadline){
    onProgress(status);
    if(status.operation?.state==='healthy')return status;
    if(status.operation?.state==='error')throw new Error(status.operation.error||'Restart failed');
    await wait(700);status=await readRestartStatus(base,apiPort,fetcher);
    if(status.operation?.id!==id)throw new Error('Restart operation changed; inspect launcher status');
  }
  throw new Error('Restart completion timeout');
}
