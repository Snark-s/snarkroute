import {useEffect,useRef,useState} from 'react';
import {readRestartStatus,restartSnarkRoute,watchRestart,type RestartStatus} from './restartClient';
export function RestartSnarkRoute({apiPort,onHealthy}:{apiPort:number;onHealthy?:()=>void}){
  const base=`http://127.0.0.1:${import.meta.env.VITE_LAUNCHER_CONTROL_PORT||5176}`;
  const [status,setStatus]=useState<RestartStatus>();const [busy,setBusy]=useState(false);const [error,setError]=useState('');const [notice,setNotice]=useState('');
  const running=useRef(false);
  useEffect(()=>{
    let disposed=false;
    void readRestartStatus(base,apiPort).then(async value=>{
      if(disposed)return;setStatus(value);
      if(value.operation&&!['healthy','error'].includes(value.operation.state)){
        setNotice('Перезапускаю SnarkRoute…');
        await watchRestart(base,apiPort,value,next=>{if(!disposed)setStatus(next);});
        if(!disposed){setNotice('SnarkRoute готов');onHealthy?.();}
      }
    }).catch(reason=>{if(!disposed){setNotice('');setError(reason instanceof Error?reason.message:'Перезапуск доступен после запуска через launcher.');setStatus(current=>current?.operation?{...current,operation:{...current.operation,state:'error'}}:current);}});
    return()=>{disposed=true;};
  },[base,apiPort]);
  async function restart(){
    if(running.current)return;running.current=true;setBusy(true);setError('');setNotice('Перезапускаю SnarkRoute…');
    try{await restartSnarkRoute(base,apiPort,setStatus);setNotice('SnarkRoute готов');onHealthy?.();}
    catch(reason){setNotice('');setError(reason instanceof Error?reason.message:'Не удалось перезапустить SnarkRoute');setStatus(current=>current?.operation?{...current,operation:{...current.operation,state:'error'}}:current);}
    finally{running.current=false;setBusy(false);}
  }
  const active=busy||Boolean(status?.operation&&!['healthy','error'].includes(status.operation.state));
  return <div className="restartRuntime"><button type="button" disabled={active||!status?.managed} onClick={()=>void restart()} title={status?.managed?'Перезапустить локальный сервер':'Запустите SnarkRoute через launcher'}>{active?'Перезапускаю…':'Перезапустить SnarkRoute'}</button>
    {notice&&<small role="status">{notice}</small>}{error&&<small role="alert">{error}</small>}</div>;
}
