import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { resolverChaveDeepSeek, resolverModeloDeepSeek } from '@/lib/ai/deepseek'
import { obterConfiguracaoSistema } from '@/lib/config/sistema'
import { dispatchPaymentProofOutbox } from '@/lib/payment-proofs/outbox-dispatch'
import { resolvePaymentProofOutboxMessage } from '@/lib/payment-proofs/outbox-message'
import { processPaymentProofJob } from '@/lib/payment-proofs/processing-worker'
import { createAdminClient } from '@/lib/supabase/admin'
import { paymentProofOperationalGates } from '@/lib/payment-proofs/operational-gates'

function matchesBearer(header: string | null, secret: string | null) {
  if (!header || !secret) return false
  const actual = Buffer.from(header)
  const expected = Buffer.from(`Bearer ${secret}`)
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

export async function POST(request: Request) {
  const secret = await obterConfiguracaoSistema('PAYMENT_PROOF_MAINTENANCE_SECRET')
  if (!matchesBearer(request.headers.get('authorization'), secret)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let db: ReturnType<typeof createAdminClient> | null = null
  let completed = 0
  let failed = 0
  let healthy = false
  try {
    db = createAdminClient()
    const begun = await db.rpc('begin_payment_proof_maintenance')
    if (begun.error) throw new Error('MAINTENANCE_UNAVAILABLE')
    const kinds = [
      ...(paymentProofOperationalGates.processing.effective ? ['processing' as const] : []),
      'outbox' as const,
      ...(paymentProofOperationalGates.cleanup.effective ? ['purge' as const] : []),
    ]
    let emptyKinds = 0
    for (let i = 0; kinds.length > 0 && i < 20 && emptyKinds < kinds.length; i++) {
      const kind = kinds[i % kinds.length]
      const claim = await db.rpc('claim_payment_proof_maintenance', { p_lease_seconds: 60, p_kind: kind })
      if (claim.error) throw new Error('MAINTENANCE_UNAVAILABLE')
      const job = claim.data
      if (!job) { emptyKinds++; continue }
      emptyKinds = 0
      // The claimed row is untrusted. Its discriminator must exactly match the
      // requested capability before any worker or external dispatch can run.
      if (job.kind !== kind || !['processing', 'outbox', 'purge'].includes(job.kind)) {
        throw new Error('MAINTENANCE_UNAVAILABLE')
      }

      let ok = false
      let outboxDisposition: 'success'|'retryable'|'permanent' = 'retryable'
      let outboxError: string | null = null
      // A throw before the worker can return a narrower stage is a load-boundary failure.
      let failureStage: 'load'|'render'|'preview'|'classifier'|null = job.kind === 'processing' ? 'load' : null
      try {
        if (job.kind === 'processing') {
          const [apiKey, model] = await Promise.all([
            resolverChaveDeepSeek(),
            resolverModeloDeepSeek(),
          ])
          const result = await processPaymentProofJob({ proofId: String(job.id), db, apiKey, model })
          ok = result.ok
          failureStage = result.ok ? null : result.stage
        } else if (job.kind === 'purge') {
          const keys = [job.original_key, job.preview_key].filter((key): key is string => typeof key === 'string' && key.length > 0)
          if (keys.length === 0) ok = true
          else {
            const removal = await db.storage.from('payment-proofs').remove(keys)
            ok = !removal.error
          }
        } else {
          const message = resolvePaymentProofOutboxMessage(job.payload)
          if (!message.ok) {
            outboxDisposition = 'permanent'
            outboxError = 'unsupported_payload'
          } else {
            const result = await dispatchPaymentProofOutbox({
              channel: job.channel,
              conversationId: job.conversation_id ?? null,
              message: message.text,
              deliveryKey: job.delivery_key,
              db,
            })
            outboxDisposition = result.status
            outboxError = result.error ?? null
            ok = result.status === 'success'
          }
        }
      } catch {
        ok = false
      }

      const leaseToken = typeof job.lease_token === 'string' ? job.lease_token : null
      const attempt = typeof job.attempt === 'number' ? job.attempt : null
      if (!leaseToken || attempt === null) throw new Error('MAINTENANCE_UNAVAILABLE')
      const transition = await db.rpc('complete_payment_proof_maintenance', {
        p_kind: job.kind,
        p_id: String(job.id),
        p_disposition: job.kind === 'outbox'
          ? outboxDisposition
          : ok ? 'success' : 'retryable',
        p_error: ok ? null : (job.kind === 'processing' ? failureStage : job.kind === 'outbox' ? outboxError : 'operation_failed'),
        p_lease_token: leaseToken,
        p_attempt: attempt,
      })
      if (transition.error || transition.data !== true) throw new Error('MAINTENANCE_UNAVAILABLE')
      if (ok) completed++
      else failed++
    }
    const finish = await db.rpc('finish_payment_proof_maintenance', { p_success: true })
    if (finish.error) throw new Error('MAINTENANCE_UNAVAILABLE')
    healthy = true
    return NextResponse.json({ completed, failed })
  } catch {
    if (!healthy) {
      try { await db?.rpc('finish_payment_proof_maintenance', { p_success: false }) } catch { /* best effort */ }
    }
    return NextResponse.json({ error: 'maintenance_unavailable' }, { status: 503 })
  }
}
