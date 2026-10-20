type Channel = "telegram" | "whatsapp" | "web";
type AdminClient = {
  rpc: (
    name: string,
    params: Record<string, unknown>,
  ) => PromiseLike<{ data?: unknown; error: unknown }>;
};

/**
 * Canonical idempotency prefix and formatter for the Web channel.
 * Strictly mirrors the database migration 20260914010000_sofia_web_atomic_admission.sql.
 */
export const SOFIA_WEB_IDEMPOTENCY_PREFIX = "sofia-web:" as const;

export function formatSofiaWebExternalId(key: string): string {
  return `${SOFIA_WEB_IDEMPOTENCY_PREFIX}${key.trim()}`;
}

export async function attachPersistedSofiaInboundMessage(input: {
  supabase: AdminClient;
  messageId: string;
  conversationId: string;
  customerId: string;
  channel: Channel;
}): Promise<boolean> {
  try {
    const { error } = await input.supabase.rpc("attach_sofia_inbound_message", {
      p_message_id: input.messageId,
      p_conversa_id: input.conversationId,
      p_cliente_id: input.customerId,
      p_canal: input.channel,
    });
    return !error;
  } catch {
    return false;
  }
}

/**
 * Resultado da admissão atômica Web. A mensagem e o vínculo com o lote `web` são
 * gravados em uma única transação pelo RPC canônico, então uma repetição com a mesma
 * chave devolve a mensagem/lote originais e não altera o prazo do lote.
 */
export type SofiaWebAdmission =
  | {
      admitted: true;
      messageId: string;
      batchId: string;
      duplicate: boolean;
      scheduledAt: string | null;
    }
  | { admitted: false };

function readAdmissionRow(data: unknown): Record<string, unknown> | null {
  const row = Array.isArray(data) ? data[0] : data;
  if (!row || typeof row !== "object") return null;
  return row as Record<string, unknown>;
}

/**
 * Admissão atômica do canal Web: delega ao RPC `enqueue_sofia_inbound_message` com o
 * canal `web` e a chave de idempotência gerada pelo cliente (namespace
 * `sofia-web:<chave>` em `mensagens.external_id`). O canal Telegram/WhatsApp/Evolution
 * permanece inalterado.
 */
export async function admitSofiaWebInboundMessage(input: {
  supabase: AdminClient;
  conversationId: string;
  customerId: string;
  idempotencyKey: string;
  content: string | null;
  attachmentUrl: string | null;
}): Promise<SofiaWebAdmission> {
  try {
    const idempotencyKey = input.idempotencyKey?.trim();
    if (!idempotencyKey || idempotencyKey.length > 500) return { admitted: false };

    const { data, error } = await input.supabase.rpc("enqueue_sofia_inbound_message", {
      p_conversa_id: input.conversationId,
      p_cliente_id: input.customerId,
      p_canal: "web",
      p_delivery_key: idempotencyKey,
      p_conteudo: input.content,
      p_url_anexo: input.attachmentUrl,
    });
    if (error) return { admitted: false };

    const row = readAdmissionRow(data);
    if (!row || typeof row.message_id !== "string" || typeof row.batch_id !== "string") {
      return { admitted: false };
    }

    return {
      admitted: true,
      messageId: row.message_id,
      batchId: row.batch_id,
      duplicate: row.duplicate === true,
      scheduledAt: typeof row.scheduled_at === "string" ? row.scheduled_at : null,
    };
  } catch {
    return { admitted: false };
  }
}
