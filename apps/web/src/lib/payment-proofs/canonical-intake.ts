import { createHash } from 'node:crypto'
import { normalizePaymentProofDelivery, type PaymentProofChannel } from './intake'
import { normalizePaymentProofUpload } from './safe-upload'
import { paymentProofOperationalGates } from './operational-gates'

type IntakeInput = {
  channel: PaymentProofChannel
  deliveryId: string
  customerId?: string | null
  orderId?: string | null
  conversationId?: string | null
  sender?: string | null
  bytes: Uint8Array
  mimeType: string
  db: any
  storage: any
}

type EvolutionIntakeInput = Omit<IntakeInput, 'customerId' | 'conversationId'> & {
  channel: 'whatsapp'
  sender: string
  displayName: string
}

// The processor entry point takes the same intake shape: the retired provider
// credential and model fields it used to accept were never read anywhere.
type ProcessInput = IntakeInput

function proofIdFrom(data: unknown): string | null {
  if (typeof data === 'string') return data
  if (Array.isArray(data)) return proofIdFrom(data[0])
  if (data && typeof data === 'object' && 'proof_id' in data) {
    const value = (data as { proof_id?: unknown }).proof_id
    return typeof value === 'string' ? value : null
  }
  return null
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

function evolutionAdmissionFrom(data: unknown): { proofId: string; duplicate: boolean; canonicalProofId?: string; customerId: string; conversationId: string } | null {
  const row = Array.isArray(data) ? data[0] : data
  if (!row || typeof row !== 'object') return null
  const value = row as Record<string, unknown>
  if (!isUuid(value.proof_id) || !isUuid(value.customer_id) || !isUuid(value.conversation_id) || typeof value.duplicate !== 'boolean') return null
  return {
    proofId: value.proof_id,
    duplicate: value.duplicate,
    ...(isUuid(value.canonical_proof_id) ? { canonicalProofId: value.canonical_proof_id } : {}),
    customerId: value.customer_id,
    conversationId: value.conversation_id,
  }
}

export async function ingestCanonicalPaymentProof(input: IntakeInput) {
  if (!paymentProofOperationalGates.canonicalIngest.effective) return { status: 'disabled' as const }
  if (input.channel === 'whatsapp' && !paymentProofOperationalGates.whatsappIngest.effective) return { status: 'disabled' as const }

  const valid = await normalizePaymentProofUpload(input.bytes, input.mimeType)
  if (!valid.ok) return { status: 'rejected' as const, error: valid.error }

  const delivery = normalizePaymentProofDelivery(input)
  const contentSha256 = createHash('sha256').update(valid.bytes).digest('hex')
  const deliveryStorageId = createHash('sha256').update(delivery.deliveryKey).digest('hex')
  const extension = valid.mimeType === 'application/pdf' ? 'pdf' : valid.mimeType === 'image/png' ? 'png' : 'jpg'
  const storageKey = `proofs/private/${input.channel}/${deliveryStorageId}/${contentSha256}.${extension}`
  const { error: uploadError } = await input.storage.upload(storageKey, valid.bytes, {
    contentType: valid.mimeType,
    upsert: false,
  })
  if (uploadError && !String(uploadError.message).includes('already exists')) {
    return { status: 'retryable' as const, error: 'PAYMENT_PROOF_STORAGE_FAILED' }
  }

  const { data, error } = await input.db.rpc('admit_and_enqueue_payment_proof', {
    p_channel: delivery.channel,
    p_delivery_key: delivery.deliveryKey,
    p_customer_id: delivery.customerId,
    p_sender_reference: delivery.senderReference,
    p_storage_key: storageKey,
    p_size_bytes: valid.sizeBytes,
    p_mime_type: valid.mimeType,
    p_order_id: input.orderId ?? null,
    p_conversation_id: input.conversationId ?? null,
    p_sha256: contentSha256,
  })
  const proofId = proofIdFrom(data)
  if (error || !proofId) {
    if (!uploadError) {
      try { await input.storage.remove([storageKey]) } catch { /* best effort */ }
    }
    const message = String(error?.message || '')
    if (message.includes('ORDER_PAYMENT_PROOF_ALREADY_PENDING')) {
      return { status: 'rejected' as const, error: 'ORDER_PAYMENT_PROOF_ALREADY_PENDING' }
    }
    if (message.includes('PAYMENT_PROOF_ORDER_INELIGIBLE')) {
      return { status: 'rejected' as const, error: 'PAYMENT_PROOF_ORDER_INELIGIBLE' }
    }
    return { status: 'retryable' as const, error: 'PAYMENT_PROOF_INTAKE_FAILED' }
  }
  const row = Array.isArray(data) ? data[0] : data
  if (row?.duplicate) return { status: 'duplicate' as const, proofId, canonicalProofId: row.canonical_proof_id }
  return { status: 'accepted' as const, proofId, storageKey }
}

export async function ingestEvolutionCanonicalPaymentProof(input: EvolutionIntakeInput) {
  if (!paymentProofOperationalGates.canonicalIngest.effective || !paymentProofOperationalGates.whatsappIngest.effective) return { status: 'disabled' as const }

  const valid = await normalizePaymentProofUpload(input.bytes, input.mimeType)
  if (!valid.ok) return { status: 'rejected' as const, error: valid.error }

  const delivery = normalizePaymentProofDelivery(input)
  const contentSha256 = createHash('sha256').update(valid.bytes).digest('hex')
  const deliveryStorageId = createHash('sha256').update(delivery.deliveryKey).digest('hex')
  const extension = valid.mimeType === 'application/pdf' ? 'pdf' : valid.mimeType === 'image/png' ? 'png' : 'jpg'
  const storageKey = `proofs/private/${input.channel}/${deliveryStorageId}/${contentSha256}.${extension}`
  const { error: uploadError } = await input.storage.upload(storageKey, valid.bytes, {
    contentType: valid.mimeType, upsert: false,
  })
  if (uploadError && !String(uploadError.message).includes('already exists')) return { status: 'retryable' as const, error: 'PAYMENT_PROOF_STORAGE_FAILED' }

  const { data, error } = await input.db.rpc('admit_and_enqueue_evolution_payment_proof', {
    p_phone: input.sender,
    p_display_name: input.displayName,
    p_delivery_key: delivery.deliveryKey,
    p_storage_key: storageKey,
    p_size_bytes: valid.sizeBytes,
    p_mime_type: valid.mimeType,
    p_order_id: input.orderId ?? null,
    p_sha256: contentSha256,
  })
  const admitted = error ? null : evolutionAdmissionFrom(data)
  if (!admitted) {
    if (!uploadError) {
      try { await input.storage.remove([storageKey]) } catch { /* best effort */ }
    }
    return { status: 'retryable' as const, error: 'PAYMENT_PROOF_INTAKE_FAILED' }
  }
  if (admitted.duplicate) return { status: 'duplicate' as const, proofId: admitted.proofId, canonicalProofId: admitted.canonicalProofId }
  return { status: 'accepted' as const, proofId: admitted.proofId, storageKey }
}

export async function queueCanonicalPaymentProof(input: IntakeInput) {
  const intake = await ingestCanonicalPaymentProof(input)
  if (intake.status !== 'accepted') return intake
  return { status:'queued' as const,proofId:intake.proofId }
}

// Kept as the public compatibility entry point; durable workers own all processing after admission.
export async function processCanonicalPaymentProof(input: ProcessInput) {
  return ingestCanonicalPaymentProof(input)
}
