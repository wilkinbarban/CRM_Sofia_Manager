import {
  adicionarItemAoCarrinho,
  obterOuCriarCarrinhoAtivo,
  removerItemDoCarrinho,
  limparCarrinho,
  converterCarrinhoEmPedido,
} from '@/lib/carrinho/service'
import { createAdminClient } from '@/lib/supabase/admin'

export interface SofiaToolContext {
  clienteId: string
  telefone?: string
  canal?: 'whatsapp' | 'telegram' | 'web'
  supabaseClient?: any
}

export interface SofiaToolResult {
  success: boolean
  mensagem: string
  data?: any
  error?: string
}

function formatarMoeda(centavos: number): string {
  return (centavos / 100).toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  })
}

const HORARIOS_RETIRADA_DOMINGO = [
  '11:30',
  '11:45',
  '12:00',
  '12:15',
  '12:30',
  '12:45',
  '13:00',
  '13:15',
]

function getSupabase(override?: any) {
  if (override) return override
  try {
    return createAdminClient()
  } catch {
    return null
  }
}

function mensagemStatusComprovante(status?: { proof_status?: string; payment_status?: string } | null): string {
  if (!status || status.proof_status === 'indisponivel' || status.payment_status === 'indisponivel') {
    return 'Não consegui consultar o status do comprovante com segurança agora. Se precisar, nossa equipe pode ajudar.'
  }

  if (status.payment_status === 'atualizado') {
    return 'O status do pagamento do seu pedido foi atualizado. Para qualquer confirmação, nossa equipe segue à disposição.'
  }

  return 'Seu comprovante está em análise. Esta consulta não confirma recebimento de dinheiro nem toma decisões financeiras.'
}

/**
 * Executa uma Tool da Sofia para operações de negócio no CRM.
 */
export async function executarToolSofia(
  toolName: string,
  args: any,
  context: SofiaToolContext
): Promise<SofiaToolResult> {
  const supabase = getSupabase(context.supabaseClient)

  switch (toolName) {
    case 'adicionar_ao_carrinho': {
      let produtoId = args.produtoId

      // Se o modelo enviou apenas o nome ou slug do produto, buscar o ID correspondente no banco
      if (!produtoId && args.nomeProduto) {
        const { data: prod } = await supabase
          .from('produtos')
          .select('id, nome')
          .ilike('nome', `%${args.nomeProduto}%`)
          .eq('ativo', true)
          .limit(1)
          .maybeSingle()

        if (prod) {
          produtoId = prod.id
        }
      }

      if (!produtoId) {
        return {
          success: false,
          mensagem: 'Não consegui identificar qual produto você deseja adicionar. Pode me confirmar o nome ou número do combo?',
          error: 'PRODUTO_NAO_IDENTIFICADO',
        }
      }

      const res = await adicionarItemAoCarrinho({
        clienteId: context.clienteId,
        produtoId,
        quantidade: args.quantidade || 1,
        canal: context.canal,
        supabaseClient: supabase,
      })

      if (!res.success || !res.carrinho) {
        return {
          success: false,
          mensagem: `Não foi possível adicionar ao carrinho: ${res.error || 'Produto indisponível.'}`,
          error: res.error,
        }
      }

      const item = res.carrinho.itens_carrinho.find((i) => i.produto_id === produtoId)
      const nomeItem = item?.produtos?.nome || 'Item'
      const valorItem = formatarMoeda(item?.preco_unitario_centavos || 0)
      const subtotal = formatarMoeda(res.carrinho.total_centavos)

      return {
        success: true,
        mensagem: `Adicionei ${item?.quantidade || 1}x ${nomeItem} (${valorItem}) ao seu pedido! O subtotal do seu carrinho agora é ${subtotal}.`,
        data: res.carrinho,
      }
    }

    case 'ver_carrinho': {
      const res = await obterOuCriarCarrinhoAtivo(context.clienteId, {
        canal: context.canal,
        supabaseClient: supabase,
      })

      if (!res.success || !res.carrinho) {
        return {
          success: false,
          mensagem: 'Não foi possível carregar seu carrinho no momento.',
          error: res.error,
        }
      }

      const itens = res.carrinho.itens_carrinho || []
      if (itens.length === 0) {
        return {
          success: true,
          mensagem: 'Seu carrinho está vazio no momento. Que tal dar uma olhada nos nossos combos assados?',
          data: res.carrinho,
        }
      }

      const lista = itens
        .map((i) => `• ${i.quantidade}x ${i.produtos?.nome || 'Item'} — ${formatarMoeda(i.preco_total_centavos)}`)
        .join('\n')

      const total = formatarMoeda(res.carrinho.total_centavos)

      return {
        success: true,
        mensagem: `Aqui está o seu carrinho atual:\n\n${lista}\n\nTotal: ${total}`,
        data: res.carrinho,
      }
    }

    case 'remover_do_carrinho': {
      let produtoId = args.produtoId
      if (!produtoId && args.nomeProduto) {
        const { data: prod } = await supabase
          .from('produtos')
          .select('id')
          .ilike('nome', `%${args.nomeProduto}%`)
          .limit(1)
          .maybeSingle()

        if (prod) produtoId = prod.id
      }

      if (!produtoId) {
        return {
          success: false,
          mensagem: 'Não encontrei qual item você deseja remover.',
          error: 'PRODUTO_NAO_IDENTIFICADO',
        }
      }

      const res = await removerItemDoCarrinho({
        clienteId: context.clienteId,
        produtoId,
        supabaseClient: supabase,
      })

      return {
        success: true,
        mensagem: 'Item removido do seu carrinho com sucesso.',
        data: res.carrinho,
      }
    }

    case 'limpar_carrinho': {
      const res = await limparCarrinho({
        clienteId: context.clienteId,
        supabaseClient: supabase,
      })

      return {
        success: true,
        mensagem: 'Seu carrinho foi esvaziado com sucesso.',
        data: res.carrinho,
      }
    }

    case 'consultar_horarios_retirada': {
      const horariosTexto = HORARIOS_RETIRADA_DOMINGO.join(', ')
      return {
        success: true,
        mensagem: `Nossos horários de retirada para domingo são: ${horariosTexto}. As retiradas são feitas no balcão de retirada. Este é um ambiente de demonstração com dados de teste.`,
        data: HORARIOS_RETIRADA_DOMINGO,
      }
    }

    case 'explicar_formatos_comprovante': {
      return {
        success: true,
        mensagem: 'Você pode enviar o comprovante em PDF, JPEG ou PNG, com até 5 MB. O envio não confirma recebimento de dinheiro nem toma decisões financeiras.',
      }
    }

    case 'consultar_status_comprovante_pagamento': {
      try {
        if (!supabase) throw new Error('SUPABASE_INDISPONIVEL')
        const { data, error } = await supabase.rpc('get_customer_payment_proof_public_status', {
          p_customer_id: context.clienteId,
          p_pedido_id: args.pedidoId || null,
        })
        if (error) throw error
        const status = Array.isArray(data) ? data[0] : data
        return {
          success: true,
          mensagem: mensagemStatusComprovante(status),
          data: status || { proof_status: 'indisponivel', payment_status: 'indisponivel' },
        }
      } catch {
        return {
          success: false,
          mensagem: 'Não consegui consultar o status do comprovante com segurança agora. Se precisar, nossa equipe pode ajudar.',
          error: 'STATUS_COMPROVANTE_INDISPONIVEL',
        }
      }
    }

    case 'confirmar_pedido': {
      const cartRes = await obterOuCriarCarrinhoAtivo(context.clienteId, {
        canal: context.canal,
        supabaseClient: supabase,
      })

      if (!cartRes.success || !cartRes.carrinho || cartRes.carrinho.itens_carrinho.length === 0) {
        return {
          success: false,
          mensagem: 'Seu carrinho está vazio. Adicione itens antes de confirmar o pedido.',
          error: 'CARRINHO_VAZIO',
        }
      }

      const res = await converterCarrinhoEmPedido({
        carrinhoId: cartRes.carrinho.id,
        meioPagamento: args.meioPagamento || 'pix',
        horarioRetirada: args.horarioRetirada || cartRes.carrinho.horario_retirada || '12:00',
        supabaseClient: supabase,
      })

      if (!res.success || !res.pedidoId) {
        return {
          success: false,
          mensagem: `Não foi possível confirmar o pedido: ${res.error || 'Erro de disponibilidade ou estoque.'}`,
          error: res.error,
        }
      }

      return {
        success: true,
        mensagem: `✅ Pedido confirmado com sucesso! Seu número de pedido é #${res.pedidoId.substring(0, 8)}. Já reservamos seus assados no bafo para o domingo!`,
        data: res,
      }
    }

    default:
      return {
        success: false,
        mensagem: 'Ação não reconhecida.',
        error: 'TOOL_NAO_ENCONTRADA',
      }
  }
}
