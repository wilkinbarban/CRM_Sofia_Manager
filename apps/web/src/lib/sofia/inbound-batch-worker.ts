import type { SupabaseClient } from '@supabase/supabase-js'
import { processarRagBatchPipeline } from '@/lib/ai/openrouter'
import { obterSofiaGlobalChannelConfig } from '@/lib/config/sistema'
import { verificarHorarioAtendimento } from '@/lib/horarios/verificar'
import { extrairFatosDoLote, type LoteExtraivel } from '@/lib/sofia/customer-memory-extraction'
import { inboundBatchRuntimeEnabled } from '@/lib/sofia/inbound-batch-gates'
import { SOFIA_BATCH_MAINTENANCE_CADENCE_MS } from '@/lib/sofia/response-pace'
import { enviarAcaoChatTelegram, enviarMensagemTelegram, TELEGRAM_CHAT_ACTION_REASONS, type TelegramChatActionOutcome, type TelegramChatActionReason, type TelegramChatActionReport } from '@/lib/telegram/send'
import { enviarMensagemWhatsapp } from '@/lib/whatsapp/send'
    import type { EvolutionPresenceEvent } from '@/lib/whatsapp/evolution-presence'
    import { obterProvedorAtivo } from '@/lib/whatsapp/provider'
import { isWhatsAppInboundEligibleForSofia } from '@/lib/whatsapp/sofia-control'

type Channel='telegram'|'whatsapp'|'web'
type Member={content:string|null;has_attachment:boolean;has_payment_proof:boolean}
type Activity={attempt_id:string;expires_at:string}
type PacedCompletion={remaining_ms:number}
type Claim={batch_id:string;conversa_id:string;cliente_id:string;channel:Channel;lease_token:string;eligibility:{db_eligible:boolean;ia_ativa?:boolean;conversation_status?:string;automation_allowed?:boolean;global_enabled?:boolean;whatsapp_status?:string;whatsapp_sleeping?:boolean};members:Member[]}
type Delivery={batch_id:string;conversa_id:string;canal:Channel;response_text:string;lease_token:string;remaining_ms?:number|null}
export type BatchCounts={claimed:number;completed:number;cancelled:number;failed:number;delivery_attempted:number}
export interface BatchWorkerDeps {
 claimBatch():Promise<Claim|null>; cancel(id:string,lease:string,reason:string):Promise<boolean>; fail(id:string,lease:string,error:string):Promise<boolean>
 businessHours():Promise<boolean>; globalEnabled(channel:Channel):Promise<boolean>; whatsappEligible(claim:Claim):Promise<boolean>
 generate(conversationId:string,context:string,channel:Channel):Promise<string>; complete(id:string,lease:string,text:string):Promise<boolean>; completePaced(id:string,lease:string,text:string,elapsedMs:number):Promise<PacedCompletion|null>
 claimDelivery():Promise<Delivery|null>; beginDelivery(id:string,lease:string):Promise<boolean>; recordDeliveryFailure(id:string,reason:string):Promise<unknown>
 beginActivity?(id:string,lease:string):Promise<Activity|null>;renewActivity?(id:string,lease:string,attempt:string):Promise<boolean>;clearActivity?(id:string,attempt:string):Promise<boolean>;adoptActivity(id:string,lease:string):Promise<Activity|null>
 setInterval?(callback:()=>void,ms:number):unknown;clearInterval?(timer:unknown):void;now():number;sleep(ms:number):Promise<void>
 sendTelegramTyping(id:string):Promise<TelegramChatActionReport>;sendTelegram(id:string,text:string):Promise<unknown>;sendWhatsApp(id:string,text:string,typingDelayMs?:number):Promise<unknown>;startWhatsAppPresence?(id:string,observe?:(event:EvolutionPresenceEvent)=>void):TypingHandle|Promise<TypingHandle>
 observeTelegramTyping?(event:TelegramTypingObservation):void
 observeWhatsAppPresence?(event:EvolutionPresenceEvent):void
 extractFacts?(lote:LoteExtraivel):Promise<unknown>
}
export function formatBatchContext(members:Member[]):string {
 return ['MENSAGENS RECEBIDAS NESTE LOTE (ordem cronológica):',...members.map((m,i)=>{
  const text=m.content?.trim(); const attachment=m.has_payment_proof?' [anexo: comprovante de pagamento recebido]':m.has_attachment?' [anexo recebido]':''
 return `[${i+1}] Cliente: ${text?`"${text}"${attachment}`:attachment.trim().replace(/\]$/, '; mensagem sem texto]')}`
 })].join('\n')
}
function startHeartbeat(deps:BatchWorkerDeps,batchId:string,lease:string,attempt:string){
 let lost=false,renewing=false,renewal:Promise<void>|undefined
 const renew=()=>{
  if(lost||renewing||!deps.renewActivity)return renewal
  renewing=true
  renewal=(async()=>{try{if(!await deps.renewActivity!(batchId,lease,attempt))lost=true}catch{lost=true}finally{renewing=false}})()
  return renewal
 }
 const timer=deps.setInterval?.(()=>{void renew()},10_000)
 return {lost:()=>lost,settle:async()=>{await renewal},stop:()=>timer!==undefined&&deps.clearInterval?.(timer)}
}
type TypingHandle={stop:()=>void}
export const TELEGRAM_TYPING_RESTART_FLOOR_MS = SOFIA_BATCH_MAINTENANCE_CADENCE_MS
export const TELEGRAM_TYPING_REFRESH_INTERVAL_MS = 4_000
export const TELEGRAM_TYPING_TAG='telegram_typing'
/** Evento de observabilidade com tag fixa e enums seguros: nunca carrega token, IDs ou texto do provedor. */
export type TelegramTypingObservation={tag:typeof TELEGRAM_TYPING_TAG;event:'attempt'|TelegramChatActionOutcome;reason?:TelegramChatActionReason}
const telegramTypingReasons:ReadonlySet<string>=new Set(TELEGRAM_CHAT_ACTION_REASONS)
function settledTelegramTyping(value:unknown):TelegramTypingObservation{
 const report=value&&typeof value==='object'?value as {outcome?:unknown;reason?:unknown}:null
 const outcome=report?.outcome
 if(outcome!=='accepted'&&outcome!=='rejected'&&outcome!=='unavailable')return {tag:TELEGRAM_TYPING_TAG,event:'unavailable'}
 return typeof report?.reason==='string'&&telegramTypingReasons.has(report.reason)
  ?{tag:TELEGRAM_TYPING_TAG,event:outcome,reason:report.reason as TelegramChatActionReason}
  :{tag:TELEGRAM_TYPING_TAG,event:outcome}
}
function observeTelegramTyping(deps:BatchWorkerDeps,event:TelegramTypingObservation){
 try{
  const pending=deps.observeTelegramTyping?.(event)
  // Observabilidade é registro, não entrega: nunca pode bloquear nem rejeitar sem tratamento.
  if(pending&&typeof (pending as PromiseLike<unknown>).then==='function')void Promise.resolve(pending).catch(()=>undefined)
 }catch{/* melhor esforço */}
}
const whatsappPresenceReasons:ReadonlySet<string>=new Set(['provider_unavailable','provider_rejected','invalid_response'])
function safeWhatsAppPresenceEvent(value:unknown):EvolutionPresenceEvent{
 const event=value&&typeof value==='object'?value as {event?:unknown;reason?:unknown}:{}
 if(event.event==='attempt'||event.event==='accepted')return {tag:'evolution_presence',event:event.event}
 const reason=typeof event.reason==='string'&&whatsappPresenceReasons.has(event.reason)?event.reason as 'provider_unavailable'|'provider_rejected'|'invalid_response':'provider_unavailable'
 return {tag:'evolution_presence',event:'unavailable',reason}
}
function observeWhatsAppPresence(deps:BatchWorkerDeps,event:unknown){
 try{
  const pending=deps.observeWhatsAppPresence?.(safeWhatsAppPresenceEvent(event))
  if(pending&&typeof (pending as PromiseLike<unknown>).then==='function')void Promise.resolve(pending).catch(()=>undefined)
 }catch{/* best effort */}
}
function startTelegramTyping(deps:BatchWorkerDeps,conversationId:string):TypingHandle{
 let stopped=false,refreshing=false
 let timer:unknown=undefined
 const stop=()=>{
  stopped=true
  if(timer!==undefined){
   deps.clearInterval?.(timer)
   timer=undefined
  }
 }
 const refresh=()=>{
  if(stopped||refreshing)return
  refreshing=true
  observeTelegramTyping(deps,{tag:TELEGRAM_TYPING_TAG,event:'attempt'})
  let request:PromiseLike<TelegramChatActionReport>|undefined
  try{
   request=deps.sendTelegramTyping(conversationId)
  }catch{
   refreshing=false
   observeTelegramTyping(deps,{tag:TELEGRAM_TYPING_TAG,event:'unavailable'})
   return
  }
  if(!request||typeof (request as PromiseLike<unknown>).then!=='function'){
   refreshing=false
   observeTelegramTyping(deps,{tag:TELEGRAM_TYPING_TAG,event:'unavailable'})
   return
  }
  void Promise.resolve(request).then(
   report=>{
    refreshing=false
    const settled=settledTelegramTyping(report)
    observeTelegramTyping(deps,settled)
    if(settled.event==='rejected')stop()
   },
   ()=>{refreshing=false;observeTelegramTyping(deps,{tag:TELEGRAM_TYPING_TAG,event:'unavailable'})},
  )
 }
 refresh()
 if(!stopped){
  timer=deps.setInterval?.(()=>{void refresh()},TELEGRAM_TYPING_REFRESH_INTERVAL_MS)
 }
 return {stop}
}
export async function runSofiaBatchMaintenance(d:BatchWorkerDeps,limit=20):Promise<BatchCounts>{
 const out:BatchCounts={claimed:0,completed:0,cancelled:0,failed:0,delivery_attempted:0}
 const processingLimit=Math.ceil(limit/2),runtimeEnabled=inboundBatchRuntimeEnabled(),pacedRemainders=new Map<string,number>()
 const typingHandles=new Map<string,TypingHandle>()
 const presenceHandles=new Map<string,TypingHandle|undefined>()
 const closedPresence=new Set<string>()
 const lotesCompletos:LoteExtraivel[]=[]
 const releaseTyping=(batchId:string)=>{const handle=typingHandles.get(batchId);if(!handle)return;typingHandles.delete(batchId);handle.stop()}
 const releasePresence=(batchId:string)=>{closedPresence.add(batchId);const handle=presenceHandles.get(batchId);presenceHandles.delete(batchId);handle?.stop()}
 const ensureTyping=(batchId:string,conversationId:string)=>{const retained=typingHandles.get(batchId);if(retained)return retained;const handle=startTelegramTyping(d,conversationId);typingHandles.set(batchId,handle);return handle}
 try{
  for(let i=0;i<processingLimit;i++){
   const c=await d.claimBatch();if(!c)break;out.claimed++
   try{
    const e=c.eligibility
    let reason:string|null=e.ia_ativa===false?'ia_inactive':e.automation_allowed===false||e.whatsapp_status==='opted_out'?'opt_out':e.global_enabled===false?'global_disabled':e.conversation_status&&e.conversation_status!=='ia_atendendo'?'handoff_or_pause':e.whatsapp_sleeping?'sleep_or_cooldown':!e.db_eligible?'handoff_or_pause':c.channel!=='web'&&!(await d.globalEnabled(c.channel))?'global_disabled':!(await d.businessHours())?'outside_business_hours':null
    if(!reason&&c.channel==='whatsapp'&&!(await d.whatsappEligible(c)))reason='sleep_or_cooldown'
    if(reason){await d.cancel(c.batch_id,c.lease_token,reason);out.cancelled++;continue}
    if(!runtimeEnabled){
     const contexto=formatBatchContext(c.members)
     const text=await d.generate(c.conversa_id,contexto,c.channel)
     if(!(await d.complete(c.batch_id,c.lease_token,text))){out.failed++;continue}
     out.completed++
     lotesCompletos.push({batch_id:c.batch_id,conversa_id:c.conversa_id,cliente_id:c.cliente_id,canal:c.channel,contexto})
     continue
    }
    const activity=await d.beginActivity?.(c.batch_id,c.lease_token)
    if(!activity){out.failed++;continue}
    const heartbeat=startHeartbeat(d,c.batch_id,c.lease_token,activity.attempt_id)
    if(c.channel==='telegram')ensureTyping(c.batch_id,c.conversa_id)
   if(c.channel==='whatsapp'&&d.startWhatsAppPresence){
    presenceHandles.set(c.batch_id,undefined)
    try{
     const started=d.startWhatsAppPresence(c.conversa_id,event=>observeWhatsAppPresence(d,event))
     if(started&&typeof (started as PromiseLike<TypingHandle>).then==='function')void Promise.resolve(started as Promise<TypingHandle>).then(handle=>{if(closedPresence.has(c.batch_id)||!presenceHandles.has(c.batch_id))handle.stop();else presenceHandles.set(c.batch_id,handle)}).catch(()=>observeWhatsAppPresence(d,{event:'unavailable',reason:'provider_unavailable'}))
     else { const handle=started as TypingHandle;if(closedPresence.has(c.batch_id))handle.stop();else presenceHandles.set(c.batch_id,handle) }
    }catch{observeWhatsAppPresence(d,{event:'unavailable',reason:'provider_unavailable'});releasePresence(c.batch_id)}
   }
    const contexto=formatBatchContext(c.members)
    let retainGenerationActivity=false
    try{
     const startedAt=d.now()
     const text=await d.generate(c.conversa_id,contexto,c.channel)
     const elapsedMs=Math.max(0,d.now()-startedAt)
     await heartbeat.settle()
     if(heartbeat.lost()){out.failed++;continue}
     const paced=await d.completePaced(c.batch_id,c.lease_token,text,elapsedMs)
     if(!paced){out.failed++;continue}
     pacedRemainders.set(c.batch_id,paced.remaining_ms)
     retainGenerationActivity=true;out.completed++
     lotesCompletos.push({batch_id:c.batch_id,conversa_id:c.conversa_id,cliente_id:c.cliente_id,canal:c.channel,contexto})
    }finally{
     heartbeat.stop()
     if(!retainGenerationActivity){releaseTyping(c.batch_id);releasePresence(c.batch_id);await d.clearActivity?.(c.batch_id,activity.attempt_id)}
    }
   }catch{await d.fail(c.batch_id,c.lease_token,'generation_failed');out.failed++}
  }
  let workClaimed=out.claimed
  while(workClaimed<limit){
   const job=await d.claimDelivery();if(!job)break;workClaimed++
   let deliveryActivity:Activity|null=null
   let retainedTyping=false
   if(runtimeEnabled){
    deliveryActivity=await d.adoptActivity(job.batch_id,job.lease_token)
    if(!deliveryActivity){releaseTyping(job.batch_id);continue}
    if(job.canal==='telegram'){retainedTyping=typingHandles.has(job.batch_id);ensureTyping(job.batch_id,job.conversa_id)}
   }
   try{
    const remainingMs=job.remaining_ms??pacedRemainders.get(job.batch_id)
    const waitMs=job.canal==='telegram'&&runtimeEnabled&&!retainedTyping?Math.max(TELEGRAM_TYPING_RESTART_FLOOR_MS,remainingMs??0):remainingMs
    if(waitMs!==undefined&&waitMs!==null&&(job.canal==='telegram'||job.canal==='whatsapp'))await d.sleep(waitMs)
    if(!(await d.beginDelivery(job.batch_id,job.lease_token)))continue
    out.delivery_attempted++
    const result=job.canal==='telegram'
     ?await d.sendTelegram(job.conversa_id,job.response_text)
     :job.canal==='whatsapp'
       ?await d.sendWhatsApp(job.conversa_id,job.response_text,remainingMs??undefined)
       :{success:true}
    if(result&&typeof result==='object'&&(('success'in result&&result.success===false)||('sucesso'in result&&result.sucesso===false)))await d.recordDeliveryFailure(job.batch_id,'provider_rejected')
   }catch{await d.recordDeliveryFailure(job.batch_id,'provider_unavailable')}
   finally{releaseTyping(job.batch_id);releasePresence(job.batch_id);if(deliveryActivity)await d.clearActivity?.(job.batch_id,deliveryActivity.attempt_id)}
  }
  // Single drain after the delivery loop: extraction can never delay a customer-visible reply.
  for(const lote of lotesCompletos)await executarHookExtracao(d,lote)
  return out
 }finally{
  for(const batchId of [...typingHandles.keys()])releaseTyping(batchId)
  for(const batchId of [...presenceHandles.keys()])releasePresence(batchId)
 }
}
/**
 * Post-completion extraction hook. Best effort by contract: it never throws and never fails the pass.
 *
 * At-most-once **by completion semantics only**, with no stronger fence claimed: `claim_sofia_inbound_batch`
 * selects only `pending` batches or `processing` batches past `claimed_until`, and completion clears the
 * lease, so a completed batch is never re-drained. A crash between completion and this call loses that
 * batch's facts permanently: there is no ledger, no backfill and no compensating write (`23505` counts as
 * already recorded). A failure in a live process is equally final and is never retried, and anything that
 * rejects before the drain (for example a delivery-loop failure) skips the remaining extraction of that
 * pass for the same reason.
 */
async function executarHookExtracao(d:BatchWorkerDeps,lote:LoteExtraivel):Promise<void>{
 if(!d.extractFacts)return
 try{await d.extractFacts(lote)}
 catch{console.warn(`[sofia-inbound-batch] customer_memory_extraction_failed batch=${lote.batch_id}`)}
}
function row<T>(data:T|T[]|null):T|null{return Array.isArray(data)?data[0]??null:data}
export function createSofiaBatchWorkerDeps(db:SupabaseClient):BatchWorkerDeps{
 const rpc=async<T>(name:string,args:object={})=>{const r=await db.rpc(name,args);if(r.error)throw Error(name);return row(r.data) as T}
 return {
  claimBatch:()=>rpc('claim_sofia_inbound_batch',{p_lease_seconds:60}),cancel:(id,l,r)=>rpc('cancel_sofia_inbound_batch',{p_batch_id:id,p_lease_token:l,p_reason:r}),fail:(id,l,e)=>rpc('fail_sofia_inbound_batch',{p_batch_id:id,p_lease_token:l,p_error:e}),
  businessHours:async()=>(await verificarHorarioAtendimento()).dentro,globalEnabled:async c=>c==='web'?true:(await obterSofiaGlobalChannelConfig(c)).enabled,whatsappEligible:async c=>(await isWhatsAppInboundEligibleForSofia({supabase:db,clienteId:c.cliente_id,conversaId:c.conversa_id})).eligible,
  generate:processarRagBatchPipeline,complete:async(id,l,t)=>!!await rpc('complete_sofia_inbound_batch',{p_batch_id:id,p_lease_token:l,p_response_text:t}),completePaced:(id,l,t,e)=>rpc('complete_sofia_inbound_batch_paced',{p_batch_id:id,p_lease_token:l,p_response_text:t,p_generation_elapsed_ms:e}),claimDelivery:()=>rpc('claim_sofia_response_delivery',{p_lease_seconds:60}),beginDelivery:(id,l)=>rpc('begin_sofia_response_delivery',{p_batch_id:id,p_lease_token:l}),recordDeliveryFailure:(id,r)=>rpc('record_sofia_response_delivery_failure',{p_batch_id:id,p_failure:r}),
  extractFacts:lote=>extrairFatosDoLote(db,lote),
  beginActivity:(id,l)=>rpc('begin_sofia_batch_activity',{p_batch_id:id,p_batch_lease_token:l,p_ttl_seconds:30}),renewActivity:async(id,l,a)=>!!await rpc('renew_sofia_owner_activity',{p_batch_id:id,p_owner_kind:'generation',p_owner_token:l,p_attempt_id:a,p_owner_ttl_seconds:30,p_activity_ttl_seconds:30}),clearActivity:(id,a)=>rpc('clear_sofia_batch_activity',{p_batch_id:id,p_attempt_id:a}),adoptActivity:(id,l)=>rpc('adopt_sofia_response_activity',{p_batch_id:id,p_delivery_lease_token:l,p_ttl_seconds:30}),
  setInterval:(callback,ms)=>setInterval(callback,ms),clearInterval:timer=>clearInterval(timer as ReturnType<typeof setInterval>),now:()=>Date.now(),sleep:ms=>new Promise(resolve=>setTimeout(resolve,ms)),sendTelegramTyping:id=>enviarAcaoChatTelegram(id,'typing'),
  // Observador de produção: tag fixa + enums seguros, uma linha por tentativa e por desfecho.
  observeTelegramTyping:event=>console.info(`[sofia-inbound-batch] ${event.tag} event=${event.event}${event.reason?` reason=${event.reason}`:''}`),
  sendTelegram:(id,text)=>enviarMensagemTelegram(id,{texto:text,remetente:'ia',salvarNoBanco:false}),sendWhatsApp:(id,text)=>enviarMensagemWhatsapp(id,{texto:text,remetente:'ia',salvarNoBanco:false}),startWhatsAppPresence:async(id,observe)=>{const provider=await obterProvedorAtivo();const iniciarPresenca=provider.iniciarPresenca;if(typeof iniciarPresenca!=='function')return {stop:()=>undefined};return iniciarPresenca.call(provider,id,observe)}, observeWhatsAppPresence:event=>console.info(`[sofia-inbound-batch] ${event.tag} event=${event.event}${event.event==='unavailable'?` reason=${event.reason}`:''}`)
 }
}
