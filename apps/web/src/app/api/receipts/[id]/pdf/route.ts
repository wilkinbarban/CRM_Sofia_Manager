import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { buildReceiptPdf, type ReceiptSnapshot } from '@/lib/receipts/salesReceipt'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return new Response('Unauthorized', { status: 401 })

  const { data: profile } = await supabase.from('perfis').select('funcao, ativo').eq('id', user.id).single()
  const isOperator = profile?.ativo && ['admin', 'supervisor', 'vendedor'].includes(profile.funcao)
  const isClient = profile?.ativo && profile.funcao === 'cliente'

  if (!isOperator && !isClient) {
    return new Response('Forbidden', { status: 403 })
  }

  // 1. Permite buscar tanto pelo ID do comprovante quanto pelo ID do pedido em comprovantes_venda
  let { data: receipt } = await supabase
    .from('comprovantes_venda')
    .select('snapshot')
    .eq('id', id)
    .single()

  if (!receipt?.snapshot) {
    const resPedido = await supabase
      .from('comprovantes_venda')
      .select('snapshot')
      .eq('pedido_id', id)
      .single()
    if (resPedido?.data?.snapshot) {
      receipt = resPedido.data
    }
  }

  // 2. Se ainda não foi emitido o snapshot estático, constrói a partir dos dados do pedido
  if (!receipt?.snapshot) {
    const admin = createAdminClient()
    const { data: pedido } = await admin
      .from('pedidos')
      .select(`
        id,
        tipo_entrega,
        total_pedido_centavos,
        total_produtos_centavos,
        taxa_entrega_centavos,
        endereco_entrega,
        status,
        status_pagamento,
        meio_pagamento,
        data_criacao,
        cliente_id,
        clientes:cliente_id (
          id,
          usuario_id,
          nome,
          telefone
        ),
        itens_pedido (
          id,
          produto_id,
          quantidade,
          preco_unitario_centavos,
          produtos (
            nome
          )
        )
      `)
      .eq('id', id)
      .maybeSingle()

    if (pedido) {
      if (isClient && (pedido.clientes as any)?.usuario_id !== user.id) {
        return new Response('Forbidden', { status: 403 })
      }

      receipt = {
        snapshot: {
          order: {
            id: pedido.id,
            delivery_type: pedido.tipo_entrega,
            delivery_address: pedido.endereco_entrega,
            total_products_centavos: pedido.total_produtos_centavos,
            delivery_fee_centavos: pedido.taxa_entrega_centavos,
            total_order_centavos: pedido.total_pedido_centavos,
          },
          customer: {
            name: (pedido.clientes as any)?.nome || 'Cliente',
            phone: (pedido.clientes as any)?.telefone || null,
          },
          line_items: (pedido.itens_pedido || []).map((i: any) => ({
            id: i.id,
            name: i.produtos?.nome || 'Item',
            quantity: i.quantidade,
            unit_price_centavos: i.preco_unitario_centavos,
            line_total_centavos: i.quantidade * i.preco_unitario_centavos,
          })),
          charged_amount_centavos: pedido.total_pedido_centavos,
          payment: {
            status: pedido.status_pagamento,
            method: pedido.meio_pagamento || 'pix',
          },
          establishment: { name: 'Ambiente de demonstração' },
          issuance: {
            issued_at: pedido.data_criacao || new Date().toISOString(),
            snapshot_version: 1,
          },
        },
      }
    }
  }

  if (!receipt?.snapshot) return new Response('Not found', { status: 404 })

  const isSegundaVia = isClient || new URL(_request.url).searchParams.get('via') === 'cliente'

  return new Response(buildReceiptPdf(receipt.snapshot as ReceiptSnapshot, { isSegundaVia }) as unknown as BodyInit, {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="comprovante-${isSegundaVia ? '2via-' : ''}${id}.pdf"`,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  })
}
