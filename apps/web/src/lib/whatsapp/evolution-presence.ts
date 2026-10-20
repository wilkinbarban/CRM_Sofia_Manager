export const EVOLUTION_PRESENCE_TAG = 'evolution_presence' as const
export const EVOLUTION_PRESENCE_INTERVAL_MS = 4_000
export type EvolutionPresenceReason = 'provider_unavailable' | 'provider_rejected' | 'invalid_response'
export type EvolutionPresenceEvent =
  | { tag: typeof EVOLUTION_PRESENCE_TAG; event: 'attempt' }
  | { tag: typeof EVOLUTION_PRESENCE_TAG; event: 'accepted' }
  | { tag: typeof EVOLUTION_PRESENCE_TAG; event: 'unavailable'; reason: EvolutionPresenceReason }

export interface EvolutionPresenceDeps {
  send: (signal?: AbortSignal) => Promise<boolean>
  setTimeout: (callback: () => void, ms: number) => unknown
  clearTimeout: (timer: unknown) => void
  observe?: (event: EvolutionPresenceEvent) => void | Promise<void>
  now?: () => number
}

function observe(deps: EvolutionPresenceDeps, event: EvolutionPresenceEvent): void {
  try {
    const result = deps.observe?.(event)
    if (result && typeof (result as PromiseLike<unknown>).then === 'function') void Promise.resolve(result).catch(() => undefined)
  } catch { /* observability never affects delivery */ }
}

export function createEvolutionPresence(deps: EvolutionPresenceDeps): { stop: () => void } {
  let stopped = false
  let pending = false
  let timer: unknown
  let currentController: AbortController | undefined
  const schedule = (delayMs: number) => {
    if (!stopped) timer = deps.setTimeout(refresh, delayMs)
  }
  function refresh(): void {
    if (stopped || pending) return
    pending = true
    const startedAt = deps.now?.() ?? Date.now()
    observe(deps, { tag: EVOLUTION_PRESENCE_TAG, event: 'attempt' })
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : undefined
    currentController = controller
    let request: Promise<boolean>
    try { request = deps.send(controller?.signal) } catch {
      pending = false
      observe(deps, { tag: EVOLUTION_PRESENCE_TAG, event: 'unavailable', reason: 'provider_unavailable' })
      schedule(EVOLUTION_PRESENCE_INTERVAL_MS)
      return
    }
    void Promise.resolve(request).then(accepted => {
      pending = false
      if (stopped) return
      observe(deps, accepted
        ? { tag: EVOLUTION_PRESENCE_TAG, event: 'accepted' }
        : { tag: EVOLUTION_PRESENCE_TAG, event: 'unavailable', reason: 'provider_rejected' })
      const elapsedMs = Math.max(0, (deps.now?.() ?? Date.now()) - startedAt)
      schedule(accepted ? Math.max(0, EVOLUTION_PRESENCE_INTERVAL_MS - elapsedMs) : EVOLUTION_PRESENCE_INTERVAL_MS)
    }, () => {
      pending = false
      if (stopped) return
      observe(deps, { tag: EVOLUTION_PRESENCE_TAG, event: 'unavailable', reason: 'provider_unavailable' })
      schedule(EVOLUTION_PRESENCE_INTERVAL_MS)
    })
  }

  refresh()
  return {
    stop: () => {
      stopped = true
      if (timer !== undefined) {
        deps.clearTimeout(timer)
        timer = undefined
      }
      currentController?.abort()
    },
  }
}
