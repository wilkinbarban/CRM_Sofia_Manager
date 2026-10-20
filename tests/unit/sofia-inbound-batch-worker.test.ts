import { afterEach, describe, expect, it, vi } from 'vitest'

const presenceMocks = vi.hoisted(() => {
  class EvolutionProvider {}
  // Next.js production minification renames the exported EvolutionProvider class (it ships as `q`),
  // so presence must be selected by capability and never by constructor name.
  class q { iniciarPresenca = vi.fn() }
  class MetaProvider {}
  const state: { activeProvider: object } = { activeProvider: new MetaProvider() }
  return {
    EvolutionProvider,
    q,
    MetaProvider,
    state,
    startEvolutionPresence: vi.fn(),
    obterProvedorAtivo: vi.fn(async () => state.activeProvider),
  }
})
vi.mock('@/lib/whatsapp/evolution', () => ({
  EvolutionProvider: presenceMocks.EvolutionProvider,
  startEvolutionPresence: presenceMocks.startEvolutionPresence,
}))
vi.mock('@/lib/whatsapp/provider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/whatsapp/provider')>()
  return {
    ...actual,
    obterProvedorAtivo: presenceMocks.obterProvedorAtivo,
  }
})

import {
  createSofiaBatchWorkerDeps,
  formatBatchContext,
  runSofiaBatchMaintenance,
  TELEGRAM_TYPING_REFRESH_INTERVAL_MS,
  TELEGRAM_TYPING_RESTART_FLOOR_MS,
  type BatchWorkerDeps,
} from '@/lib/sofia/inbound-batch-worker'
import { inboundBatchProcessingEnabled, inboundBatchRuntimeEnabled } from '@/lib/sofia/inbound-batch-gates'

const claim = { batch_id:'b', conversa_id:'c', cliente_id:'u', channel:'telegram' as const, lease_token:'l', eligibility:{ db_eligible:true }, members:[
  { content:'primeiro', has_attachment:false, has_payment_proof:false },
  { content:null, has_attachment:true, has_payment_proof:false },
  { content:'segue', has_attachment:true, has_payment_proof:true },
] }
function provided<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('expected the test to provide this dependency')
  return value
}
function observe(events: unknown[]) {
  return vi.fn((event: unknown) => { events.push(event) })
}
function deps(overrides: Partial<BatchWorkerDeps> = {}): BatchWorkerDeps {
  return { claimBatch:vi.fn().mockResolvedValueOnce(claim).mockResolvedValue(null), cancel:vi.fn().mockResolvedValue(true), fail:vi.fn().mockResolvedValue(true), businessHours:vi.fn().mockResolvedValue(true), globalEnabled:vi.fn().mockResolvedValue(true), whatsappEligible:vi.fn().mockResolvedValue(true), generate:vi.fn().mockResolvedValue('resposta'), complete:vi.fn().mockResolvedValue(true), completePaced:vi.fn().mockResolvedValue({ remaining_ms:0 }), claimDelivery:vi.fn().mockResolvedValue(null), adoptActivity:vi.fn().mockResolvedValue({attempt_id:'d',expires_at:''}), beginDelivery:vi.fn().mockResolvedValue(true), recordDeliveryFailure:vi.fn(), now:vi.fn().mockReturnValue(0), sleep:vi.fn().mockResolvedValue(undefined), sendTelegramTyping:vi.fn().mockResolvedValue({outcome:'accepted'}), sendTelegram:vi.fn(), sendWhatsApp:vi.fn(), ...overrides }
}
afterEach(() => vi.unstubAllEnvs())
describe('Sofia inbound batch worker', () => {
  it('parses processing strictly and defaults closed', () => {
    expect([undefined,'false','TRUE','1'].map(inboundBatchProcessingEnabled)).toEqual([false,false,false,false])
    expect(inboundBatchProcessingEnabled('true')).toBe(true)
  })
  it('parses the independent runtime gate strictly and defaults closed', () => {
    expect([undefined,'false','TRUE','1'].map(inboundBatchRuntimeEnabled)).toEqual([false,false,false,false])
    expect(inboundBatchRuntimeEnabled('true')).toBe(true)
  })
  it('preserves legacy generation and delivery while the runtime gate is off', async () => {
    vi.stubEnv('SOFIA_INBOUND_BATCH_RUNTIME_ENABLED','false')
    const delivery={batch_id:'d',conversa_id:'c',canal:'telegram' as const,response_text:'r',lease_token:'dl'}
    const d=deps({claimDelivery:vi.fn().mockResolvedValueOnce(delivery).mockResolvedValue(null),beginActivity:vi.fn(),renewActivity:vi.fn(),clearActivity:vi.fn()})
    await runSofiaBatchMaintenance(d,2)
    expect(d.complete).toHaveBeenCalledWith('b','l','resposta')
    expect(d.beginActivity).not.toHaveBeenCalled()
    expect(d.beginDelivery).toHaveBeenCalledWith('d','dl')
    expect(d.sendTelegram).toHaveBeenCalledWith('c','r')
  })
  it('completes paced work, transfers G to D, and sleeps only the durable remainder', async () => {
    vi.stubEnv('SOFIA_INBOUND_BATCH_RUNTIME_ENABLED','true')
    const delivery={batch_id:'b',conversa_id:'c',canal:'telegram' as const,response_text:'r',lease_token:'dl'}
    const d=deps({
      beginActivity:vi.fn().mockResolvedValue({attempt_id:'g',expires_at:''}),
      completePaced:vi.fn().mockResolvedValue({remaining_ms:37}),
      claimDelivery:vi.fn().mockResolvedValueOnce(delivery).mockResolvedValue(null),
      adoptActivity:vi.fn().mockResolvedValue({attempt_id:'d',expires_at:''}),
      clearActivity:vi.fn().mockResolvedValue(true),
      now:vi.fn().mockReturnValueOnce(100).mockReturnValueOnce(250),
      setInterval:vi.fn(()=> 'timer'),clearInterval:vi.fn(),
    })
    await runSofiaBatchMaintenance(d,2)
    expect(d.beginActivity).toHaveBeenCalledBefore(d.generate as ReturnType<typeof vi.fn>)
    expect(d.complete).not.toHaveBeenCalled()
    expect(d.completePaced).toHaveBeenCalledOnce()
    expect(d.completePaced).toHaveBeenCalledWith('b','l','resposta',150)
    expect(d.clearActivity).not.toHaveBeenCalledWith('b','g')
    expect(d.adoptActivity).toHaveBeenCalledWith('b','dl')
    expect(d.sleep).toHaveBeenCalledWith(37)
    expect(d.sleep).toHaveBeenCalledBefore(d.beginDelivery as ReturnType<typeof vi.fn>)
    expect(d.adoptActivity).toHaveBeenCalledBefore(d.beginDelivery as ReturnType<typeof vi.fn>)
    expect(d.beginDelivery).toHaveBeenCalledWith('b','dl')
    expect(d.clearActivity).toHaveBeenCalledWith('b','d')
    expect(d.clearInterval).toHaveBeenCalledWith('timer')
  })
  it('clears D when the final delivery fence is lost after paced waiting', async () => {
    vi.stubEnv('SOFIA_INBOUND_BATCH_RUNTIME_ENABLED','true')
    const delivery={batch_id:'b',conversa_id:'c',canal:'telegram' as const,response_text:'r',lease_token:'dl'}
    const d=deps({
      beginActivity:vi.fn().mockResolvedValue({attempt_id:'g',expires_at:''}),
      completePaced:vi.fn().mockResolvedValue({remaining_ms:9}),
      claimDelivery:vi.fn().mockResolvedValueOnce(delivery).mockResolvedValue(null),
      adoptActivity:vi.fn().mockResolvedValue({attempt_id:'d',expires_at:''}),
      beginDelivery:vi.fn().mockResolvedValue(false),
      clearActivity:vi.fn().mockResolvedValue(true),
    })
    await runSofiaBatchMaintenance(d,2)
    expect(d.sleep).toHaveBeenCalledWith(9)
    expect(d.sendTelegram).not.toHaveBeenCalled()
    expect(d.clearActivity).toHaveBeenCalledWith('b','d')
  })
  it('delegates the durable remainder to Evolution composing after the final delivery fence', async () => {
    vi.stubEnv('SOFIA_INBOUND_BATCH_RUNTIME_ENABLED','true')
    const delivery={batch_id:'b',conversa_id:'c',canal:'whatsapp' as const,response_text:'r',lease_token:'dl'}
    const d=deps({
      beginActivity:vi.fn().mockResolvedValue({attempt_id:'g',expires_at:''}),
      completePaced:vi.fn().mockResolvedValue({remaining_ms:37}),
      claimDelivery:vi.fn().mockResolvedValueOnce(delivery).mockResolvedValue(null),
      adoptActivity:vi.fn().mockResolvedValue({attempt_id:'d',expires_at:''}),
      clearActivity:vi.fn().mockResolvedValue(true),
    })
    await runSofiaBatchMaintenance(d,2)
    expect(d.sleep).toHaveBeenCalledWith(37)
     expect(d.sleep).toHaveBeenCalledBefore(d.beginDelivery as ReturnType<typeof vi.fn>)

    expect(d.beginDelivery).toHaveBeenCalledBefore(d.sendWhatsApp as ReturnType<typeof vi.fn>)
    expect(d.sendWhatsApp).toHaveBeenCalledWith('c','r',37)
  })
  it('finalizes a claimed Web delivery without invoking a provider sender', async () => {
    vi.stubEnv('SOFIA_INBOUND_BATCH_RUNTIME_ENABLED','true')
    const delivery={batch_id:'b',conversa_id:'c',canal:'web' as const,response_text:'r',lease_token:'dl'}
    const d=deps({
      beginActivity:vi.fn().mockResolvedValue({attempt_id:'g',expires_at:''}),
      completePaced:vi.fn().mockResolvedValue({remaining_ms:37}),
      claimDelivery:vi.fn().mockResolvedValueOnce(delivery).mockResolvedValue(null),
      adoptActivity:vi.fn().mockResolvedValue({attempt_id:'d',expires_at:''}),
      clearActivity:vi.fn().mockResolvedValue(true),
    })

    const result=await runSofiaBatchMaintenance(d,2)

    expect(d.beginDelivery).toHaveBeenCalledWith('b','dl')
    expect(d.sendTelegram).not.toHaveBeenCalled()
    expect(d.sendWhatsApp).not.toHaveBeenCalled()
    expect(d.clearActivity).toHaveBeenCalledWith('b','d')
    expect(result.delivery_attempted).toBe(1)
  })
  it('uses the Web admission gate rather than a provider global gate for Web batches', async () => {
    const claim={batch_id:'web-b',conversa_id:'c',cliente_id:'customer',channel:'web' as const,lease_token:'web-l',eligibility:{db_eligible:true},members:[]}
    const d=deps({claimBatch:vi.fn().mockResolvedValueOnce(claim).mockResolvedValue(null)})

    await runSofiaBatchMaintenance(d,1)

    expect(d.globalEnabled).not.toHaveBeenCalled()
    expect(d.complete).toHaveBeenCalledWith('web-b','web-l','resposta')
  })
  it('clears G and the Telegram typing handle when paced completion loses its fence', async () => {
    vi.stubEnv('SOFIA_INBOUND_BATCH_RUNTIME_ENABLED','true')
    const d=deps({beginActivity:vi.fn().mockResolvedValue({attempt_id:'g',expires_at:''}),completePaced:vi.fn().mockResolvedValue(null),clearActivity:vi.fn().mockResolvedValue(true),setInterval:vi.fn(()=> 'typing'),clearInterval:vi.fn()})
    await runSofiaBatchMaintenance(d,1)
    expect(d.clearActivity).toHaveBeenCalledWith('b','g')
    expect(d.clearInterval).toHaveBeenCalledWith('typing')
  })
  it('keeps one retained Telegram typing handle across generation and delivery without granting final delivery', async () => {
    vi.stubEnv('SOFIA_INBOUND_BATCH_RUNTIME_ENABLED','true')
    const delivery={batch_id:'b',conversa_id:'c',canal:'telegram' as const,response_text:'r',lease_token:'dl'}
    const timers: Array<() => void> = []
    const d=deps({
      beginActivity:vi.fn().mockResolvedValue({attempt_id:'g',expires_at:''}),
      completePaced:vi.fn().mockResolvedValue({remaining_ms:0}),
      claimDelivery:vi.fn().mockResolvedValueOnce(delivery).mockResolvedValue(null),
      adoptActivity:vi.fn().mockResolvedValue({attempt_id:'d',expires_at:''}),
      setInterval:vi.fn(callback=>{timers.push(callback);return timers.length}),
      clearInterval:vi.fn(),
    })
    await runSofiaBatchMaintenance(d,2)
    expect(d.sendTelegramTyping).toHaveBeenCalledWith('c')
    expect(d.sendTelegramTyping).toHaveBeenCalledBefore(d.generate as ReturnType<typeof vi.fn>)
    expect(d.setInterval).toHaveBeenCalledWith(expect.any(Function),4_000)
    expect(vi.mocked(provided(d.setInterval)).mock.calls.filter(([,ms])=>ms===4_000)).toHaveLength(1)
    expect(d.sendTelegramTyping).toHaveBeenCalledTimes(1)
    expect(d.sendTelegramTyping).toHaveBeenCalledBefore(d.beginDelivery as ReturnType<typeof vi.fn>)
    const typingClears=vi.mocked(provided(d.clearInterval)).mock.calls.map((call,index)=>({timer:call[0],order:vi.mocked(provided(d.clearInterval)).mock.invocationCallOrder[index]!})).filter(entry=>entry.timer===2)
    expect(typingClears).toHaveLength(1)
    expect(typingClears[0]!.order).toBeGreaterThan(vi.mocked(d.beginDelivery).mock.invocationCallOrder[0]!)
    expect(d.clearInterval).toHaveBeenCalledTimes(2)
    timers.forEach(timer=>timer())
    await Promise.resolve()
    expect(d.sendTelegramTyping).toHaveBeenCalledTimes(1)
  })
  it('keeps Telegram typing refreshed through the paced wait until a pending send settles', async () => {
    vi.stubEnv('SOFIA_INBOUND_BATCH_RUNTIME_ENABLED','true')
    const delivery={batch_id:'b',conversa_id:'c',canal:'telegram' as const,response_text:'r',lease_token:'dl'}
    const typingTimers: Array<() => void> = []
    let releaseSend!:(value:unknown)=>void
    const pendingSend=new Promise(resolve=>{releaseSend=resolve})
    const d=deps({
      beginActivity:vi.fn().mockResolvedValue({attempt_id:'g',expires_at:''}),
      completePaced:vi.fn().mockResolvedValue({remaining_ms:2500}),
      claimDelivery:vi.fn().mockResolvedValueOnce(delivery).mockResolvedValue(null),
      adoptActivity:vi.fn().mockResolvedValue({attempt_id:'d',expires_at:''}),
      clearActivity:vi.fn().mockResolvedValue(true),
      sendTelegram:vi.fn().mockReturnValue(pendingSend),
      setInterval:vi.fn((callback,ms)=>{if(ms===4_000){typingTimers.push(callback);return `typing-${typingTimers.length}`}return 'heartbeat'}),
      clearInterval:vi.fn(),
    })
    const run=runSofiaBatchMaintenance(d,2)
    await vi.waitFor(()=>expect(d.sendTelegram).toHaveBeenCalledTimes(1))
    expect(d.sleep).toHaveBeenCalledWith(2500)
    expect(d.sendTelegramTyping).toHaveBeenCalledBefore(d.sleep as ReturnType<typeof vi.fn>)
    expect(d.sendTelegramTyping).toHaveBeenCalledTimes(1)
    expect(d.clearInterval).not.toHaveBeenCalledWith('typing-1')
    typingTimers.at(-1)!()
    await Promise.resolve()
    const typingCalls=vi.mocked(d.sendTelegramTyping).mock.invocationCallOrder
    expect(d.sendTelegramTyping).toHaveBeenCalledTimes(2)
    expect(typingCalls[typingCalls.length-1]).toBeGreaterThan(vi.mocked(d.sendTelegram).mock.invocationCallOrder[0]!)
    expect(d.clearInterval).not.toHaveBeenCalledWith('typing-1')
    releaseSend({success:true})
    await run
    expect(d.clearInterval).toHaveBeenCalledWith('typing-1')
  })
  it('clears Telegram typing when the pending provider send throws', async () => {
    vi.stubEnv('SOFIA_INBOUND_BATCH_RUNTIME_ENABLED','true')
    const delivery={batch_id:'b',conversa_id:'c',canal:'telegram' as const,response_text:'r',lease_token:'dl'}
    const typingTimers: Array<() => void> = []
    const d=deps({
      beginActivity:vi.fn().mockResolvedValue({attempt_id:'g',expires_at:''}),
      completePaced:vi.fn().mockResolvedValue({remaining_ms:2500}),
      claimDelivery:vi.fn().mockResolvedValueOnce(delivery).mockResolvedValue(null),
      adoptActivity:vi.fn().mockResolvedValue({attempt_id:'d',expires_at:''}),
      clearActivity:vi.fn().mockResolvedValue(true),
      sendTelegram:vi.fn().mockRejectedValue(Error('provider')),
      setInterval:vi.fn((callback,ms)=>{if(ms===4_000){typingTimers.push(callback);return `typing-${typingTimers.length}`}return 'heartbeat'}),
      clearInterval:vi.fn(),
    })
    const result=await runSofiaBatchMaintenance(d,2)
    expect(d.recordDeliveryFailure).toHaveBeenCalledWith('b','provider_unavailable')
    expect(result.delivery_attempted).toBe(1)
    expect(d.clearInterval).toHaveBeenCalledWith('typing-1')
    expect(d.clearActivity).toHaveBeenCalledWith('b','d')
  })
  it('keeps a retained Telegram typing handle refreshing while a second generation is pending', async () => {
    vi.stubEnv('SOFIA_INBOUND_BATCH_RUNTIME_ENABLED','true')
    const second={...claim,batch_id:'b2'}
    const typingTimers: Array<() => void> = []
    let generationCalls=0,releaseSecond!:(text:string)=>void
    const secondGeneration=new Promise<string>(resolve=>{releaseSecond=resolve})
    const d=deps({
      claimBatch:vi.fn().mockResolvedValueOnce(claim).mockResolvedValueOnce(second).mockResolvedValue(null),
      beginActivity:vi.fn().mockResolvedValue({attempt_id:'g',expires_at:''}),
      completePaced:vi.fn().mockResolvedValue({remaining_ms:0}),
      clearActivity:vi.fn().mockResolvedValue(true),
      generate:vi.fn().mockImplementation(()=>{generationCalls++;return generationCalls===1?Promise.resolve('resposta'):secondGeneration}),
      setInterval:vi.fn((callback,ms)=>{if(ms===4_000){typingTimers.push(callback);return `typing-${typingTimers.length}`}return 'heartbeat'}),
      clearInterval:vi.fn(),
    })
    const run=runSofiaBatchMaintenance(d,4)
    await vi.waitFor(()=>expect(d.generate).toHaveBeenCalledTimes(2))
    expect(d.completePaced).toHaveBeenCalledTimes(1)
    expect(d.sendTelegramTyping).toHaveBeenCalledTimes(2)
    expect(d.clearInterval).not.toHaveBeenCalledWith('typing-1')
    typingTimers[0]!()
    await Promise.resolve()
    expect(d.sendTelegramTyping).toHaveBeenCalledTimes(3)
    expect(d.clearInterval).not.toHaveBeenCalledWith('typing-1')
    releaseSecond('resposta')
    await run
    expect(d.clearInterval).toHaveBeenCalledWith('typing-1')
    expect(d.clearInterval).toHaveBeenCalledWith('typing-2')
  })
  it('bounds retained Telegram typing refreshes while one refresh is still pending', async () => {
    vi.stubEnv('SOFIA_INBOUND_BATCH_RUNTIME_ENABLED','true')
    const second={...claim,batch_id:'b2'}
    const typingTimers: Array<() => void> = []
    const pendingTyping=new Promise<unknown>(()=>undefined)
    let typingCalls=0,generationCalls=0,releaseSecond!:(text:string)=>void
    const secondGeneration=new Promise<string>(resolve=>{releaseSecond=resolve})
    const d=deps({
      claimBatch:vi.fn().mockResolvedValueOnce(claim).mockResolvedValueOnce(second).mockResolvedValue(null),
      beginActivity:vi.fn().mockResolvedValue({attempt_id:'g',expires_at:''}),
      completePaced:vi.fn().mockResolvedValue({remaining_ms:0}),
      clearActivity:vi.fn().mockResolvedValue(true),
      generate:vi.fn().mockImplementation(()=>{generationCalls++;return generationCalls===1?Promise.resolve('resposta'):secondGeneration}),
      sendTelegramTyping:vi.fn().mockImplementation(()=>{typingCalls++;return typingCalls===1?Promise.resolve({outcome:'accepted'}):pendingTyping}),
      setInterval:vi.fn((callback,ms)=>{if(ms===4_000){typingTimers.push(callback);return `typing-${typingTimers.length}`}return 'heartbeat'}),
      clearInterval:vi.fn(),
    })
    const run=runSofiaBatchMaintenance(d,4)
    await vi.waitFor(()=>expect(d.generate).toHaveBeenCalledTimes(2))
    typingTimers[0]!();typingTimers[0]!()
    await Promise.resolve()
    expect(typingCalls).toBe(3)
    releaseSecond('resposta')
    await run
    expect(d.clearInterval).toHaveBeenCalledWith('typing-1')
    expect(d.clearInterval).toHaveBeenCalledWith('typing-2')
  })
  it('releases a retained Telegram typing handle when delivery adoption fails', async () => {
    vi.stubEnv('SOFIA_INBOUND_BATCH_RUNTIME_ENABLED','true')
    const delivery={batch_id:'b',conversa_id:'c',canal:'telegram' as const,response_text:'r',lease_token:'dl'}
    const typingTimers: Array<() => void> = []
    const d=deps({
      beginActivity:vi.fn().mockResolvedValue({attempt_id:'g',expires_at:''}),
      completePaced:vi.fn().mockResolvedValue({remaining_ms:0}),
      claimDelivery:vi.fn().mockResolvedValueOnce(delivery).mockResolvedValue(null),
      adoptActivity:vi.fn().mockResolvedValue(null),
      clearActivity:vi.fn().mockResolvedValue(true),
      setInterval:vi.fn((callback,ms)=>{if(ms===4_000){typingTimers.push(callback);return `typing-${typingTimers.length}`}return 'heartbeat'}),
      clearInterval:vi.fn(),
    })
    const result=await runSofiaBatchMaintenance(d,2)
    expect(result).toMatchObject({completed:1,delivery_attempted:0})
    expect(d.clearActivity).not.toHaveBeenCalledWith('b','g')
    expect(vi.mocked(provided(d.setInterval)).mock.calls.filter(([,ms])=>ms===4_000)).toHaveLength(1)
    expect(d.sendTelegramTyping).toHaveBeenCalledTimes(1)
    expect(d.clearInterval).toHaveBeenCalledWith('typing-1')
    const typingClearOrder=vi.mocked(provided(d.clearInterval)).mock.invocationCallOrder[vi.mocked(provided(d.clearInterval)).mock.calls.findIndex(call=>call[0]==='typing-1')]!
    expect(typingClearOrder).toBeGreaterThan(vi.mocked(d.adoptActivity).mock.invocationCallOrder[0]!)
    expect(d.sendTelegram).not.toHaveBeenCalled()
  })
  it('releases retained Telegram typing when delivery claiming or adoption throws', async () => {
    vi.stubEnv('SOFIA_INBOUND_BATCH_RUNTIME_ENABLED','true')
    const setup={beginActivity:vi.fn().mockResolvedValue({attempt_id:'g',expires_at:''}),completePaced:vi.fn().mockResolvedValue({remaining_ms:0}),clearActivity:vi.fn().mockResolvedValue(true),setInterval:vi.fn((callback,ms)=>{if(ms===4_000)return 'typing';return 'heartbeat'}),clearInterval:vi.fn()}
    const claiming=deps({...setup,claimDelivery:vi.fn().mockRejectedValue(Error('claim'))})
    await expect(runSofiaBatchMaintenance(claiming,2)).rejects.toThrow()
    expect(claiming.clearInterval).toHaveBeenCalledWith('typing')
    const adopting=deps({...setup,claimDelivery:vi.fn().mockResolvedValueOnce({batch_id:'b',conversa_id:'c',canal:'telegram' as const,response_text:'r',lease_token:'dl'}).mockResolvedValue(null),adoptActivity:vi.fn().mockRejectedValue(Error('adopt'))})
    await expect(runSofiaBatchMaintenance(adopting,2)).rejects.toThrow()
    expect(adopting.clearInterval).toHaveBeenCalledWith('typing')
    expect(adopting.sendTelegram).not.toHaveBeenCalled()
  })
  it.each(['whatsapp','web'] as const)('never starts Telegram typing for %s batches', async channel => {
    vi.stubEnv('SOFIA_INBOUND_BATCH_RUNTIME_ENABLED','true')
    const claimed={...claim,batch_id:`b-${channel}`,channel}
    const d=deps({claimBatch:vi.fn().mockResolvedValueOnce(claimed).mockResolvedValue(null),beginActivity:vi.fn().mockResolvedValue({attempt_id:'g',expires_at:''}),claimDelivery:vi.fn().mockResolvedValue(null),clearActivity:vi.fn().mockResolvedValue(true),setInterval:vi.fn(()=> 'typing'),clearInterval:vi.fn()})
    await runSofiaBatchMaintenance(d,2)
    expect(d.sendTelegramTyping).not.toHaveBeenCalled()
    expect(vi.mocked(provided(d.setInterval)).mock.calls.some(([,ms])=>ms===4_000)).toBe(false)
  })
  it('waits the durable claimed remainder when no local paced state survives an invocation', async () => {
    vi.stubEnv('SOFIA_INBOUND_BATCH_RUNTIME_ENABLED','true')
    const delivery={batch_id:'b',conversa_id:'c',canal:'telegram' as const,response_text:'r',lease_token:'dl',remaining_ms:3400}
    const d=deps({
      claimBatch:vi.fn().mockResolvedValue(null),
      claimDelivery:vi.fn().mockResolvedValueOnce(delivery).mockResolvedValue(null),
      adoptActivity:vi.fn().mockResolvedValue({attempt_id:'d',expires_at:''}),
      clearActivity:vi.fn().mockResolvedValue(true),
    })
    const result=await runSofiaBatchMaintenance(d,1)
    expect(result).toMatchObject({claimed:0,delivery_attempted:1})
    expect(d.sleep).toHaveBeenCalledWith(3400)
    expect(d.sendTelegramTyping).toHaveBeenCalledWith('c')
    expect(d.sendTelegramTyping).toHaveBeenCalledBefore(d.sleep as ReturnType<typeof vi.fn>)
    expect(d.sleep).toHaveBeenCalledBefore(d.beginDelivery as ReturnType<typeof vi.fn>)
    expect(d.beginDelivery).toHaveBeenCalledBefore(d.sendTelegram as ReturnType<typeof vi.fn>)
  })
  it('prefers the durable claim remainder over a stale local paced state', async () => {
    vi.stubEnv('SOFIA_INBOUND_BATCH_RUNTIME_ENABLED','true')
    const delivery={batch_id:'b',conversa_id:'c',canal:'telegram' as const,response_text:'r',lease_token:'dl',remaining_ms:900}
    const d=deps({
      beginActivity:vi.fn().mockResolvedValue({attempt_id:'g',expires_at:''}),
      completePaced:vi.fn().mockResolvedValue({remaining_ms:37}),
      claimDelivery:vi.fn().mockResolvedValueOnce(delivery).mockResolvedValue(null),
      adoptActivity:vi.fn().mockResolvedValue({attempt_id:'d',expires_at:''}),
      clearActivity:vi.fn().mockResolvedValue(true),
    })
    await runSofiaBatchMaintenance(d,2)
    expect(d.sleep).toHaveBeenCalledWith(900)
    expect(d.sleep).not.toHaveBeenCalledWith(37)
  })
  const durableRemainders: Array<[string, number | null | undefined]> = [['0 ms',0],['absent',undefined],['null',null],['1 ms',1],['900 ms',900]]
  it.each(durableRemainders)('restarts Telegram typing and applies the 2000ms floor to a %s claimed remainder without a retained generation handle', async (_label, remainingMs) => {
    vi.stubEnv('SOFIA_INBOUND_BATCH_RUNTIME_ENABLED','true')
    const delivery={batch_id:'b',conversa_id:'c',canal:'telegram' as const,response_text:'r',lease_token:'dl',remaining_ms:remainingMs}
    const d=deps({
      claimBatch:vi.fn().mockResolvedValue(null),
      claimDelivery:vi.fn().mockResolvedValueOnce(delivery).mockResolvedValue(null),
      adoptActivity:vi.fn().mockResolvedValue({attempt_id:'d',expires_at:''}),
      clearActivity:vi.fn().mockResolvedValue(true),
      setInterval:vi.fn(()=> 'typing'),
      clearInterval:vi.fn(),
    })
    const result=await runSofiaBatchMaintenance(d,1)
    expect(result).toMatchObject({claimed:0,delivery_attempted:1})
    expect(d.sleep).toHaveBeenCalledTimes(1)
    expect(d.sleep).toHaveBeenCalledWith(2000)
    expect(d.sleep).not.toHaveBeenCalledWith(remainingMs)
    expect(d.sendTelegramTyping).toHaveBeenCalledWith('c')
    expect(d.sendTelegramTyping).toHaveBeenCalledBefore(d.sleep as ReturnType<typeof vi.fn>)
    expect(d.sleep).toHaveBeenCalledBefore(d.beginDelivery as ReturnType<typeof vi.fn>)
    expect(d.beginDelivery).toHaveBeenCalledBefore(d.sendTelegram as ReturnType<typeof vi.fn>)
    expect(d.clearInterval).toHaveBeenCalledWith('typing')
    expect(d.clearActivity).toHaveBeenCalledWith('b','d')
  })
  it('keeps a retained generation handle on its durable zero wait without applying the restart floor', async () => {
    vi.stubEnv('SOFIA_INBOUND_BATCH_RUNTIME_ENABLED','true')
    const delivery={batch_id:'b',conversa_id:'c',canal:'telegram' as const,response_text:'r',lease_token:'dl',remaining_ms:0}
    const d=deps({
      beginActivity:vi.fn().mockResolvedValue({attempt_id:'g',expires_at:''}),
      completePaced:vi.fn().mockResolvedValue({remaining_ms:0}),
      claimDelivery:vi.fn().mockResolvedValueOnce(delivery).mockResolvedValue(null),
      adoptActivity:vi.fn().mockResolvedValue({attempt_id:'d',expires_at:''}),
      clearActivity:vi.fn().mockResolvedValue(true),
    })
    await runSofiaBatchMaintenance(d,2)
    expect(d.sleep).toHaveBeenCalledTimes(1)
    expect(d.sleep).toHaveBeenCalledWith(0)
    expect(d.sleep).not.toHaveBeenCalledWith(2000)
    expect(d.sendTelegramTyping).toHaveBeenCalledTimes(1)
  })
  const rejectedRemainders: Array<[string, number | null | undefined]> = [['0 ms',0],['an absent',undefined]]
  it.each(rejectedRemainders)('applies no restart typing or floor wait when adoption rejects a %s claimed remainder', async (_label, remainingMs) => {
    vi.stubEnv('SOFIA_INBOUND_BATCH_RUNTIME_ENABLED','true')
    const delivery={batch_id:'b',conversa_id:'c',canal:'telegram' as const,response_text:'r',lease_token:'dl',remaining_ms:remainingMs}
    const d=deps({
      claimBatch:vi.fn().mockResolvedValue(null),
      claimDelivery:vi.fn().mockResolvedValueOnce(delivery).mockResolvedValue(null),
      adoptActivity:vi.fn().mockResolvedValue(null),
    })
    const result=await runSofiaBatchMaintenance(d,1)
    expect(result).toMatchObject({delivery_attempted:0})
    expect(d.sleep).not.toHaveBeenCalled()
    expect(d.sendTelegramTyping).not.toHaveBeenCalled()
    expect(d.beginDelivery).not.toHaveBeenCalled()
    expect(d.sendTelegram).not.toHaveBeenCalled()
  })
  it('repeats the restart floor in an independent invocation after an interrupted one', async () => {
    vi.stubEnv('SOFIA_INBOUND_BATCH_RUNTIME_ENABLED','true')
    const retainedDelivery={batch_id:'b',conversa_id:'c',canal:'telegram' as const,response_text:'r',lease_token:'dl',remaining_ms:0}
    const first=deps({
      beginActivity:vi.fn().mockResolvedValue({attempt_id:'g',expires_at:''}),
      completePaced:vi.fn().mockResolvedValue({remaining_ms:0}),
      claimDelivery:vi.fn().mockResolvedValueOnce(retainedDelivery).mockResolvedValue(null),
      adoptActivity:vi.fn().mockResolvedValue({attempt_id:'d',expires_at:''}),
      clearActivity:vi.fn().mockResolvedValue(true),
    })
    await runSofiaBatchMaintenance(first,2)
    expect(first.sleep).toHaveBeenCalledWith(0)
    expect(first.sendTelegramTyping).toHaveBeenCalledTimes(1)
    const orphanedDelivery={batch_id:'b',conversa_id:'c',canal:'telegram' as const,response_text:'r',lease_token:'dl'}
    const second=deps({
      claimBatch:vi.fn().mockResolvedValue(null),
      claimDelivery:vi.fn().mockResolvedValueOnce(orphanedDelivery).mockResolvedValue(null),
      adoptActivity:vi.fn().mockResolvedValue({attempt_id:'d',expires_at:''}),
      clearActivity:vi.fn().mockResolvedValue(true),
    })
    await runSofiaBatchMaintenance(second,1)
    expect(second.sleep).toHaveBeenCalledWith(2000)
    expect(second.sendTelegramTyping).toHaveBeenCalledWith('c')
    expect(second.sendTelegramTyping).toHaveBeenCalledBefore(second.sleep as ReturnType<typeof vi.fn>)
  })
  it('keeps the restarted Telegram typing alive through the floor wait and a pending send until it settles', async () => {
    vi.stubEnv('SOFIA_INBOUND_BATCH_RUNTIME_ENABLED','true')
    const delivery={batch_id:'b',conversa_id:'c',canal:'telegram' as const,response_text:'r',lease_token:'dl',remaining_ms:900}
    const typingTimers: Array<() => void> = []
    let releaseSend!:(value:unknown)=>void
    const pendingSend=new Promise(resolve=>{releaseSend=resolve})
    const d=deps({
      claimBatch:vi.fn().mockResolvedValue(null),
      claimDelivery:vi.fn().mockResolvedValueOnce(delivery).mockResolvedValue(null),
      adoptActivity:vi.fn().mockResolvedValue({attempt_id:'d',expires_at:''}),
      clearActivity:vi.fn().mockResolvedValue(true),
      sendTelegram:vi.fn().mockReturnValue(pendingSend),
      setInterval:vi.fn((callback,ms)=>{if(ms===4_000){typingTimers.push(callback);return `typing-${typingTimers.length}`}return 'heartbeat'}),
      clearInterval:vi.fn(),
    })
    const run=runSofiaBatchMaintenance(d,1)
    await vi.waitFor(()=>expect(d.sendTelegram).toHaveBeenCalledTimes(1))
    expect(d.sleep).toHaveBeenCalledWith(2000)
    expect(d.sendTelegramTyping).toHaveBeenCalledBefore(d.sleep as ReturnType<typeof vi.fn>)
    expect(d.clearInterval).not.toHaveBeenCalledWith('typing-1')
    typingTimers.at(-1)!()
    await Promise.resolve()
    expect(d.sendTelegramTyping).toHaveBeenCalledTimes(2)
    expect(d.clearInterval).not.toHaveBeenCalledWith('typing-1')
    releaseSend({success:true})
    await run
    expect(d.clearInterval).toHaveBeenCalledWith('typing-1')
    expect(d.clearActivity).toHaveBeenCalledWith('b','d')
  })
  it('clears the restarted Telegram typing handle when the provider send fails', async () => {
    vi.stubEnv('SOFIA_INBOUND_BATCH_RUNTIME_ENABLED','true')
    const delivery={batch_id:'b',conversa_id:'c',canal:'telegram' as const,response_text:'r',lease_token:'dl'}
    const d=deps({
      claimBatch:vi.fn().mockResolvedValue(null),
      claimDelivery:vi.fn().mockResolvedValueOnce(delivery).mockResolvedValue(null),
      adoptActivity:vi.fn().mockResolvedValue({attempt_id:'d',expires_at:''}),
      clearActivity:vi.fn().mockResolvedValue(true),
      sendTelegram:vi.fn().mockRejectedValue(Error('provider')),
      setInterval:vi.fn((callback,ms)=>{if(ms===4_000)return 'typing';return 'heartbeat'}),
      clearInterval:vi.fn(),
    })
    const result=await runSofiaBatchMaintenance(d,1)
    expect(d.sleep).toHaveBeenCalledWith(2000)
    expect(d.recordDeliveryFailure).toHaveBeenCalledWith('b','provider_unavailable')
    expect(result.delivery_attempted).toBe(1)
    expect(d.clearInterval).toHaveBeenCalledWith('typing')
    expect(d.clearActivity).toHaveBeenCalledWith('b','d')
  })
  it('never types, waits, or sends for an unadopted delivery claim', async () => {
    vi.stubEnv('SOFIA_INBOUND_BATCH_RUNTIME_ENABLED','true')
    const delivery={batch_id:'b',conversa_id:'c',canal:'telegram' as const,response_text:'r',lease_token:'dl',remaining_ms:3400}
    const d=deps({
      claimBatch:vi.fn().mockResolvedValue(null),
      claimDelivery:vi.fn().mockResolvedValueOnce(delivery).mockResolvedValue(null),
      adoptActivity:vi.fn().mockResolvedValue(null),
      setInterval:vi.fn(()=> 'timer'),
      clearInterval:vi.fn(),
    })
    const result=await runSofiaBatchMaintenance(d,1)
    expect(result).toMatchObject({delivery_attempted:0})
    expect(d.sleep).not.toHaveBeenCalled()
    expect(d.sendTelegramTyping).not.toHaveBeenCalled()
    expect(d.sendTelegram).not.toHaveBeenCalled()
    expect(d.setInterval).not.toHaveBeenCalledWith(expect.any(Function),4_000)
  })
  it('treats Telegram typing failures as best effort', async () => {
    vi.stubEnv('SOFIA_INBOUND_BATCH_RUNTIME_ENABLED','true')
    const d=deps({
      beginActivity:vi.fn().mockResolvedValue({attempt_id:'g',expires_at:''}),
      clearActivity:vi.fn().mockResolvedValue(true),
      sendTelegramTyping:vi.fn().mockImplementation(()=>{throw Error('provider')}),
    })
    const result=await runSofiaBatchMaintenance(d,1)
    expect(result).toMatchObject({completed:1,failed:0})
    expect(d.completePaced).toHaveBeenCalledOnce()
  })
  it('observes one sanitized typing attempt and its settled outcome per dispatched refresh',async()=>{
    vi.stubEnv('SOFIA_INBOUND_BATCH_RUNTIME_ENABLED','true')
    const events:unknown[]=[]
    const d=deps({beginActivity:vi.fn().mockResolvedValue({attempt_id:'g',expires_at:''}),clearActivity:vi.fn().mockResolvedValue(true),observeTelegramTyping:observe(events)})
    const result=await runSofiaBatchMaintenance(d,1)
    expect(result).toMatchObject({completed:1,failed:0})
    expect(d.sendTelegramTyping).toHaveBeenCalledTimes(1)
    expect(events).toEqual([{tag:'telegram_typing',event:'attempt'},{tag:'telegram_typing',event:'accepted'}])
  })
  it('observes the settled typing outcome only after the typing promise settles',async()=>{
    vi.stubEnv('SOFIA_INBOUND_BATCH_RUNTIME_ENABLED','true')
    const events:unknown[]=[]
    let settleTyping!:(value:unknown)=>void
    const pendingTyping=new Promise(resolve=>{settleTyping=resolve})
    const d=deps({beginActivity:vi.fn().mockResolvedValue({attempt_id:'g',expires_at:''}),clearActivity:vi.fn().mockResolvedValue(true),sendTelegramTyping:vi.fn().mockReturnValue(pendingTyping),observeTelegramTyping:observe(events)})
    const run=runSofiaBatchMaintenance(d,1)
    await vi.waitFor(()=>expect(events).toHaveLength(1))
    expect(events).toEqual([{tag:'telegram_typing',event:'attempt'}])
    settleTyping({outcome:'accepted'})
    await run
    await vi.waitFor(()=>expect(events).toHaveLength(2))
    expect(events).toEqual([{tag:'telegram_typing',event:'attempt'},{tag:'telegram_typing',event:'accepted'}])
  })
  it.each([
    {outcome:'rejected',reason:'provider_rejected'},
    {outcome:'unavailable',reason:'token_missing'},
    {outcome:'unavailable',reason:'network_error'},
  ] as const)('settles a $outcome typing outcome without failing delivery',async report=>{
    vi.stubEnv('SOFIA_INBOUND_BATCH_RUNTIME_ENABLED','true')
    const events:unknown[]=[]
    const delivery={batch_id:'b',conversa_id:'c',canal:'telegram' as const,response_text:'r',lease_token:'dl'}
    const d=deps({
      beginActivity:vi.fn().mockResolvedValue({attempt_id:'g',expires_at:''}),
      completePaced:vi.fn().mockResolvedValue({remaining_ms:0}),
      claimDelivery:vi.fn().mockResolvedValueOnce(delivery).mockResolvedValue(null),
      adoptActivity:vi.fn().mockResolvedValue({attempt_id:'d',expires_at:''}),
      clearActivity:vi.fn().mockResolvedValue(true),
      sendTelegramTyping:vi.fn().mockResolvedValue(report),
      observeTelegramTyping:observe(events),
    })
    const result=await runSofiaBatchMaintenance(d,2)
    expect(result).toMatchObject({completed:1,failed:0,delivery_attempted:1})
    expect(d.sendTelegram).toHaveBeenCalledWith('c','r')
    expect(events).toEqual([{tag:'telegram_typing',event:'attempt'},{tag:'telegram_typing',event:report.outcome,reason:report.reason}])
  })
  it('keeps typing single-flight and stops observing new attempts once the retained handle is released',async()=>{
    vi.stubEnv('SOFIA_INBOUND_BATCH_RUNTIME_ENABLED','true')
    const events:unknown[]=[]
    const typingTimers:Array<()=>void>=[]
    const delivery={batch_id:'b',conversa_id:'c',canal:'telegram' as const,response_text:'r',lease_token:'dl'}
    const d=deps({
      beginActivity:vi.fn().mockResolvedValue({attempt_id:'g',expires_at:''}),
      completePaced:vi.fn().mockResolvedValue({remaining_ms:0}),
      claimDelivery:vi.fn().mockResolvedValueOnce(delivery).mockResolvedValue(null),
      adoptActivity:vi.fn().mockResolvedValue({attempt_id:'d',expires_at:''}),
      clearActivity:vi.fn().mockResolvedValue(true),
      observeTelegramTyping:observe(events),
      setInterval:vi.fn((callback,ms)=>{if(ms===4_000){typingTimers.push(callback);return 'typing'}return 'heartbeat'}),
      clearInterval:vi.fn(),
    })
    await runSofiaBatchMaintenance(d,2)
    expect(d.sendTelegramTyping).toHaveBeenCalledTimes(1)
    expect(d.clearInterval).toHaveBeenCalledWith('typing')
    expect(events).toEqual([{tag:'telegram_typing',event:'attempt'},{tag:'telegram_typing',event:'accepted'}])
    typingTimers.forEach(timer=>timer())
    await Promise.resolve()
    expect(d.sendTelegramTyping).toHaveBeenCalledTimes(1)
    expect(events).toHaveLength(2)
  })
  it('keeps a throwing or rejecting typing observer from failing delivery or leaking an unhandled rejection',async()=>{
    vi.stubEnv('SOFIA_INBOUND_BATCH_RUNTIME_ENABLED','true')
    const unhandled:unknown[]=[]
    const onUnhandled=(reason:unknown)=>{unhandled.push(reason)}
    process.on('unhandledRejection',onUnhandled)
    try{
      const rejectingObserver=vi.fn(()=>Promise.reject(Error('observer down')))
      const rejecting=deps({beginActivity:vi.fn().mockResolvedValue({attempt_id:'g',expires_at:''}),clearActivity:vi.fn().mockResolvedValue(true),observeTelegramTyping:rejectingObserver})
      expect(await runSofiaBatchMaintenance(rejecting,1)).toMatchObject({completed:1,failed:0})
      expect(rejectingObserver).toHaveBeenCalled()
      const throwingObserver=vi.fn(()=>{throw Error('observer down')})
      const throwing=deps({beginActivity:vi.fn().mockResolvedValue({attempt_id:'g',expires_at:''}),clearActivity:vi.fn().mockResolvedValue(true),observeTelegramTyping:throwingObserver})
      expect(await runSofiaBatchMaintenance(throwing,1)).toMatchObject({completed:1,failed:0})
      expect(throwingObserver).toHaveBeenCalled()
      await new Promise(resolve=>setTimeout(resolve,0))
      expect(unhandled).toEqual([])
    }finally{process.off('unhandledRejection',onUnhandled)}
  })
  it('stops periodic typing refreshes immediately when the provider rejects the chat action', async () => {
    vi.stubEnv('SOFIA_INBOUND_BATCH_RUNTIME_ENABLED', 'true')
    const typingTimers: Array<() => void> = []
    const d = deps({
      beginActivity: vi.fn().mockResolvedValue({ attempt_id: 'g', expires_at: '' }),
      completePaced: vi.fn().mockResolvedValue({ remaining_ms: 0 }),
      sendTelegramTyping: vi.fn().mockResolvedValue({ outcome: 'rejected', reason: 'provider_rejected' }),
      setInterval: vi.fn((callback, ms) => {
        if (ms === TELEGRAM_TYPING_REFRESH_INTERVAL_MS) {
          typingTimers.push(callback)
          return 'typing-timer'
        }
        return 'heartbeat'
      }),
      clearInterval: vi.fn(),
      clearActivity: vi.fn().mockResolvedValue(true),
    })
    await runSofiaBatchMaintenance(d, 1)
    expect(d.sendTelegramTyping).toHaveBeenCalledTimes(1)
    expect(d.clearInterval).toHaveBeenCalledWith('typing-timer')
    // Trigger the collected timer: should not invoke sendTelegramTyping again because it was stopped
    typingTimers.forEach(timer => timer())
    await Promise.resolve()
    expect(d.sendTelegramTyping).toHaveBeenCalledTimes(1)
  })
  it('exports canonical TELEGRAM_TYPING_REFRESH_INTERVAL_MS matching the 4000ms periodic interval', () => {
    expect(TELEGRAM_TYPING_REFRESH_INTERVAL_MS).toBe(4_000)
    expect(TELEGRAM_TYPING_RESTART_FLOOR_MS).toBe(2_000)
  })
  it('restarts typing and waits the full remainder when unadopted delivery remainder exceeds the floor', async () => {
    vi.stubEnv('SOFIA_INBOUND_BATCH_RUNTIME_ENABLED', 'true')
    const delivery = { batch_id: 'b', conversa_id: 'c', canal: 'telegram' as const, response_text: 'r', lease_token: 'dl', remaining_ms: 3_500 }
    const d = deps({
      claimBatch: vi.fn().mockResolvedValue(null),
      claimDelivery: vi.fn().mockResolvedValueOnce(delivery).mockResolvedValue(null),
      adoptActivity: vi.fn().mockResolvedValue({ attempt_id: 'd', expires_at: '' }),
      clearActivity: vi.fn().mockResolvedValue(true),
      setInterval: vi.fn(() => 'typing'),
      clearInterval: vi.fn(),
    })
    const result = await runSofiaBatchMaintenance(d, 1)
    expect(result).toMatchObject({ claimed: 0, delivery_attempted: 1 })
    expect(d.sleep).toHaveBeenCalledWith(3_500)
    expect(d.sleep).not.toHaveBeenCalledWith(2_000)
    expect(d.sendTelegramTyping).toHaveBeenCalledWith('c')
    expect(d.sendTelegramTyping).toHaveBeenCalledBefore(d.sleep as ReturnType<typeof vi.fn>)
  })
  it.each([
    ['an unknown outcome',{outcome:'accepted_confirmed',reason:'provider_rejected'},{event:'unavailable'}],
    ['provider text in the reason',{outcome:'rejected',reason:'Bad Request: chat not found secret-token 1001'},{event:'rejected'}],
    ['a non object settlement','accepted',{event:'unavailable'}],
    ['a missing settlement',undefined,{event:'unavailable'}],
  ])('never forwards %s through the typing observer',async(_label,settlement,expected)=>{
    vi.stubEnv('SOFIA_INBOUND_BATCH_RUNTIME_ENABLED','true')
    const events:unknown[]=[]
    const d=deps({beginActivity:vi.fn().mockResolvedValue({attempt_id:'g',expires_at:''}),clearActivity:vi.fn().mockResolvedValue(true),sendTelegramTyping:vi.fn().mockResolvedValue(settlement),observeTelegramTyping:observe(events)})
    await runSofiaBatchMaintenance(d,1)
    expect(events).toEqual([{tag:'telegram_typing',event:'attempt'},{tag:'telegram_typing',...expected}])
    const serialized=JSON.stringify(events)
    expect(serialized).not.toContain('secret-token')
    expect(serialized).not.toContain('1001')
    expect(serialized).not.toContain('chat not found')
  })
  it('stops a deferred WhatsApp presence handle after a null delivery claim', async () => {
        vi.stubEnv('SOFIA_INBOUND_BATCH_RUNTIME_ENABLED','true')
        let resolvePresence!: (handle: { stop: () => void }) => void
        const stop = vi.fn()
        const deferredPresence = new Promise<{ stop: () => void }>(resolve => { resolvePresence = resolve })
        const d = deps({
          claimBatch: vi.fn().mockResolvedValueOnce({ ...claim, channel:'whatsapp' as const }).mockResolvedValue(null),
          beginActivity: vi.fn().mockResolvedValue({ attempt_id:'g', expires_at:'' }),
          clearActivity: vi.fn().mockResolvedValue(true),
          startWhatsAppPresence: vi.fn().mockReturnValue(deferredPresence),
          claimDelivery: vi.fn().mockResolvedValue(null),
        })
        await runSofiaBatchMaintenance(d, 1)
        resolvePresence({ stop })
        await Promise.resolve(); await Promise.resolve()
        expect(d.startWhatsAppPresence).toHaveBeenCalledWith('c', expect.any(Function))
        expect(stop).toHaveBeenCalledOnce()
      })
      it('stops a deferred WhatsApp presence handle after generation failure', async () => {
        vi.stubEnv('SOFIA_INBOUND_BATCH_RUNTIME_ENABLED','true')
        let resolvePresence!: (handle: { stop: () => void }) => void
        const stop = vi.fn()
        const deferredPresence = new Promise<{ stop: () => void }>(resolve => { resolvePresence = resolve })
        const d = deps({
          claimBatch: vi.fn().mockResolvedValueOnce({ ...claim, channel:'whatsapp' as const }).mockResolvedValue(null),
          beginActivity: vi.fn().mockResolvedValue({ attempt_id:'g', expires_at:'' }),
          clearActivity: vi.fn().mockResolvedValue(true),
          startWhatsAppPresence: vi.fn().mockReturnValue(deferredPresence),
          generate: vi.fn().mockRejectedValue(new Error('generation failed')),
        })
        await runSofiaBatchMaintenance(d, 1)
        resolvePresence({ stop })
        await Promise.resolve(); await Promise.resolve()
        expect(d.startWhatsAppPresence).toHaveBeenCalledWith('c', expect.any(Function))
        expect(stop).toHaveBeenCalledOnce()
      })
      it('reports sanitized WhatsApp presence initialization failure without blocking delivery', async () => {
        vi.stubEnv('SOFIA_INBOUND_BATCH_RUNTIME_ENABLED','true')
        const events: unknown[] = []
        const delivery = { batch_id:'b', conversa_id:'c', canal:'whatsapp' as const, response_text:'r', lease_token:'dl' }
        const d = deps({
          claimBatch: vi.fn().mockResolvedValueOnce({ ...claim, channel:'whatsapp' as const }).mockResolvedValue(null),
          beginActivity: vi.fn().mockResolvedValue({ attempt_id:'g', expires_at:'' }),
          completePaced: vi.fn().mockResolvedValue({ remaining_ms:0 }),
          claimDelivery: vi.fn().mockResolvedValueOnce(delivery).mockResolvedValue(null),
          adoptActivity: vi.fn().mockResolvedValue({ attempt_id:'d', expires_at:'' }),
          clearActivity: vi.fn().mockResolvedValue(true),
          startWhatsAppPresence: vi.fn().mockRejectedValue(new Error('provider secret leaked')),
          observeWhatsAppPresence: observe(events),
        })
        const result = await runSofiaBatchMaintenance(d, 2)
        expect(result).toMatchObject({ completed:1, delivery_attempted:1 })
        expect(d.sendWhatsApp).toHaveBeenCalledWith('c','r',0)
        expect(events).toEqual([{ tag:'evolution_presence', event:'unavailable', reason:'provider_unavailable' }])
        expect(JSON.stringify(events)).not.toContain('provider secret leaked')
      })
      it('starts presence from a provider whose class name was renamed by minification', async () => {
        const production = createSofiaBatchWorkerDeps({ rpc: vi.fn() } as never)
        const observer = vi.fn()
        const handle = { stop: vi.fn() }
        const provider = new presenceMocks.q()
        provider.iniciarPresenca.mockResolvedValue(handle)
        presenceMocks.state.activeProvider = provider
        const result = await provided(production.startWhatsAppPresence)('c', observer)
        expect(provider.iniciarPresenca).toHaveBeenCalledWith('c', observer)
        expect(result).toBe(handle)
      })
      it('does not start presence for a provider without the capability', async () => {
        const production = createSofiaBatchWorkerDeps({ rpc: vi.fn() } as never)
        presenceMocks.state.activeProvider = new presenceMocks.MetaProvider()
        const result = await provided(production.startWhatsAppPresence)('c', vi.fn())
        expect(result).toEqual({ stop: expect.any(Function) })
        expect(presenceMocks.startEvolutionPresence).not.toHaveBeenCalled()
      })
      it('wires a sanitized production WhatsApp presence observer', () => {
        const infoSpy = vi.spyOn(console,'info').mockImplementation(() => undefined)
        const production = createSofiaBatchWorkerDeps({} as never)
        const observeProduction = provided(production.observeWhatsAppPresence)
        observeProduction({ tag:'evolution_presence', event:'attempt' })
        observeProduction({ tag:'evolution_presence', event:'unavailable', reason:'provider_unavailable' })
        expect(infoSpy.mock.calls).toEqual([
          ['[sofia-inbound-batch] evolution_presence event=attempt'],
          ['[sofia-inbound-batch] evolution_presence event=unavailable reason=provider_unavailable'],
        ])
        infoSpy.mockRestore()
      })
      it('wires a sanitized production typing observer that emits only fixed tags and safe enums',()=>{
    const infoSpy=vi.spyOn(console,'info').mockImplementation(()=>undefined)
    const production=createSofiaBatchWorkerDeps({} as never)
    const observeProduction=provided(production.observeTelegramTyping)
    observeProduction({tag:'telegram_typing',event:'attempt'})
    observeProduction({tag:'telegram_typing',event:'rejected',reason:'provider_rejected'})
    expect(infoSpy.mock.calls).toEqual([
      ['[sofia-inbound-batch] telegram_typing event=attempt'],
      ['[sofia-inbound-batch] telegram_typing event=rejected reason=provider_rejected'],
    ])
    infoSpy.mockRestore()
  })
  it('serializes ten-second G heartbeats and discards output after a fence loss', async () => {
    vi.stubEnv('SOFIA_INBOUND_BATCH_RUNTIME_ENABLED','true')
    let heartbeat:(()=>void)|undefined,releaseGeneration!:(text:string)=>void,releaseRenewal!:(value:boolean)=>void
    const generation=new Promise<string>(resolve=>{releaseGeneration=resolve})
    const renewal=new Promise<boolean>(resolve=>{releaseRenewal=resolve})
    const d=deps({beginActivity:vi.fn().mockResolvedValue({attempt_id:'g',expires_at:''}),generate:vi.fn().mockReturnValue(generation),renewActivity:vi.fn().mockReturnValue(renewal),clearActivity:vi.fn().mockResolvedValue(true),setInterval:vi.fn((callback,ms)=>{if(ms===10_000)heartbeat=callback;return `timer-${ms}`}),clearInterval:vi.fn()})
    const run=runSofiaBatchMaintenance(d,1)
    await vi.waitFor(()=>expect(heartbeat).toBeTypeOf('function'))
    heartbeat!();heartbeat!()
    expect(d.renewActivity).toHaveBeenCalledTimes(1)
    releaseRenewal(false);releaseGeneration('resposta')
    await run
    expect(d.setInterval).toHaveBeenCalledWith(expect.any(Function),10_000)
    expect(d.complete).not.toHaveBeenCalled()
    expect(d.clearActivity).toHaveBeenCalledWith('b','g')
    expect(d.clearInterval).toHaveBeenCalledWith('timer-4000')
  })
  it('formats ordered context with safe attachment descriptors only', () => {
    expect(formatBatchContext(claim.members)).toBe('MENSAGENS RECEBIDAS NESTE LOTE (ordem cronológica):\n[1] Cliente: "primeiro"\n[2] Cliente: [anexo recebido; mensagem sem texto]\n[3] Cliente: "segue" [anexo: comprovante de pagamento recebido]')
    expect(formatBatchContext([{ content:'x', has_attachment:true, has_payment_proof:false, url_anexo:'secret/path.jpg' } as never])).not.toContain('secret')
  })
  it.each([
    ['ia_inactive',{ eligibility:{ db_eligible:false,ia_ativa:false } }],
    ['opt_out',{ eligibility:{ db_eligible:false,ia_ativa:true,automation_allowed:false } }],
    ['handoff_or_pause',{ eligibility:{ db_eligible:false,ia_ativa:true,automation_allowed:true } }],
    ['outside_business_hours',{}, { businessHours:vi.fn().mockResolvedValue(false) }],
    ['global_disabled',{}, { globalEnabled:vi.fn().mockResolvedValue(false) }],
    ['sleep_or_cooldown',{ channel:'whatsapp' }, { whatsappEligible:vi.fn().mockResolvedValue(false) }],
  ])('cancels ineligible work as %s without generation', async (reason, patch, extra: Partial<BatchWorkerDeps> = {}) => {
    const d=deps({ claimBatch:vi.fn().mockResolvedValueOnce({...claim,...patch}).mockResolvedValue(null), ...extra })
    const result=await runSofiaBatchMaintenance(d,1)
    expect(result.cancelled).toBe(1); expect(d.cancel).toHaveBeenCalledWith('b','l',reason); expect(d.generate).not.toHaveBeenCalled()
  })
  it('generates once and completes one intent', async () => {
    const d=deps(); const result=await runSofiaBatchMaintenance(d,1)
    expect(result.completed).toBe(1); expect(d.generate).toHaveBeenCalledTimes(1); expect(d.complete).toHaveBeenCalledWith('b','l','resposta')
  })
  it('fails closed on generation and lease completion failure', async () => {
    const broken=deps({generate:vi.fn().mockRejectedValue(Error('private'))}); expect((await runSofiaBatchMaintenance(broken,1)).failed).toBe(1)
    const stale=deps({complete:vi.fn().mockResolvedValue(false)}); expect((await runSofiaBatchMaintenance(stale,1)).failed).toBe(1)
  })
  it.each(['telegram','whatsapp'] as const)('marks attempted before one %s provider send', async channel => {
    const d=deps({claimBatch:vi.fn().mockResolvedValue(null),claimDelivery:vi.fn().mockResolvedValueOnce({batch_id:'b',conversa_id:'c',canal:channel,response_text:'r',lease_token:'l'}).mockResolvedValue(null)})
    await runSofiaBatchMaintenance(d,1)
    const send=channel==='telegram'?d.sendTelegram:d.sendWhatsApp
    expect(d.beginDelivery).toHaveBeenCalledBefore(send as ReturnType<typeof vi.fn>); expect(send).toHaveBeenCalledTimes(1)
  })
  it('never sends when the delivery fence is lost', async () => {
    const d=deps({claimBatch:vi.fn().mockResolvedValue(null),claimDelivery:vi.fn().mockResolvedValueOnce({batch_id:'b',conversa_id:'c',canal:'telegram',response_text:'r',lease_token:'l'}),beginDelivery:vi.fn().mockResolvedValue(false)})
    await runSofiaBatchMaintenance(d,1); expect(d.sendTelegram).not.toHaveBeenCalled()
  })
  it.each([
    ['telegram',{success:false}],
    ['whatsapp',{sucesso:false,error:'sensitive provider detail'}],
  ] as const)('records resolved %s provider failure using only a bounded token',async(canal,result)=>{
    const delivery={batch_id:'b',conversa_id:'c',canal,response_text:'r',lease_token:'l'}
    const d=deps({claimBatch:vi.fn().mockResolvedValue(null),claimDelivery:vi.fn().mockResolvedValueOnce(delivery).mockResolvedValue(null),sendTelegram:vi.fn().mockResolvedValue(result),sendWhatsApp:vi.fn().mockResolvedValue(result)})
    await runSofiaBatchMaintenance(d,2);expect(d.recordDeliveryFailure).toHaveBeenCalledWith('b','provider_rejected')
    expect(d.recordDeliveryFailure).not.toHaveBeenCalledWith('b',expect.stringContaining('sensitive'))
  })
  it('records provider exceptions without retrying the attempted intent',async()=>{
    const delivery={batch_id:'b',conversa_id:'c',canal:'whatsapp' as const,response_text:'r',lease_token:'l'}
    const d=deps({claimBatch:vi.fn().mockResolvedValue(null),claimDelivery:vi.fn().mockResolvedValueOnce(delivery).mockResolvedValue(null),sendWhatsApp:vi.fn().mockRejectedValue(Error('network'))})
    await runSofiaBatchMaintenance(d,2);expect(d.sendWhatsApp).toHaveBeenCalledTimes(1);expect(d.recordDeliveryFailure).toHaveBeenCalledWith('b','provider_unavailable')
  })
  it('advances saturated processing and delivery queues within one overall limit',async()=>{
    const batches=Array.from({length:20},(_,i)=>({...claim,batch_id:`b${i}`}))
    const deliveries=Array.from({length:20},(_,i)=>({batch_id:`d${i}`,conversa_id:'c',canal:'telegram' as const,response_text:'r',lease_token:'l'}))
    const d=deps({claimBatch:vi.fn(async()=>batches.shift()??null),claimDelivery:vi.fn(async()=>deliveries.shift()??null)})
    await runSofiaBatchMaintenance(d,20)
    expect(d.claimBatch).toHaveBeenCalledTimes(10);expect(d.claimDelivery).toHaveBeenCalledTimes(10)
    expect(vi.mocked(d.claimBatch).mock.calls.length+vi.mocked(d.claimDelivery).mock.calls.length).toBeLessThanOrEqual(20)
  })
  describe('customer memory extraction hook', () => {
    // G de geracao e handle de digitacao sao obrigatorios no caminho runtime-on.
    const runtimeOnDeps = () => ({ beginActivity:vi.fn().mockResolvedValue({ attempt_id:'g', expires_at:'' }), clearActivity:vi.fn().mockResolvedValue(true) })
    const completedLote = { batch_id:'b', conversa_id:'c', cliente_id:'u', canal:'telegram' as const, contexto:formatBatchContext(claim.members) }
    const orderOf = (fn: ReturnType<typeof vi.fn>, match: (call: unknown[]) => boolean) => {
      const index = fn.mock.calls.findIndex(call => match(call as unknown[]))
      expect(index).toBeGreaterThanOrEqual(0)
      return fn.mock.invocationCallOrder[index]!
    }
    it('extracts facts once with the completed batch payload after a paced completion', async () => {
      vi.stubEnv('SOFIA_INBOUND_BATCH_RUNTIME_ENABLED','true')
      const extractFacts=vi.fn().mockResolvedValue(1)
      const d=deps({ ...runtimeOnDeps(), extractFacts })
      const result=await runSofiaBatchMaintenance(d,1)
      expect(result).toMatchObject({ completed:1, failed:0 })
      expect(extractFacts).toHaveBeenCalledTimes(1)
      expect(extractFacts).toHaveBeenCalledWith(completedLote)
    })
    it('extracts facts once with the completed batch payload after a legacy completion', async () => {
      vi.stubEnv('SOFIA_INBOUND_BATCH_RUNTIME_ENABLED','false')
      const extractFacts=vi.fn().mockResolvedValue(0)
      const d=deps({ extractFacts })
      const result=await runSofiaBatchMaintenance(d,1)
      expect(result).toMatchObject({ completed:1, failed:0 })
      expect(d.complete).toHaveBeenCalledWith('b','l','resposta')
      expect(extractFacts).toHaveBeenCalledTimes(1)
      expect(extractFacts).toHaveBeenCalledWith(completedLote)
    })
    it('never extracts facts when paced completion loses its fence', async () => {
      vi.stubEnv('SOFIA_INBOUND_BATCH_RUNTIME_ENABLED','true')
      const extractFacts=vi.fn().mockResolvedValue(0)
      const d=deps({ ...runtimeOnDeps(), completePaced:vi.fn().mockResolvedValue(null), extractFacts })
      const result=await runSofiaBatchMaintenance(d,1)
      expect(result).toMatchObject({ completed:0, failed:1 })
      expect(extractFacts).not.toHaveBeenCalled()
    })
    it('never extracts facts when a legacy completion returns false', async () => {
      vi.stubEnv('SOFIA_INBOUND_BATCH_RUNTIME_ENABLED','false')
      const extractFacts=vi.fn().mockResolvedValue(0)
      const d=deps({ complete:vi.fn().mockResolvedValue(false), extractFacts })
      const result=await runSofiaBatchMaintenance(d,1)
      expect(result).toMatchObject({ completed:0, failed:1 })
      expect(extractFacts).not.toHaveBeenCalled()
    })
    it('never extracts facts for a batch cancelled by eligibility', async () => {
      vi.stubEnv('SOFIA_INBOUND_BATCH_RUNTIME_ENABLED','true')
      const extractFacts=vi.fn().mockResolvedValue(0)
      const d=deps({ claimBatch:vi.fn().mockResolvedValueOnce({ ...claim, eligibility:{ db_eligible:false } }).mockResolvedValue(null), extractFacts })
      const result=await runSofiaBatchMaintenance(d,1)
      expect(result).toMatchObject({ cancelled:1, completed:0 })
      expect(extractFacts).not.toHaveBeenCalled()
    })
    it('never extracts facts when generation throws on either runtime path', async () => {
      const extractFacts=vi.fn().mockResolvedValue(0)
      vi.stubEnv('SOFIA_INBOUND_BATCH_RUNTIME_ENABLED','true')
      const paced=deps({ ...runtimeOnDeps(), generate:vi.fn().mockRejectedValue(Error('private')), extractFacts })
      expect(await runSofiaBatchMaintenance(paced,1)).toMatchObject({ completed:0, failed:1 })
      vi.stubEnv('SOFIA_INBOUND_BATCH_RUNTIME_ENABLED','false')
      const legacy=deps({ generate:vi.fn().mockRejectedValue(Error('private')), extractFacts })
      expect(await runSofiaBatchMaintenance(legacy,1)).toMatchObject({ completed:0, failed:1 })
      expect(extractFacts).not.toHaveBeenCalled()
    })
    it('keeps the completion counts and the pass alive when extraction rejects', async () => {
      vi.stubEnv('SOFIA_INBOUND_BATCH_RUNTIME_ENABLED','true')
      const warn=vi.spyOn(console,'warn').mockImplementation(()=>undefined)
      try{
        const extractFacts=vi.fn().mockRejectedValue(Error('provider secret leaked'))
        const d=deps({ ...runtimeOnDeps(), extractFacts })
        const result=await runSofiaBatchMaintenance(d,1)
        expect(result).toEqual({ claimed:1, completed:1, cancelled:0, failed:0, delivery_attempted:0 })
        expect(warn).toHaveBeenCalledWith('[sofia-inbound-batch] customer_memory_extraction_failed batch=b')
        expect(JSON.stringify(warn.mock.calls)).not.toContain('provider secret leaked')
      }finally{ warn.mockRestore() }
    })
    it('drains every completed batch when the delivery loop throws (issue #196)', async () => {
      vi.stubEnv('SOFIA_INBOUND_BATCH_RUNTIME_ENABLED','true')
      const second={ ...claim, batch_id:'b2' }
      const extractFacts=vi.fn().mockResolvedValue(0)
      const d=deps({
        ...runtimeOnDeps(),
        claimBatch:vi.fn().mockResolvedValueOnce(claim).mockResolvedValueOnce(second).mockResolvedValue(null),
        claimDelivery:vi.fn().mockResolvedValue({ batch_id:'b', conversa_id:'c', canal:'telegram' as const, response_text:'r', lease_token:'dl' }),
        adoptActivity:vi.fn().mockRejectedValue(Error('activity surface down')),
        extractFacts,
      })

      await expect(runSofiaBatchMaintenance(d,4)).rejects.toThrow('activity surface down')

      expect(extractFacts).toHaveBeenCalledTimes(2)
      expect(extractFacts).toHaveBeenCalledWith({ ...completedLote })
      expect(extractFacts).toHaveBeenCalledWith({ ...completedLote, batch_id:'b2' })
    })
    it('drains completed batches when the delivery failure handler itself rejects', async () => {
      vi.stubEnv('SOFIA_INBOUND_BATCH_RUNTIME_ENABLED','true')
      const delivery={ batch_id:'b', conversa_id:'c', canal:'telegram' as const, response_text:'r', lease_token:'dl' }
      const extractFacts=vi.fn().mockResolvedValue(0)
      const d=deps({
        ...runtimeOnDeps(),
        claimDelivery:vi.fn().mockResolvedValueOnce(delivery).mockResolvedValue(null),
        adoptActivity:vi.fn().mockRejectedValue(Error('activity surface down')),
        recordDeliveryFailure:vi.fn().mockRejectedValue(Error('failure ledger down')),
        extractFacts,
      })

      await expect(runSofiaBatchMaintenance(d,2)).rejects.toThrow('activity surface down')
      expect(extractFacts).toHaveBeenCalledTimes(1)
      expect(extractFacts).toHaveBeenCalledWith({ ...completedLote })
    })
    it('never extracts a batch before its own delivery attempt in the same pass', async () => {
      vi.stubEnv('SOFIA_INBOUND_BATCH_RUNTIME_ENABLED','true')
      const delivery={ batch_id:'b', conversa_id:'c', canal:'telegram' as const, response_text:'r', lease_token:'dl', remaining_ms:0 }
      const extractFacts=vi.fn().mockResolvedValue(0)
      const d=deps({
        ...runtimeOnDeps(),
        claimDelivery:vi.fn().mockResolvedValueOnce(delivery).mockResolvedValue(null),
        adoptActivity:vi.fn().mockResolvedValue({ attempt_id:'d', expires_at:'' }),
        extractFacts,
      })
      const result=await runSofiaBatchMaintenance(d,2)
      expect(result).toMatchObject({ completed:1, delivery_attempted:1 })
      expect(extractFacts).toHaveBeenCalledTimes(1)
      expect(vi.mocked(extractFacts).mock.invocationCallOrder[0]!).toBeGreaterThan(vi.mocked(d.beginDelivery).mock.invocationCallOrder[0]!)
      expect(vi.mocked(extractFacts).mock.invocationCallOrder[0]!).toBeGreaterThan(vi.mocked(d.sendTelegram).mock.invocationCallOrder[0]!)
      expect(orderOf(extractFacts,call=>Boolean(call[0]))).toBeGreaterThan(vi.mocked(d.claimDelivery).mock.invocationCallOrder.at(-1)!)
    })
    it('stays a no-op when the worker carries no extraction dependency', async () => {
      vi.stubEnv('SOFIA_INBOUND_BATCH_RUNTIME_ENABLED','true')
      const d=deps(runtimeOnDeps())
      const result=await runSofiaBatchMaintenance(d,1)
      expect(result).toEqual({ claimed:1, completed:1, cancelled:0, failed:0, delivery_attempted:0 })
    })
    it.each([['runtime-on','true'],['runtime-off','false']] as const)('pushes exactly one completed batch per batch on the %s path', async (_label,runtime) => {
      vi.stubEnv('SOFIA_INBOUND_BATCH_RUNTIME_ENABLED',runtime)
      const second={ ...claim, batch_id:'b2' }
      const extractFacts=vi.fn().mockResolvedValue(0)
      const d=deps({
        claimBatch:vi.fn().mockResolvedValueOnce(claim).mockResolvedValueOnce(second).mockResolvedValue(null),
        extractFacts,
        ...(runtime==='true'?runtimeOnDeps():{}),
      })
      const result=await runSofiaBatchMaintenance(d,4)
      expect(result).toMatchObject({ completed:2, failed:0 })
      expect(extractFacts).toHaveBeenCalledTimes(2)
      expect(extractFacts.mock.calls.map(call=>(call[0] as { batch_id:string }).batch_id)).toEqual(['b','b2'])
    })
    it('never re-drains a batch completed by a previous pass', async () => {
      vi.stubEnv('SOFIA_INBOUND_BATCH_RUNTIME_ENABLED','false')
      const extractFacts=vi.fn().mockResolvedValue(0)
      const d=deps({ extractFacts })
      expect(await runSofiaBatchMaintenance(d,1)).toMatchObject({ completed:1 })
      expect(await runSofiaBatchMaintenance(d,1)).toMatchObject({ completed:0 })
      expect(extractFacts).toHaveBeenCalledTimes(1)
    })
    it('drains after the delivery loop once the generation lease and the typing handle are released', async () => {
      vi.stubEnv('SOFIA_INBOUND_BATCH_RUNTIME_ENABLED','true')
      const delivery={ batch_id:'b', conversa_id:'c', canal:'telegram' as const, response_text:'r', lease_token:'dl', remaining_ms:0 }
      const extractFacts=vi.fn().mockResolvedValue(0)
      const d=deps({
        ...runtimeOnDeps(),
        claimDelivery:vi.fn().mockResolvedValueOnce(delivery).mockResolvedValue(null),
        adoptActivity:vi.fn().mockResolvedValue({ attempt_id:'d', expires_at:'' }),
        setInterval:vi.fn((_callback,ms)=>ms===4_000?'typing':'heartbeat'),
        clearInterval:vi.fn(),
        extractFacts,
      })
      const result=await runSofiaBatchMaintenance(d,2)
      expect(result).toMatchObject({ completed:1, delivery_attempted:1 })
      const extractOrder=vi.mocked(extractFacts).mock.invocationCallOrder[0]!
      expect(extractOrder).toBeGreaterThan(orderOf(vi.mocked(provided(d.clearActivity)),call=>call[0]==='b'&&call[1]==='d'))
      expect(extractOrder).toBeGreaterThan(orderOf(vi.mocked(provided(d.clearInterval)),call=>call[0]==='typing'))
      expect(extractOrder).toBeGreaterThan(vi.mocked(d.claimDelivery).mock.invocationCallOrder.at(-1)!)
    })
    it('drains only after the WhatsApp presence handle was released', async () => {
      vi.stubEnv('SOFIA_INBOUND_BATCH_RUNTIME_ENABLED','true')
      const delivery={ batch_id:'b', conversa_id:'c', canal:'whatsapp' as const, response_text:'r', lease_token:'dl', remaining_ms:0 }
      const stopPresence=vi.fn()
      const extractFacts=vi.fn().mockResolvedValue(0)
      const d=deps({
        claimBatch:vi.fn().mockResolvedValueOnce({ ...claim, channel:'whatsapp' as const }).mockResolvedValue(null),
        beginActivity:vi.fn().mockResolvedValue({ attempt_id:'g', expires_at:'' }),
        clearActivity:vi.fn().mockResolvedValue(true),
        startWhatsAppPresence:vi.fn().mockReturnValue({ stop:stopPresence }),
        claimDelivery:vi.fn().mockResolvedValueOnce(delivery).mockResolvedValue(null),
        adoptActivity:vi.fn().mockResolvedValue({ attempt_id:'d', expires_at:'' }),
        setInterval:vi.fn(()=> 'heartbeat'),
        clearInterval:vi.fn(),
        extractFacts,
      })
      const result=await runSofiaBatchMaintenance(d,2)
      expect(result).toMatchObject({ completed:1, delivery_attempted:1 })
      expect(stopPresence).toHaveBeenCalledTimes(1)
      expect(vi.mocked(extractFacts).mock.invocationCallOrder[0]!).toBeGreaterThan(orderOf(stopPresence,call=>call.length===0))
      expect(vi.mocked(extractFacts).mock.invocationCallOrder[0]!).toBeGreaterThan(vi.mocked(d.sendWhatsApp).mock.invocationCallOrder[0]!)
    })
    it('wires the production extraction dependency into the worker deps', async () => {
      vi.stubEnv('SOFIA_CUSTOMER_MEMORY_ENABLED','false')
      const production=createSofiaBatchWorkerDeps({ rpc:vi.fn() } as never)
      await expect(provided(production.extractFacts)(completedLote)).resolves.toBe(0)
    })
  })
})
