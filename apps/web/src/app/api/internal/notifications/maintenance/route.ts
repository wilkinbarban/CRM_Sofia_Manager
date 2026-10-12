import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { obterConfiguracaoSistema } from '@/lib/config/sistema'
import { dispatchNotificationOutbox } from '@/lib/notifications/outbox-dispatch'
import { resolveNotificationOutboxMessage } from '@/lib/notifications/outbox-message'
import { notificationOperationalGates } from '@/lib/notifications/operational-gates'
import { createAdminClient } from '@/lib/supabase/admin'

export const dynamic = 'force-dynamic'

type Channel = 'web' | 'whatsapp' | 'telegram'

type Claim = Readonly<{
  id: number | string
  event_type: string
  channel: Channel
  payload: unknown
  delivery_key: string
  conversation_id: string | null
  attempt: number
  lease_token: string
}>

function authorized(header: string | null, secret: string | null) {
  if (!header || !secret) return false
  const actual = Buffer.from(header)
  const expected = Buffer.from(`Bearer ${secret}`)
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

function claimedRow(value: unknown): unknown {
  if (!Array.isArray(value)) return value
  if (value.length === 0) return null
  return value.length === 1 ? value[0] : undefined
}

function validClaim(value: unknown, allowedChannels: readonly Channel[]): value is Claim {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const row = value as Record<string, unknown>
  return ((typeof row.id === 'number' && Number.isSafeInteger(row.id) && row.id > 0) ||
    (typeof row.id === 'string' && /^[1-9]\d*$/.test(row.id))) &&
    typeof row.event_type === 'string' &&
    typeof row.channel === 'string' &&
    allowedChannels.includes(row.channel as Channel) &&
    typeof row.delivery_key === 'string' && row.delivery_key.length > 0 &&
    (typeof row.conversation_id === 'string' || row.conversation_id === null) &&
    Number.isSafeInteger(row.attempt) && (row.attempt as number) > 0 &&
    typeof row.lease_token === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(row.lease_token)
}

function resolveActiveChannels(): Channel[] {
  const channels: Channel[] = []
  if (notificationOperationalGates.web.effective) channels.push('web')
  if (notificationOperationalGates.whatsapp.effective) channels.push('whatsapp')
  if (notificationOperationalGates.telegram.effective) channels.push('telegram')
  return channels
}

export async function POST(request: Request) {
  const secret = await obterConfiguracaoSistema('NOTIFICATION_OUTBOX_MAINTENANCE_SECRET')
  if (!authorized(request.headers.get('authorization'), secret)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: { 'Cache-Control': 'no-store' } })
  }
  // The master delivery gate is captured at startup and fails closed; do not claim while it is closed.
  if (!notificationOperationalGates.dispatch.effective) {
    return NextResponse.json({ completed: 0, failed: 0 }, { headers: { 'Cache-Control': 'no-store' } })
  }

  const activeChannels = resolveActiveChannels()
  if (activeChannels.length === 0) {
    return NextResponse.json({ completed: 0, failed: 0 }, { headers: { 'Cache-Control': 'no-store' } })
  }

  let completed = 0
  let failed = 0
  try {
    const db = createAdminClient()
    for (let i = 0; i < 20; i++) {
      const claim = await db.rpc('claim_notification_outbox_for_channels', {
        p_channels: activeChannels,
        p_lease_seconds: 60,
      })
      if (claim.error) throw new Error('MAINTENANCE_UNAVAILABLE')
      const row = claimedRow(claim.data)
      if (row === null) break
      if (!validClaim(row, activeChannels)) throw new Error('MAINTENANCE_UNAVAILABLE')
      const job = row
      const message = resolveNotificationOutboxMessage(job.event_type, job.payload)
      let result: { status: 'success' } | { status: 'retryable' | 'permanent'; error: string }
      if (!message.ok) {
        // The core RPC only accepts its fixed error-token allowlist, which does not include unsupported_payload.
        result = { status: 'permanent', error: 'operation_failed' }
      } else {
        try {
          result = await dispatchNotificationOutbox({ channel: job.channel, conversationId: job.conversation_id, message: message.text, deliveryKey: job.delivery_key, db: db as never })
        } catch {
          result = { status: 'retryable', error: 'delivery_failed' }
        }
      }
      const transition = await db.rpc('complete_notification_outbox', {
        // Keep bigint identity lossless across the JavaScript boundary.
        p_id: String(job.id),
        p_disposition: result.status,
        p_error: result.status === 'success' ? null : result.error,
        p_lease_token: job.lease_token,
        p_attempt: job.attempt,
      })
      if (transition.error || transition.data !== true) throw new Error('MAINTENANCE_UNAVAILABLE')
      if (result.status === 'success') completed++
      else failed++
    }
    return NextResponse.json({ completed, failed }, { headers: { 'Cache-Control': 'no-store' } })
  } catch {
    return NextResponse.json({ error: 'maintenance_unavailable' }, { status: 503, headers: { 'Cache-Control': 'no-store' } })
  }
}
