type Request = (path:string,init?:RequestInit)=>Promise<unknown>;
type CurrentTask = {task:{state:string};taskBudget:{attemptsUsed:number;attemptsLimit:number}};

/** Uses the caller's existing owner session. It never creates a replacement task
 * or changes spent steps, permissions, subscription allocation or effect receipts. */
export async function continueWithAdditionalAttempt(taskId:string,note:string,request:Request):Promise<void> {
  const reason=note.trim();
  if(!reason)throw new Error("Нужно основание владельца и уточнение исполнителю.");
  const path=`/tasks/${encodeURIComponent(taskId)}`;
  const current=await request(path) as CurrentTask;
  if(current.task.state!=="blocked")throw new Error("Задача изменила состояние. Обновите карточку; дополнительная попытка не выделялась.");
  const {attemptsUsed,attemptsLimit}=current.taskBudget;
  if(!Number.isInteger(attemptsUsed)||!Number.isInteger(attemptsLimit)||attemptsLimit<1)throw new Error("Сервер не подтвердил текущий предел попыток.");
  if(attemptsUsed>=attemptsLimit)await request(`${path}/budget`,{method:"POST",body:JSON.stringify({budget:{maxAttempts:attemptsLimit+1},reason})});
  await request(`${path}/resolve`,{method:"POST",body:JSON.stringify({action:"continue",note:reason})});
}
