'use server'

import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { agendarPedidoNoCalendario } from '@/lib/calendar/google'
import {
  projetarElegibilidadeReceita,
  resumirReceitaRealizada,
  type OrderRevenueInput,
} from '@/lib/orders/revenueEligibility'
import { notificarClienteAtualizacaoPedido } from '@/lib/orders/orderNotifications'
import { obterConfiguracaoSistema } from '@/lib/config/sistema'
import { enviarMensagemWhatsapp } from '@/lib/whatsapp/send'
import { enviarMensagemTelegram } from '@/lib/telegram/send'
import { processCanonicalPaymentProof } from '@/lib/payment-proofs/canonical-intake'
import QRCode from 'qrcode'

function safeRevalidatePath(path: string) {
  try {
    revalidatePath(path)
  } catch {
    // Silencia erros de contexto quando executado em testes unitários sem store estática
  }
}


// Schema para validação dos dados do pedido recebidos pelo operador
const itemPedidoSchema = z.object({
  produto_id: z.string().uuid('ID do produto inválido'),
  quantidade: z.number().int().min(1, 'A quantidade deve ser de pelo menos 1'),
})

const criarPedidoSchema = z.object({
  cliente_id: z.string().uuid('ID do cliente inválido'),
  conversa_id: z.string().uuid('ID da conversa inválido').nullable().optional(),
  tipo_entrega: z.enum(['entrega', 'retirada']),
  endereco_entrega: z.string().nullable().optional(),
  taxa_entrega_centavos: z.number().int().min(0, 'A taxa de entrega não pode ser negativa'),
  meio_pagamento: z.enum(['pix', 'cartao_credito', 'cartao_debito', 'dinheiro']),
  itens: z.array(itemPedidoSchema).min(1, 'O pedido deve conter pelo menos um item'),
})

/**
 * Helper para validar se o usuário atual está autenticado, ativo
 * e se possui papel de operador ('admin', 'supervisor', 'vendedor').
 */
async function verificarPermissaoOperador() {
  const supabase = await createClient()

  // 1. Obter usuário autenticado da sessão
  const { data: { user }, error: authError } = await supabase.auth.getUser()
  if (authError || !user) {
    return { authorized: false, error: 'ACESSO_NEGADO_NAO_AUTENTICADO', supabase }
  }

  // 2. Buscar o perfil do usuário e validar suas permissões e status
  const { data: perfil, error: perfilError } = await supabase
    .from('perfis')
    .select('funcao, ativo')
    .eq('id', user.id)
    .single()

  if (perfilError || !perfil) {
    return { authorized: false, error: 'PERFIL_NAO_ENCONTRADO', supabase }
  }

  if (!perfil.ativo) {
    return { authorized: false, error: 'PERFIL_INATIVO', supabase }
  }

  const funcoesAutorizadas = ['admin', 'supervisor', 'vendedor']
  if (!funcoesAutorizadas.includes(perfil.funcao)) {
    return { authorized: false, error: 'ACESSO_NEGADO_PERMISSAO_INSUFICIENTE', supabase }
  }

  return { authorized: true, user, supabase }
}

export async function criarPedidoOperador(data: {
  cliente_id: string
  conversa_id?: string | null
  tipo_entrega: 'entrega' | 'retirada'
  endereco_entrega?: string | null
  taxa_entrega_centavos: number
  meio_pagamento: 'pix' | 'cartao_credito' | 'cartao_debito' | 'dinheiro'
  itens: {
    produto_id: string
    quantidade: number
  }[]
}) {
  try {
    const check = await verificarPermissaoOperador()
    if (!check.authorized) {
      return { success: false, error: check.error }
    }

    const { supabase } = check

    // 1. Validar dados recebidos
    const validation = criarPedidoSchema.safeParse(data)
    if (!validation.success) {
      return {
        success: false,
        error: 'DADOS_INVALIDOS',
        details: validation.error.flatten().fieldErrors,
      }
    }

    const input = validation.data

    // 2. Buscar produtos no banco para resgatar os preços unitários atuais em centavos
    const produtoIds = input.itens.map((item) => item.produto_id)
    const { data: produtos, error: produtosError } = await supabase
      .from('produtos')
      .select('id, preco_centavos, nome, ativo')
      .in('id', produtoIds)

    if (produtosError || !produtos) {
      return {
        success: false,
        error: 'ERRO_PRODUTOS',
        message: produtosError ? produtosError.message : 'Produtos não encontrados no catálogo',
      }
    }

    // Validar se todos os produtos requisitados existem e estão ativos
    const mapaProdutos = new Map<string, { preco_centavos: number; ativo: boolean }>()
    produtos.forEach((p) => mapaProdutos.set(p.id, { preco_centavos: p.preco_centavos, ativo: p.ativo }))

    for (const item of input.itens) {
      const prod = mapaProdutos.get(item.produto_id)
      if (!prod) {
        return { success: false, error: 'PRODUTO_NAO_ENCONTRADO', message: `Produto ${item.produto_id} não encontrado` }
      }
      if (!prod.ativo) {
        return { success: false, error: 'PRODUTO_INATIVO', message: `Produto ${item.produto_id} não está ativo` }
      }
    }

    // 3. Calcular totais em centavos
    let totalProdutosCentavos = 0
    const itensComPreco = input.itens.map((item) => {
      const prod = mapaProdutos.get(item.produto_id)!
      const precoUnitario = prod.preco_centavos
      totalProdutosCentavos += precoUnitario * item.quantidade

      return {
        produto_id: item.produto_id,
        quantidade: item.quantidade,
        preco_unitario_centavos: precoUnitario,
      }
    })

    const totalPedidoCentavos = totalProdutosCentavos + input.taxa_entrega_centavos

    // 4. Inserir o Pedido (transação lógica usando try-catch no nível da aplicação)
    const { data: pedido, error: pedidoError } = await supabase
      .from('pedidos')
      .insert({
        cliente_id: input.cliente_id,
        conversa_id: input.conversa_id || null,
        status: 'novo',
        tipo_entrega: input.tipo_entrega,
        endereco_entrega: input.tipo_entrega === 'entrega' ? input.endereco_entrega : null,
        taxa_entrega_centavos: input.tipo_entrega === 'entrega' ? input.taxa_entrega_centavos : 0,
        total_produtos_centavos: totalProdutosCentavos,
        total_pedido_centavos: input.tipo_entrega === 'entrega' ? totalPedidoCentavos : totalProdutosCentavos,
        status_pagamento: 'pendente',
        meio_pagamento: input.meio_pagamento,
      })
      .select()
      .single()

    if (pedidoError || !pedido) {
      console.error('Erro ao inserir pedido:', pedidoError)
      return { success: false, error: `ERRO_CRIACAO_PEDIDO: ${pedidoError?.message || 'Falha desconhecida'}` }
    }

    // 5. Inserir os itens vinculados ao pedido criado
    const itensInsertData = itensComPreco.map((item) => ({
      pedido_id: pedido.id,
      produto_id: item.produto_id,
      quantidade: item.quantidade,
      preco_unitario_centavos: item.preco_unitario_centavos,
    }))

    const { error: itensError } = await supabase
      .from('itens_pedido')
      .insert(itensInsertData)

    if (itensError) {
      console.error('Erro ao inserir itens do pedido, revertendo pedido...', itensError)
      
      // Simulação de Rollback: Deletar o pedido para não deixar órfãos no banco
      await supabase
        .from('pedidos')
        .delete()
        .eq('id', pedido.id)

      return { success: false, error: `ERRO_ITENS_PEDIDO: ${itensError.message}` }
    }

    safeRevalidatePath('/atendimento')
    return { success: true, data: pedido }
  } catch (error: any) {
    console.error('Erro na action criarPedidoOperador:', error)
    return { success: false, error: error.message || 'ERRO_INTERNO' }
  }
}

const editarItensPedidoSchema = z.object({
  pedidoId: z.string().min(1, 'ID do pedido inválido'),
  itens: z.array(
    z.object({
      produto_id: z.string().min(1, 'ID do produto inválido'),
      quantidade: z.number().int().min(1, 'A quantidade deve ser de pelo menos 1'),
      preco_unitario_centavos: z.number().int().min(0, 'Preço unitário inválido'),
    })
  ).min(1, 'O pedido deve conter pelo menos 1 item'),
  notificarCliente: z.boolean().optional().default(true),
})

/**
 * Permite ao operador editar os componentes/itens de um pedido ativo no Atendimento,
 * recalculando o total em tempo real e notificando o cliente nos canais configurados.
 */
export async function actionEditarItensPedidoOperador(input: {
  pedidoId: string
  itens: Array<{
    produto_id: string
    quantidade: number
    preco_unitario_centavos: number
  }>
  notificarCliente?: boolean
}) {
  try {
    const validacao = editarItensPedidoSchema.safeParse(input)
    if (!validacao.success) {
      const msg = validacao.error.issues?.[0]?.message || (validacao.error as any).errors?.[0]?.message || 'DADOS_INVALIDOS'
      return { success: false, error: msg }
    }

    const { pedidoId, itens, notificarCliente } = validacao.data

    const supabase = await createClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return { success: false, error: 'ACESSO_NEGADO_NAO_AUTENTICADO' }
    }

    const { data: perfil, error: perfilError } = await supabase
      .from('perfis')
      .select('funcao, ativo')
      .eq('id', user.id)
      .single()

    const funcoesValidas = ['admin', 'supervisor', 'vendedor']
    if (perfilError || !perfil || !perfil.ativo || !funcoesValidas.includes(perfil.funcao)) {
      return { success: false, error: 'ACESSO_NEGADO_PERMISSAO_INSUFICIENTE' }
    }

    const admin = createAdminClient()

    // 1. Buscar pedido atual
    const { data: pedido, error: pedidoError } = await admin
      .from('pedidos')
      .select(`
        id,
        cliente_id,
        conversa_id,
        status,
        status_pagamento,
        tipo_entrega,
        taxa_entrega_centavos,
        total_produtos_centavos,
        total_pedido_centavos
      `)
      .eq('id', pedidoId)
      .single()

    if (pedidoError || !pedido) {
      return { success: false, error: 'PEDIDO_NAO_ENCONTRADO' }
    }

    if (pedido.status === 'cancelado' || pedido.status === 'entregue') {
      return { success: false, error: `PEDIDO_NAO_EDITAVEL: O pedido está com status '${pedido.status}'` }
    }

    // 2. Buscar nomes e detalhes atualizados dos produtos
    const produtoIds = itens.map((it) => it.produto_id)
    const { data: produtosDb, error: prodError } = await admin
      .from('produtos')
      .select('id, nome, preco_centavos')
      .in('id', produtoIds)

    if (prodError) {
      return { success: false, error: `ERRO_PRODUTOS: ${prodError.message}` }
    }

    const produtosMap = new Map((produtosDb || []).map((p) => [p.id, p]))

    // 3. Recalcular totais com base nos preços dos itens
    let novoTotalProdutosCentavos = 0
    const novosItensValidados = itens.map((it) => {
      const prodInfo = produtosMap.get(it.produto_id)
      const precoUnit = it.preco_unitario_centavos > 0 ? it.preco_unitario_centavos : (prodInfo?.preco_centavos || 0)
      novoTotalProdutosCentavos += precoUnit * it.quantidade
      return {
        pedido_id: pedidoId,
        produto_id: it.produto_id,
        quantidade: it.quantidade,
        preco_unitario_centavos: precoUnit,
        nome: prodInfo?.nome || 'Item',
      }
    })

    const novaTaxa = pedido.taxa_entrega_centavos || 0
    const novoTotalPedidoCentavos = novoTotalProdutosCentavos + novaTaxa

    // 4. Substituir itens do pedido
    await admin.from('itens_pedido').delete().eq('pedido_id', pedidoId)

    const itensParaInserir = novosItensValidados.map((it) => ({
      pedido_id: it.pedido_id,
      produto_id: it.produto_id,
      quantidade: it.quantidade,
      preco_unitario_centavos: it.preco_unitario_centavos,
    }))
    const { error: insertItensError } = await admin
      .from('itens_pedido')
      .insert(itensParaInserir)

    if (insertItensError) {
      console.error('[actionEditarItensPedidoOperador] Erro ao inserir itens atualizados:', insertItensError)
      return { success: false, error: `ERRO_ATUALIZACAO_ITENS: ${insertItensError.message}` }
    }

    // 5. Atualizar totais do pedido
    const { data: pedidoAtualizado, error: updatePedidoError } = await admin
      .from('pedidos')
      .update({
        total_produtos_centavos: novoTotalProdutosCentavos,
        total_pedido_centavos: novoTotalPedidoCentavos,
        data_atualizacao: new Date().toISOString(),
      })
      .eq('id', pedidoId)
      .select()
      .single()

    if (updatePedidoError) {
      console.error('[actionEditarItensPedidoOperador] Erro ao atualizar pedido:', updatePedidoError)
      return { success: false, error: `ERRO_ATUALIZACAO_PEDIDO: ${updatePedidoError.message}` }
    }

    // 6. Formatar mensagem detalhada
    const formatarMoeda = (centavos: number) =>
      (centavos / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
    const itensTexto = novosItensValidados
      .map((it) => `• ${it.quantidade}x ${it.nome} (${formatarMoeda(it.preco_unitario_centavos * it.quantidade)})`)
      .join('\n')

    const mensagemAtualizacao = `📝 *Pedido #${pedidoId.substring(0, 8).toUpperCase()} Atualizado no Balcão!*\n\n*Itens Atualizados:*\n${itensTexto}\n\n💰 *Novo Total:* ${formatarMoeda(novoTotalPedidoCentavos)}\n\nOlá! Seu pedido foi ajustado conforme combinado com o atendimento. Você já pode conferir no seu painel!`

    safeRevalidatePath('/atendimento')
    safeRevalidatePath('/atendimento/pedidos')
    safeRevalidatePath('/cliente/chat')
    safeRevalidatePath('/cliente/pedidos')

    // 7. Notificar cliente omnichannel se solicitado
    if (notificarCliente) {
      notificarClienteAtualizacaoPedido({
        pedidoId,
        tipo: 'status_pedido',
        novoStatus: pedido.status,
        statusPagamento: pedido.status_pagamento,
        mensagem: mensagemAtualizacao,
      }).catch(() => {
        console.warn('[actionEditarItensPedidoOperador] Falha não-bloqueante na notificação')
      })
    }

    return {
      success: true,
      pedido: pedidoAtualizado,
      totalProdutosCentavos: novoTotalProdutosCentavos,
      totalPedidoCentavos: novoTotalPedidoCentavos,
    }
  } catch (error: any) {
    console.error('[actionEditarItensPedidoOperador] Erro inesperado:', error)
    return { success: false, error: error.message || 'ERRO_INTERNO' }
  }
}

/**
 * Cria um pedido real no banco de dados a partir do carrinho ativo do cliente.
 * Limpa o carrinho e registra o pedido com status 'novo' para que os atendentes humanos
 * vejam o pedido na Área de Atendimento e o cliente veja em "Meus Pedidos".
 */
export async function actionCriarPedidoCliente(data: {
  conversaId?: string | null
  horarioRetirada?: string | null
}) {
  try {
    const supabase = await createClient()

    // 1. Validar autenticação do usuário
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return { success: false, error: 'ACESSO_NEGADO_NAO_AUTENTICADO' }
    }

    const admin = createAdminClient()

    // 2. Buscar cliente vinculado ao usuário
    const { data: cliente, error: clienteError } = await admin
      .from('clientes')
      .select('id, nome, telefone, usuario_id')
      .eq('usuario_id', user.id)
      .single()

    if (clienteError || !cliente) {
      return { success: false, error: 'CLIENTE_NAO_ENCONTRADO' }
    }

    // 3. Buscar carrinho ativo com itens e detalhes dos produtos
    const { data: carrinho, error: cartError } = await admin
      .from('carrinhos')
      .select(`
        id,
        horario_retirada,
        itens_carrinho (
          id,
          produto_id,
          quantidade,
          preco_unitario_centavos,
          produtos (
            id,
            nome,
            preco_centavos,
            ativo
          )
        )
      `)
      .eq('cliente_id', cliente.id)
      .maybeSingle()

    if (cartError || !carrinho || !carrinho.itens_carrinho || carrinho.itens_carrinho.length === 0) {
      return { success: false, error: 'CARRINHO_VAZIO', message: 'Nenhum item encontrado no carrinho ativo' }
    }

    // 4. Validar produtos e calcular totais
    let totalProdutosCentavos = 0
    const itensValidos: Array<{
      produto_id: string
      quantidade: number
      preco_unitario_centavos: number
      nome: string
    }> = []

    for (const it of carrinho.itens_carrinho as any[]) {
      const prod = it.produtos
      if (!prod || prod.ativo === false) continue
      const precoUnit = prod.preco_centavos || it.preco_unitario_centavos
      totalProdutosCentavos += precoUnit * it.quantidade
      itensValidos.push({
        produto_id: it.produto_id,
        quantidade: it.quantidade,
        preco_unitario_centavos: precoUnit,
        nome: prod.nome,
      })
    }

    if (itensValidos.length === 0) {
      return { success: false, error: 'PRODUTOS_INDISPONIVEIS', message: 'Nenhum produto ativo disponível no catálogo' }
    }

    // 5. Inserir Pedido no banco
    const { data: pedido, error: pedidoError } = await admin
      .from('pedidos')
      .insert({
        cliente_id: cliente.id,
        conversa_id: data.conversaId || null,
        status: 'novo',
        tipo_entrega: 'retirada',
        endereco_entrega: null,
        taxa_entrega_centavos: 0,
        total_produtos_centavos: totalProdutosCentavos,
        total_pedido_centavos: totalProdutosCentavos,
        status_pagamento: 'pendente',
        meio_pagamento: 'pix',
      })
      .select()
      .single()

    if (pedidoError || !pedido) {
      console.error('[actionCriarPedidoCliente] Erro ao inserir pedido:', pedidoError)
      return { success: false, error: `ERRO_CRIACAO_PEDIDO: ${pedidoError?.message || 'Falha desconhecida'}` }
    }

    // 6. Inserir itens vinculados ao pedido
    const itensInsert = itensValidos.map((it) => ({
      pedido_id: pedido.id,
      produto_id: it.produto_id,
      quantidade: it.quantidade,
      preco_unitario_centavos: it.preco_unitario_centavos,
    }))

    const { error: itensError } = await admin
      .from('itens_pedido')
      .insert(itensInsert)

    if (itensError) {
      console.error('[actionCriarPedidoCliente] Erro ao inserir itens, revertendo pedido:', itensError)
      await admin.from('pedidos').delete().eq('id', pedido.id)
      return { success: false, error: `ERRO_ITENS_PEDIDO: ${itensError.message}` }
    }

    // 7. Limpar itens do carrinho ativo
    await admin.from('itens_carrinho').delete().eq('carrinho_id', carrinho.id)

    // 8. Formatar mensagem e registrar no chat
    const formatarMoeda = (centavos: number) =>
      (centavos / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
    const horarioEfetivo = data.horarioRetirada || carrinho.horario_retirada || '12:00'
    const itensTexto = itensValidos
      .map((it) => `• ${it.quantidade}x ${it.nome} (${formatarMoeda(it.preco_unitario_centavos * it.quantidade)})`)
      .join('\n')

    const mensagemTexto = `🛒 *Pedido #${pedido.id.substring(0, 8).toUpperCase()} Registrado!*\n\n${itensTexto}\n\n💰 *Total:* ${formatarMoeda(totalProdutosCentavos)}\n🕒 *Horário de Retirada:* ${horarioEfetivo}\n📍 *Local:* Balcão Umbará (Casa de Assados Brasa & Sabor)\n\nOlá! Acabei de enviar esse pedido para o atendimento!`

    let novaMensagem = null
    if (data.conversaId) {
      const { data: msgData } = await admin
        .from('mensagens')
        .insert({
          conversa_id: data.conversaId,
          remetente: 'cliente',
          conteudo: mensagemTexto,
          url_anexo: null,
        })
        .select()
        .single()

      novaMensagem = msgData

      await admin.from('conversas').update({
        data_atualizacao: new Date().toISOString(),
      }).eq('id', data.conversaId)
    }

    safeRevalidatePath('/atendimento')
    safeRevalidatePath('/atendimento/pedidos')
    safeRevalidatePath('/cliente/chat')
    safeRevalidatePath('/cliente/pedidos')

    return {
      success: true,
      pedido,
      mensagem: novaMensagem,
      mensagemTexto,
    }
  } catch (error: any) {
    console.error('[actionCriarPedidoCliente] Erro inesperado:', error)
    return { success: false, error: error.message || 'ERRO_INTERNO' }
  }
}

/**
 * Lista todos os pedidos registrados pertencentes ao cliente autenticado atual.
 */
export async function actionListarMeusPedidosCliente() {
  try {
    const supabase = await createClient()

    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return { success: false, error: 'ACESSO_NEGADO_NAO_AUTENTICADO', data: [] }
    }

    const admin = createAdminClient()
    const { data: cliente, error: clienteError } = await admin
      .from('clientes')
      .select('id')
      .eq('usuario_id', user.id)
      .single()

    if (clienteError || !cliente) {
      return { success: false, error: 'CLIENTE_NAO_ENCONTRADO', data: [] }
    }

    const { data: pedidos, error: pedidosError } = await admin
      .from('pedidos')
      .select(`
        id,
        cliente_id,
        conversa_id,
        status,
        tipo_entrega,
        endereco_entrega,
        taxa_entrega_centavos,
        total_produtos_centavos,
        total_pedido_centavos,
        status_pagamento,
        meio_pagamento,
        data_criacao,
        data_atualizacao,
        itens_pedido (
          id,
          produto_id,
          quantidade,
          preco_unitario_centavos,
          produtos (
            id,
            nome,
            preco_centavos,
            url_imagem,
            url_imagem_thumb
          )
        )
      `)
      .eq('cliente_id', cliente.id)
      .order('data_criacao', { ascending: false })

    if (pedidosError) {
      console.error('[actionListarMeusPedidosCliente] Erro ao listar pedidos:', pedidosError)
      return { success: false, error: pedidosError.message, data: [] }
    }

    const orderIds = (pedidos || []).map((pedido: any) => pedido.id)
    const { data: locks, error: locksError } = orderIds.length
      ? await supabase.rpc('list_order_payment_proof_locks', { p_order_ids: orderIds })
      : { data: [], error: null }
    if (locksError) {
      console.error('[actionListarMeusPedidosCliente] Erro ao projetar revisão:', locksError)
      return {
        success: true,
        error: 'REVISAO_PAGAMENTO_INDISPONIVEL',
        data: (pedidos || []).map((pedido: any) => ({
          ...pedido,
          payment_review: {
            locked: true,
            status: 'unavailable',
            proofId: null,
            lockedAt: null,
            paymentReviewUnavailable: true,
          },
        })),
      }
    }
    const lockByOrder = new Map(
      (locks || []).map((lock: any) => [lock.pedido_id, lock]),
    )
    const data = (pedidos || []).map((pedido: any) => {
      const lock = lockByOrder.get(pedido.id) as any
      return {
        ...pedido,
        payment_review: lock
          ? {
              locked: true,
              status: lock.proof_status,
              proofId: lock.proof_id,
              lockedAt: lock.locked_at,
            }
          : { locked: false, status: null, proofId: null, lockedAt: null },
      }
    })

    return { success: true, data }
  } catch (error: any) {
    console.error('[actionListarMeusPedidosCliente] Erro inesperado:', error)
    return { success: false, error: error.message || 'ERRO_INTERNO', data: [] }
  }
}

function mapearErroEstoquePedido(error: { code?: string; message?: string }) {
  if (error.message?.includes('ESTOQUE_INSUFICIENTE')) return 'ESTOQUE_INSUFICIENTE'
  if (error.message?.includes('CANCELAMENTO_SEM_CONFIRMACAO')) return 'CANCELAMENTO_SEM_CONFIRMACAO'
  if (error.message?.includes('EFEITOS_ESTOQUE_INDISPONIVEIS')) return 'EFEITOS_ESTOQUE_INDISPONIVEIS'
  if (error.message?.includes('IDEMPOTENCY_CONFLICT') || error.code === '23505') return 'CONFLITO_IDEMPOTENCIA'
  if (error.message?.includes('PEDIDO_NAO_ENCONTRADO')) return 'PEDIDO_NAO_ENCONTRADO'
  if (error.code === '42501') return 'ACESSO_NEGADO_PERMISSAO_INSUFICIENTE'
  return 'ERRO_ESTOQUE_PEDIDO'
}

function mapearErroStatusPagamento(error: { code?: string; message?: string }) {
  if (error.message?.includes('ORDER_PAYMENT_PROOF_ALREADY_PENDING')) {
    return {
      error: 'ORDER_PAYMENT_PROOF_ALREADY_PENDING',
      continuation: 'REJEITAR_OU_CONCILIAR_COMPROVANTE_ATIVO',
    }
  }
  if (error.message?.includes('MANUAL_PAYMENT_REASON_REQUIRED')) {
    return { error: 'MOTIVO_APROVACAO_MANUAL_OBRIGATORIO', continuation: 'INFORMAR_MOTIVO_APROVACAO_MANUAL' }
  }
  if (error.message?.includes('MANUAL_PAYMENT_IDEMPOTENCY_CONFLICT')) {
    return { error: 'CONFLITO_IDEMPOTENCIA_PAGAMENTO_MANUAL', continuation: 'RECARREGAR_STATUS_PAGAMENTO' }
  }
  if (error.message?.includes('MERCADO_PAGO_EXTERNAL_REFERENCE_CONFLICT') || error.code === '23505') {
    return { error: 'CONFLITO_REFERENCIA_MERCADO_PAGO', continuation: 'REVISAR_REFERENCIA_MERCADO_PAGO' }
  }
  if (error.message?.includes('PEDIDO_NAO_ENCONTRADO')) {
    return { error: 'PEDIDO_NAO_ENCONTRADO', continuation: 'SELECIONAR_PEDIDO_EXISTENTE' }
  }
  if (error.code === '42501') {
    return { error: 'ACESSO_NEGADO_PERMISSAO_INSUFICIENTE', continuation: 'SOLICITAR_ACESSO_OPERADOR' }
  }
  return { error: 'ERRO_STATUS_PAGAMENTO', continuation: 'TENTAR_NOVAMENTE' }
}

function mapearErroTransicaoPedido(error: { code?: string; message?: string }) {
  if (error.message?.includes('TRANSICAO_PEDIDO_INVALIDA') || error.code === '23514') {
    return {
      error: 'TRANSICAO_PEDIDO_INVALIDA',
      continuation: 'RECARREGAR_ACOES_VALIDAS',
    }
  }
  if (error.message?.includes('IDEMPOTENCY_CONFLICT') || error.code === '23505') {
    return {
      error: 'CONFLITO_IDEMPOTENCIA',
      continuation: 'RECARREGAR_ACOES_VALIDAS',
    }
  }
  if (error.message?.includes('PEDIDO_NAO_ENCONTRADO')) {
    return {
      error: 'PEDIDO_NAO_ENCONTRADO',
      continuation: 'SELECIONAR_PEDIDO_EXISTENTE',
    }
  }
  if (error.code === '42501') {
    return {
      error: 'ACESSO_NEGADO_PERMISSAO_INSUFICIENTE',
      continuation: 'SOLICITAR_ACESSO_OPERADOR',
    }
  }
  return {
    error: 'ERRO_TRANSICAO_PEDIDO',
    continuation: 'TENTAR_NOVAMENTE',
  }
}

export async function confirmarPedidoOperador(pedidoId: string, correlationId = pedidoId) {
  try {
    const check = await verificarPermissaoOperador()
    if (!check.authorized) {
      return { success: false, error: check.error }
    }

    const { supabase } = check

    const { data: pedido, error: stockError } = await supabase.rpc('transicionar_pedido', {
      p_pedido_id: pedidoId,
      p_novo_status: 'confirmado',
      p_idempotency_key: correlationId,
      p_reason: null,
    }).single()
    if (stockError || !pedido) return { success: false, error: mapearErroEstoquePedido(stockError || {}) }

    // 2. Agendar no Google Calendar de forma resiliente
    const googleEventId = await agendarPedidoNoCalendario(pedidoId)

    if (googleEventId) {
      // Grava o google_event_id no banco
      const { error: updateCalError } = await supabase
        .from('pedidos')
        .update({ google_event_id: googleEventId })
        .eq('id', pedidoId)

      if (updateCalError) {
        console.error(`[Pedidos] Erro ao gravar google_event_id no pedido: ${updateCalError.message}`)
      }
    }

    safeRevalidatePath('/atendimento')

    // transicionar_pedido registra o evento canônico; o outbox entrega a notificação.

    // Buscar o pedido atualizado para retornar
    const { data: pedidoAtualizado } = await supabase
      .from('pedidos')
      .select('*')
      .eq('id', pedidoId)
      .single()

    return { success: true, data: pedidoAtualizado || pedido }
  } catch (error: any) {
    console.error('Erro na action confirmarPedidoOperador:', error)
    return { success: false, error: error.message || 'ERRO_INTERNO' }
  }
}

/**
 * Server Action para gerar uma preferência de pagamento no Mercado Pago.
 * Suporta o modo real e um modo mock (caso o token não esteja configurado).
 * 
 * @param pedidoId ID do pedido a ser pago
 */
export async function gerarPreferenciaPagamento(pedidoId: string) {
  try {
    const supabase = await createClient()

    // 1. Obter usuário autenticado da sessão
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return { success: false, error: 'ACESSO_NEGADO_NAO_AUTENTICADO' }
    }

    // 2. Buscar o perfil do usuário para verificar permissões de operador
    const { data: perfil } = await supabase
      .from('perfis')
      .select('funcao, ativo')
      .eq('id', user.id)
      .maybeSingle()

    // 3. Buscar os detalhes do pedido, cliente e itens
    const { data: pedido, error: pedidoError } = await supabase
      .from('pedidos')
      .select(`
        id,
        status,
        tipo_entrega,
        endereco_entrega,
        taxa_entrega_centavos,
        total_produtos_centavos,
        total_pedido_centavos,
        meio_pagamento,
        cliente_id,
        clientes:cliente_id (
          id,
          usuario_id,
          nome,
          telefone
        ),
        itens:itens_pedido (
          id,
          quantidade,
          preco_unitario_centavos,
          produtos:produto_id (
            id,
            nome
          )
        )
      `)
      .eq('id', pedidoId)
      .single()

    if (pedidoError || !pedido) {
      console.error('[gerarPreferenciaPagamento] Pedido não encontrado:', pedidoError)
      return { success: false, error: 'PEDIDO_NAO_ENCONTRADO' }
    }

    // 4. Validar permissão: operador (admin/supervisor/vendedor) ou cliente dono do pedido
    const funcoesAutorizadas = ['admin', 'supervisor', 'vendedor']
    const isOperador = perfil && perfil.ativo && funcoesAutorizadas.includes(perfil.funcao)
    const clienteDono = pedido.clientes as any
    const isDono = clienteDono && clienteDono.usuario_id === user.id

    if (!isOperador && !isDono) {
      return { success: false, error: 'ACESSO_NEGADO_PERMISSAO_INSUFICIENTE' }
    }

    const availability = await createAdminClient().rpc('assert_order_payment_available', {
      p_pedido_id: pedidoId,
    })
    if (availability.error) {
      return {
        success: false,
        error: availability.error.message?.includes('ORDER_PAYMENT_PROOF_ALREADY_PENDING')
          ? 'ORDER_PAYMENT_PROOF_ALREADY_PENDING'
          : availability.error.message,
      }
    }

    // 5. Validar credencial do Mercado Pago e ativar modo mock se necessário
    const token = (await obterConfiguracaoSistema('MERCADO_PAGO_ACCESS_TOKEN')) || process.env.MERCADO_PAGO_ACCESS_TOKEN
    const isPlaceholder = !token || 
      token.includes('placeholder') || 
      token.includes('insert_here') || 
      token.includes('seu_access_token_mercado_pago_aqui') ||
      token.includes('your_access_token')

    if (isPlaceholder) {
      const mockPrefId = `mock_pref_${pedidoId}`
      const mockUrl = `https://sandbox.mercadopago.com.br/checkout/v1/redirect?pref_id=${mockPrefId}`

      // Persistir o ID de preferência mock no pedido (usando admin client para contornar RLS)
      const supabaseAdmin = createAdminClient()
      const { error: updateError } = await supabaseAdmin
        .from('pedidos')
        .update({ mercado_pago_preferencia_id: mockPrefId })
        .eq('id', pedidoId)

      if (updateError) {
        console.error('[gerarPreferenciaPagamento] Erro ao persistir preferência mock:', updateError)
        return { success: false, error: 'ERRO_PERSISTENCIA_MOCK' }
      }

      return { success: true, url: mockUrl }
    }

    // 6. Preparar itens para a requisição real no Mercado Pago
    // Converter valores de centavos para decimais de Real (BRL)
    const itensPedido = (pedido.itens || []) as any[]
    const items = itensPedido.map((item) => ({
      id: item.produtos?.id || item.produto_id,
      title: item.produtos?.nome || 'Item do Pedido',
      quantity: item.quantidade,
      unit_price: item.preco_unitario_centavos / 100,
      currency_id: 'BRL'
    }))

    // Se houver taxa de entrega, incluir como item
    if (pedido.taxa_entrega_centavos > 0) {
      items.push({
        id: 'taxa-entrega',
        title: 'Taxa de Entrega',
        quantity: 1,
        unit_price: pedido.taxa_entrega_centavos / 100,
        currency_id: 'BRL'
      })
    }

    const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'
    const notificationUrl = `${appUrl}/api/webhooks/mercadopago`
    
    const payload = {
      items,
      back_urls: {
        success: `${appUrl}/cliente/chat?status=success&pedido_id=${pedidoId}`,
        failure: `${appUrl}/cliente/chat?status=failure&pedido_id=${pedidoId}`,
        pending: `${appUrl}/cliente/chat?status=pending&pedido_id=${pedidoId}`
      },
      auto_return: 'approved',
      external_reference: pedidoId,
      notification_url: notificationUrl
    }

    // 7. Chamar a API do Mercado Pago para gerar a preferência
    const response = await fetch('https://api.mercadopago.com/checkout/preferences', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify(payload)
    })

    if (!response.ok) {
      const errorText = await response.text()
      console.error('[gerarPreferenciaPagamento] Falha ao criar preferência no Mercado Pago:', response.status, errorText)
      let friendlyError = 'Falha ao criar checkout no Mercado Pago.'
      try {
        const parsed = JSON.parse(errorText)
        if (parsed.message) friendlyError = `Mercado Pago: ${parsed.message}`
      } catch {
        // fallback
      }
      return { success: false, error: friendlyError, details: errorText }
    }

    const responseData = await response.json()
    const preferenceId = responseData.id
    // Prefer sandbox_init_point if present (enables test user logins on sandbox)
    const initPoint = responseData.sandbox_init_point || responseData.init_point

    if (!preferenceId || !initPoint) {
      console.error('[gerarPreferenciaPagamento] Resposta inválida do Mercado Pago:', responseData)
      return { success: false, error: 'RESPOSTA_INVALIDA_MERCADO_PAGO' }
    }

    // 8. Persistir o ID de preferência real no banco de dados (usando admin client para contornar RLS)
    const supabaseAdmin = createAdminClient()
    const { error: updateError } = await supabaseAdmin
      .from('pedidos')
      .update({ mercado_pago_preferencia_id: preferenceId })
      .eq('id', pedidoId)

    if (updateError) {
      console.error('[gerarPreferenciaPagamento] Erro ao persistir preferência real no banco:', updateError)
      return { success: false, error: 'ERRO_PERSISTENCIA_REAL' }
    }

    return { success: true, url: initPoint }
  } catch (error: any) {
    console.error('Erro na action gerarPreferenciaPagamento:', error)
    return { success: false, error: error.message || 'ERRO_INTERNO' }
  }
}

/**
 * Cancela um pedido e restaura o estoque dos produtos vendidos.
 * Registra movimentações de estoque do tipo 'cancelamento'.
 */
export async function cancelarPedido(pedidoId: string, correlationId = pedidoId) {
  try {
    const check = await verificarPermissaoOperador()
    if (!check.authorized) {
      return { success: false, error: check.error }
    }

    const { supabase } = check
    const { error } = await supabase.rpc('transicionar_pedido', {
      p_pedido_id: pedidoId,
      p_novo_status: 'cancelado',
      p_idempotency_key: correlationId,
      p_reason: null,
    }).single()
    if (error) return { success: false, error: mapearErroEstoquePedido(error) }

    return { success: true, message: 'Pedido cancelado e estoque restaurado.' }
  } catch (error: any) {
    console.error('Erro na action cancelarPedido:', error)
    return { success: false, error: error.message || 'ERRO_INTERNO' }
  }
}

/**
 * Lista pedidos com filtros para o console de atendimento e painel de pedidos.
 */
export async function actionListarPedidos(filtros?: {
  status?: 'novo' | 'confirmado' | 'entregue' | 'cancelado' | 'todos'
  clienteId?: string
  limite?: number
}) {
  try {
    const check = await verificarPermissaoOperador()
    if (!check.authorized) {
      return { success: false, error: check.error }
    }

    const { supabase } = check
    let query = supabase
      .from('pedidos')
      .select(`
        id,
        status,
        tipo_entrega,
        endereco_entrega,
        taxa_entrega_centavos,
        total_produtos_centavos,
        total_pedido_centavos,
        status_pagamento,
        meio_pagamento,
        mercado_pago_preferencia_id,
        google_event_id,
        data_criacao,
        data_atualizacao,
        cliente_id,
        conversa_id,
        clientes:cliente_id (
          id,
          nome,
          telefone,
          email
        ),
        itens:itens_pedido (
          id,
          quantidade,
          preco_unitario_centavos,
          produtos:produto_id (
            id,
            nome,
            url_imagem,
            url_imagem_thumb
          )
        )
      `)
      .order('data_criacao', { ascending: false })

    if (filtros?.status && filtros.status !== 'todos') {
      query = query.eq('status', filtros.status)
    }

    if (filtros?.clienteId) {
      query = query.eq('cliente_id', filtros.clienteId)
    }

    if (filtros?.limite) {
      query = query.limit(filtros.limite)
    } else {
      query = query.limit(100)
    }

    const { data, error } = await query
    if (error) {
      console.error('[actionListarPedidos] Erro na consulta:', error)
      return { success: false, error: error.message }
    }

    const mapped = (data || []).map((pedido: any) => ({
      ...pedido,
      ...projetarElegibilidadeReceita(pedido),
      itens: (pedido.itens || []).map((item: any) => ({
        ...item,
        preco_total_centavos: item.preco_total_centavos ?? ((item.preco_unitario_centavos || 0) * (item.quantidade || 1)),
      })),
    }))

    return { success: true, data: mapped }
  } catch (error: any) {
    console.error('Erro na action actionListarPedidos:', error)
    return { success: false, error: error.message || 'ERRO_INTERNO' }
  }
}

/**
 * Exposes a non-PII sales report whose realization and future receipt
 * eligibility use the same authoritative order/payment predicate.
 */
export async function actionObterResumoReceitaRealizada() {
  try {
    const check = await verificarPermissaoOperador()
    if (!check.authorized) {
      return { success: false, error: check.error }
    }

    const { data, error } = await check.supabase
      .from('pedidos')
      .select('id, status, status_pagamento, total_pedido_centavos')
      .limit(100)

    if (error) {
      console.error('[actionObterResumoReceitaRealizada] Erro na consulta:', error)
      return {
        success: false,
        error: 'ERRO_RESUMO_RECEITA',
        continuation: 'TENTAR_NOVAMENTE',
      }
    }

    return {
      success: true,
      data: resumirReceitaRealizada((data || []) as OrderRevenueInput[]),
    }
  } catch (error: any) {
    console.error('Erro na action actionObterResumoReceitaRealizada:', error)
    return {
      success: false,
      error: 'ERRO_RESUMO_RECEITA',
      continuation: 'TENTAR_NOVAMENTE',
    }
  }
}

/**
 * Atualiza o status de um pedido (ex: confirmado -> entregue ou cancelado).
 */
export async function actionAtualizarStatusPedido(params: {
  pedidoId: string
  novoStatus: 'novo' | 'confirmado' | 'entregue' | 'cancelado'
  idempotencyKey?: string
  reason?: string
}) {
  try {
    const check = await verificarPermissaoOperador()
    if (!check.authorized) {
      return { success: false, error: check.error }
    }

    const { supabase } = check
    const { pedidoId, novoStatus, reason } = params
    const { data, error } = await supabase.rpc('transicionar_pedido', {
      p_pedido_id: pedidoId,
      p_novo_status: novoStatus,
      p_idempotency_key: params.idempotencyKey ?? crypto.randomUUID(),
      p_reason: reason?.trim() || null,
    }).single()

    if (error || !data) {
      console.error('[actionAtualizarStatusPedido] Erro ao atualizar status:', error)
      return { success: false, ...mapearErroTransicaoPedido(error || {}) }
    }

    safeRevalidatePath('/atendimento')
    safeRevalidatePath('/atendimento/pedidos')

    // transicionar_pedido registra o evento canônico; o outbox entrega a notificação.

    return { success: true, data }
  } catch (error: any) {
    console.error('Erro na action actionAtualizarStatusPedido:', error)
    return { success: false, error: error.message || 'ERRO_INTERNO' }
  }
}

/**
 * Atualiza o status do pagamento do pedido (ex: aprovado para pagamento em dinheiro ou PIX conferido).
 */
export async function actionAtualizarStatusPagamento(params: {
  pedidoId: string
  statusPagamento: 'pendente' | 'aprovado' | 'rejeitado' | 'reembolsado'
  reason?: string
  idempotencyKey?: string
}) {
  try {
    const check = await verificarPermissaoOperador()
    if (!check.authorized) {
      return { success: false, error: check.error }
    }

    const { supabase } = check
    const { pedidoId, statusPagamento, reason } = params
    const normalizedReason = reason?.trim()
    if (!normalizedReason) {
      return {
        success: false,
        error: 'MOTIVO_APROVACAO_MANUAL_OBRIGATORIO',
        continuation: 'INFORMAR_MOTIVO_APROVACAO_MANUAL',
      }
    }
    if (statusPagamento === 'aprovado') {
      const availability = await supabase.rpc('assert_order_payment_available', {
        p_pedido_id: pedidoId,
      })
      if (availability.error) {
        return { success: false, ...mapearErroStatusPagamento(availability.error) }
      }
    }

    const { data, error } = await supabase.rpc('registrar_status_pagamento', {
      p_pedido_id: pedidoId,
      p_novo_status: statusPagamento,
      p_source: 'manual',
      p_external_reference: null,
      p_reason: normalizedReason,
      p_idempotency_key: params.idempotencyKey ?? crypto.randomUUID(),
    }).single()

    if (error) {
      console.error('[actionAtualizarStatusPagamento] Erro ao atualizar pagamento:', error)
      return { success: false, ...mapearErroStatusPagamento(error) }
    }

    safeRevalidatePath('/atendimento')
    safeRevalidatePath('/atendimento/pedidos')

    // registrar_status_pagamento registra o evento canônico; o outbox entrega a notificação.

    return { success: true, data }
  } catch (error: any) {
    console.error('Erro na action actionAtualizarStatusPagamento:', error)
    return { success: false, error: error.message || 'ERRO_INTERNO' }
  }
}

export async function actionAprovarPagamentoExterno(params: {
  orderIds: string[]
  confirmedCents: number
  method: 'cash' | 'pix_external' | 'card_external' | 'bank_transfer_external'
  note: string
  idempotencyKey: string
}) {
  const check = await verificarPermissaoOperador()
  if (!check.authorized) return { success: false, error: check.error }
  const note = params.note.trim()
  if (!params.orderIds.length || note.length < 4 || note.length > 500 || !Number.isSafeInteger(params.confirmedCents) || params.confirmedCents <= 0) {
    return { success: false, error: 'DADOS_PAGAMENTO_EXTERNO_INVALIDOS' }
  }
  const { data, error } = await check.supabase.rpc('approve_manual_external_payment', {
    p_order_ids: params.orderIds,
    p_confirmed_cents: params.confirmedCents,
    p_method: params.method,
    p_note: note,
    p_idempotency_key: params.idempotencyKey,
  }).single()
  if (error) return { success: false, error: error.message }
  safeRevalidatePath('/atendimento/pedidos')
  return { success: true, data }
}

function mapearErroEmissaoComprovante(error: { code?: string; message?: string }) {
  if (error.message?.includes('RECEIPT_ISSUANCE_INELIGIVEL')) {
    return {
      error: 'PEDIDO_NAO_ELEGIVEL_PARA_COMPROVANTE',
      continuation: 'MARCAR_PEDIDO_COMO_ENTREGUE_OU_APROVAR_PAGAMENTO',
    }
  }
  if (error.message?.includes('PEDIDO_NAO_ENCONTRADO')) {
    return { error: 'PEDIDO_NAO_ENCONTRADO', continuation: 'SELECIONAR_PEDIDO_EXISTENTE' }
  }
  if (error.code === '42501') {
    return { error: 'ACESSO_NEGADO_PERMISSAO_INSUFICIENTE', continuation: 'SOLICITAR_ACESSO_OPERADOR' }
  }
  return { error: 'ERRO_EMISSAO_COMPROVANTE', continuation: 'TENTAR_NOVAMENTE' }
}

/**
 * Issues or reprints the authoritative immutable receipt snapshot. Callers
 * provide only references; the database re-reads and freezes domain data.
 */
export async function actionEmitirComprovanteVenda(params: {
  pedidoId: string
  idempotencyKey: string
}) {
  try {
    const check = await verificarPermissaoOperador()
    if (!check.authorized) {
      return { success: false, error: check.error }
    }

    const { data, error } = await check.supabase.rpc('emitir_comprovante_venda', {
      p_pedido_id: params.pedidoId,
      p_idempotency_key: params.idempotencyKey,
    }).single()

    if (error || !data) {
      return { success: false, ...mapearErroEmissaoComprovante(error || {}) }
    }

    safeRevalidatePath('/atendimento')
    safeRevalidatePath('/atendimento/pedidos')
    return { success: true, ...data }
  } catch (error: any) {
    console.error('Erro na action actionEmitirComprovanteVenda:', error)
    return { success: false, ...mapearErroEmissaoComprovante(error) }
  }
}

/**
 * Gera a cobrança instantânea via PIX no Mercado Pago (ou modo mock de desenvolvimento),
 * retornando a imagem do QR Code em Base64 e o código Copia e Cola EMV para o cliente pagar.
 */
export async function gerarCobrancaPixPedido(pedidoId: string) {
  try {
    const supabase = await createClient()

    // 1. Obter usuário autenticado
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return { success: false, error: 'ACESSO_NEGADO_NAO_AUTENTICADO' }
    }

    // 2. Buscar perfil do usuário para validar permissões
    const { data: perfil } = await supabase
      .from('perfis')
      .select('funcao, ativo')
      .eq('id', user.id)
      .maybeSingle()

    // 3. Buscar dados do pedido e cliente
    const { data: pedido, error: pedidoError } = await supabase
      .from('pedidos')
      .select(`
        id,
        status,
        status_pagamento,
        total_produtos_centavos,
        total_pedido_centavos,
        cliente_id,
        clientes:cliente_id (
          id,
          usuario_id,
          nome,
          telefone
        )
      `)
      .eq('id', pedidoId)
      .single()

    if (pedidoError || !pedido) {
      return { success: false, error: 'PEDIDO_NAO_ENCONTRADO' }
    }

    const funcoesAutorizadas = ['admin', 'supervisor', 'vendedor']
    const isOperador = perfil && perfil.ativo && funcoesAutorizadas.includes(perfil.funcao)
    const clienteDono = pedido.clientes as any
    const isDono = clienteDono && clienteDono.usuario_id === user.id

    if (!isOperador && !isDono) {
      return { success: false, error: 'ACESSO_NEGADO_PERMISSAO_INSUFICIENTE' }
    }

    const availability = await createAdminClient().rpc('assert_order_payment_available', {
      p_pedido_id: pedidoId,
    })
    if (availability.error) {
      return {
        success: false,
        error: availability.error.message?.includes('ORDER_PAYMENT_PROOF_ALREADY_PENDING')
          ? 'ORDER_PAYMENT_PROOF_ALREADY_PENDING'
          : availability.error.message,
      }
    }

    const valorCentavos = pedido.total_pedido_centavos || pedido.total_produtos_centavos
    const valorReais = Number((valorCentavos / 100).toFixed(2))

    // 4. Obter token de acesso do Mercado Pago
    const token = (await obterConfiguracaoSistema('MERCADO_PAGO_ACCESS_TOKEN')) || process.env.MERCADO_PAGO_ACCESS_TOKEN
    const isPlaceholder = !token || 
      token.includes('placeholder') || 
      token.includes('insert_here') || 
      token.includes('seu_access_token_mercado_pago_aqui') ||
      token.includes('your_access_token')

    if (isPlaceholder) {
      const mockPaymentId = `mock_pix_${pedidoId.slice(0, 8)}`
      const mockCopiaCola = `00020126580014br.gov.bcb.pix0136${pedidoId}520400005303986540${valorReais.toFixed(2)}5802BR5928CASA DE ASSADOS BRASA E SABOR6008CURITIBA62070503***6304MOCK`
      const mockQrCodeDataUrl = await QRCode.toDataURL(mockCopiaCola, { width: 320, margin: 1 })
      const mockQrCodeBase64 = mockQrCodeDataUrl.replace(/^data:image\/png;base64,/, '')

      const supabaseAdmin = createAdminClient()
      await supabaseAdmin
        .from('pedidos')
        .update({ mercado_pago_pagamento_id: mockPaymentId })
        .eq('id', pedidoId)

      return {
        success: true,
        pix: {
          qrCodeBase64: mockQrCodeBase64,
          qrCodeCopiaCola: mockCopiaCola,
          ticketUrl: `https://sandbox.mercadopago.com.br/payments/${mockPaymentId}/ticket`,
          paymentId: mockPaymentId,
          valorCentavos,
          expiraEmMinutos: 30,
        }
      }
    }

    const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://crmsofiamanager.duckdns.org'
    const notificationUrl = `${appUrl}/api/webhooks/mercadopago`
    const clienteNome = clienteDono?.nome || 'Cliente'
    const nomes = clienteNome.trim().split(' ')
    const firstName = nomes[0] || 'Cliente'
    const lastName = nomes.slice(1).join(' ') || 'Sofia'

    const isTestToken = token.startsWith('TEST-')
    const payerEmail = isTestToken
      ? 'test_user_payer@testuser.com'
      : `cliente_${pedidoId.slice(0, 8)}@crmsofiamanager.duckdns.org`

    const payload = {
      transaction_amount: valorReais,
      description: `Pedido #${pedidoId.slice(0, 8).toUpperCase()} - CRM Sofia Manager`,
      payment_method_id: 'pix',
      payer: {
        email: payerEmail,
        first_name: firstName,
        last_name: lastName,
      },
      notification_url: notificationUrl,
      external_reference: pedidoId,
    }

    const response = await fetch('https://api.mercadopago.com/v1/payments', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        'X-Idempotency-Key': `pix-create-${pedidoId}-${Date.now()}`
      },
      body: JSON.stringify(payload)
    })

    if (!response.ok) {
      const errorText = await response.text()
      console.error('[gerarCobrancaPixPedido] Erro ao criar pagamento PIX no Mercado Pago:', response.status, errorText)

      let isLiveCredsError = false
      try {
        const parsed = JSON.parse(errorText)
        if (
          response.status === 401 &&
          (parsed.message?.includes('Unauthorized use of live credentials') ||
            parsed.cause?.[0]?.description?.includes('Unauthorized use of live credentials'))
        ) {
          isLiveCredsError = true
        }
      } catch {
        // fallback
      }

      // Se a credencial for de teste/não homologada pelo BACEN, fornecer fallback de teste com QR Code funcional de simulação
      if (isLiveCredsError) {
        console.warn('[gerarCobrancaPixPedido] Usando modo de simulação PIX Sandbox devido a credenciais de teste não homologadas no BACEN.')
        const mockPaymentId = `mock_pix_${pedidoId.slice(0, 8)}`
        const mockCopiaCola = `00020126580014br.gov.bcb.pix0136${pedidoId}520400005303986540${valorReais.toFixed(2)}5802BR5928CASA DE ASSADOS BRASA E SABOR6008CURITIBA62070503***6304MOCK`
        const mockQrCodeDataUrl = await QRCode.toDataURL(mockCopiaCola, { width: 320, margin: 1 })
        const mockQrCodeBase64 = mockQrCodeDataUrl.replace(/^data:image\/png;base64,/, '')

        const supabaseAdmin = createAdminClient()
        await supabaseAdmin
          .from('pedidos')
          .update({ mercado_pago_pagamento_id: mockPaymentId })
          .eq('id', pedidoId)

        return {
          success: true,
          pix: {
            qrCodeBase64: mockQrCodeBase64,
            qrCodeCopiaCola: mockCopiaCola,
            ticketUrl: `https://sandbox.mercadopago.com.br/payments/${mockPaymentId}/ticket`,
            paymentId: mockPaymentId,
            valorCentavos,
            expiraEmMinutos: 30,
          }
        }
      }

      let friendlyError = 'Não foi possível gerar a cobrança PIX via Mercado Pago.'
      try {
        const parsed = JSON.parse(errorText)
        if (parsed.message) {
          friendlyError = `Mercado Pago: ${parsed.message}`
        }
      } catch {
        // fallback
      }

      return { success: false, error: friendlyError, details: errorText }
    }

    const responseData = await response.json()
    const txData = responseData.point_of_interaction?.transaction_data
    let qrCodeBase64 = txData?.qr_code_base64
    const qrCodeCopiaCola = txData?.qr_code
    const ticketUrl = txData?.ticket_url
    const paymentId = String(responseData.id)

    if (!qrCodeCopiaCola) {
      console.error('[gerarCobrancaPixPedido] Resposta de PIX sem QR code do Mercado Pago:', responseData)
      return { success: false, error: 'RESPOSTA_INVALIDA_PIX_MERCADO_PAGO' }
    }

    // Se o Mercado Pago não retornou base64 ou retornou vazio, gerar localmente a partir da chave copia e cola
    if (!qrCodeBase64) {
      const generatedDataUrl = await QRCode.toDataURL(qrCodeCopiaCola, { width: 320, margin: 1 })
      qrCodeBase64 = generatedDataUrl.replace(/^data:image\/png;base64,/, '')
    }

    // Salvar o ID do pagamento gerado no pedido
    const supabaseAdmin = createAdminClient()
    await supabaseAdmin
      .from('pedidos')
      .update({ mercado_pago_pagamento_id: paymentId })
      .eq('id', pedidoId)

    return {
      success: true,
      pix: {
        qrCodeBase64,
        qrCodeCopiaCola,
        ticketUrl,
        paymentId,
        valorCentavos,
        expiraEmMinutos: 30,
      }
    }
  } catch (error: any) {
    console.error('Erro na action gerarCobrancaPixPedido:', error)
    return { success: false, error: error.message || 'ERRO_INTERNO' }
  }
}

/**
 * Envia mensagem transacional multicanal com a cobrança PIX gerada para o cliente.
 */
export async function despacharCobrancaPixMulticanal(
  pedidoId: string,
  dadosPix: { qrCodeCopiaCola: string; valorCentavos: number; ticketUrl?: string }
) {
  try {
    const check = await verificarPermissaoOperador()
    if (!check.authorized) {
      return { success: false, error: check.error }
    }

    const supabaseAdmin = createAdminClient()
    const { data: pedido, error: pedidoError } = await supabaseAdmin
      .from('pedidos')
      .select(`
        id,
        conversa_id,
        cliente_id,
        clientes:cliente_id (
          id,
          nome,
          telefone,
          telegram_chat_id
        )
      `)
      .eq('id', pedidoId)
      .single()

    if (pedidoError || !pedido) {
      return { success: false, error: 'PEDIDO_NAO_ENCONTRADO' }
    }

    const cliente = pedido.clientes as any
    const nomeCliente = cliente?.nome || 'Cliente'
    const telefone = cliente?.telefone
    const telegramChatId = cliente?.telegram_chat_id
    const pedidoShort = pedidoId.slice(0, 8).toUpperCase()
    const valorFormatado = (dadosPix.valorCentavos / 100).toLocaleString('pt-BR', {
      style: 'currency',
      currency: 'BRL',
    })

    const textoMensagem = `Olá, *${nomeCliente}*! 🥩\n\nSeu pedido *#${pedidoShort}* na Casa de Assados Brasa & Sabor está pronto para pagamento!\n\n💰 *Valor Total:* ${valorFormatado}\n\n🔑 *Chave PIX (Copia e Cola):*\n\`\`\`\n${dadosPix.qrCodeCopiaCola}\n\`\`\`\n\n📲 *Como pagar:* Copie o código acima e cole no app do seu banco na opção "PIX Copia e Cola", ou acesse o seu Painel de Pedidos para escanear o QR Code.\n\nApós o pagamento, você pode anexar seu comprovante aqui mesmo na conversa!`

    const canaisNotificados: string[] = []
    let conversaId = pedido.conversa_id

    if (!conversaId && pedido.cliente_id) {
      const { data: conversa } = await supabaseAdmin
        .from('conversas')
        .select('id')
        .eq('cliente_id', pedido.cliente_id)
        .order('data_atualizacao', { ascending: false })
        .limit(1)
        .maybeSingle()

      conversaId = conversa?.id || null
    }

    if (conversaId) {
      await supabaseAdmin.from('mensagens').insert({
        conversa_id: conversaId,
        remetente: 'operador',
        conteudo: textoMensagem,
      })
      canaisNotificados.push('chat')

      if (telefone) {
        try {
          await enviarMensagemWhatsapp(conversaId, {
            texto: textoMensagem,
            remetente: 'operador',
          })
          canaisNotificados.push('whatsapp')
        } catch (wErr) {
          console.warn('[despacharCobrancaPixMulticanal] Falha ao enviar WhatsApp:', wErr)
        }
      }

      if (telegramChatId) {
        try {
          await enviarMensagemTelegram(conversaId, {
            texto: textoMensagem,
            remetente: 'operador',
          })
          canaisNotificados.push('telegram')
        } catch (tErr) {
          console.warn('[despacharCobrancaPixMulticanal] Falha ao enviar Telegram:', tErr)
        }
      }
    }

    return {
      success: true,
      canaisNotificados,
    }
  } catch (error: any) {
    console.error('Erro na action despacharCobrancaPixMulticanal:', error)
    return { success: false, error: error.message || 'ERRO_INTERNO' }
  }
}

export const enviarCobrancaPixAoCliente = despacharCobrancaPixMulticanal

/**
 * Authorizes a client-side proof upload without exposing order, customer, or
 * conversation details. The canonical submission action repeats this check to
 * close the interval between this preflight and storage admission.
 */
export async function preflightComprovantePagamentoCliente(pedidoId: string) {
  try {
    const supabase = await createClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return { success: false, error: 'ACESSO_NEGADO_NAO_AUTENTICADO' }
    }

    const { data: pedido, error: pedidoError } = await createAdminClient()
      .from('pedidos')
      .select(`
        cliente_id,
        conversa_id,
        status,
        status_pagamento,
        clientes:cliente_id (
          usuario_id
        )
      `)
      .eq('id', pedidoId)
      .maybeSingle()

    const clienteDono = pedido?.clientes as any
    const conversaId = pedido?.conversa_id
    const elegivel = pedido?.status_pagamento === 'pendente' && pedido?.status !== 'cancelado'
    if (pedidoError || !pedido || clienteDono?.usuario_id !== user.id || !elegivel || !conversaId) {
      return { success: false, error: 'COMPROVANTE_INDISPONIVEL' }
    }

    return { success: true }
  } catch (error: any) {
    console.error('Erro na action preflightComprovantePagamentoCliente:', error)
    return { success: false, error: 'COMPROVANTE_INDISPONIVEL' }
  }
}

/**
 * Registra o comprovante enviado pelo cliente (PDF/imagem ou anexo de storage) na tabela de comprovantes
 * e na conversa do pedido, notificando os atendentes e operadores no painel.
 */
export async function enviarComprovantePagamentoCliente(
  pedidoId: string,
  payload: {
    urlComprovante?: string
    nomeArquivo?: string
    tamanhoBytes?: number
    texto?: string
  }
) {
  try {
    const supabase = await createClient()

    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return { success: false, error: 'ACESSO_NEGADO_NAO_AUTENTICADO' }
    }

    const { data: pedido, error: pedidoError } = await supabase
      .from('pedidos')
      .select(`
        id,
        conversa_id,
        cliente_id,
        status,
        status_pagamento,
        clientes:cliente_id (
          id,
          usuario_id,
          nome
        )
      `)
      .eq('id', pedidoId)
      .single()

    if (!payload.urlComprovante) {
      return { success: false, error: 'COMPROVANTE_ARQUIVO_OBRIGATORIO' }
    }

    const clienteDono = pedido?.clientes as any
    const elegivel = pedido?.status_pagamento === 'pendente' && pedido?.status !== 'cancelado'
    const conversaId = pedido?.conversa_id

    // Re-read every authority predicate after the client-side preflight. This
    // remains the TOCTOU boundary for canonical admission and never infers a
    // newer customer conversation.
    if (pedidoError || !pedido || clienteDono?.usuario_id !== user.id || !elegivel || !conversaId) {
      return { success: false, error: 'COMPROVANTE_INDISPONIVEL' }
    }

    const supabaseAdmin = createAdminClient()

    if (!pedido.cliente_id) {
      return { success: false, error: 'COMPROVANTE_INDISPONIVEL' }
    }

    const { data: fileBlob, error: downloadError } = await supabaseAdmin.storage
      .from('chat-midias')
      .download(payload.urlComprovante)
    if (downloadError || !fileBlob) return { success: false, error: 'COMPROVANTE_ARQUIVO_INACESSIVEL' }

    const deliveryId = `web-${pedidoId}-${payload.urlComprovante}`
    const [apiKey, model] = await Promise.all([
      obterConfiguracaoSistema('OPENROUTER_API_KEY'),
      obterConfiguracaoSistema('OPENROUTER_MODEL'),
    ])
    const processed = await processCanonicalPaymentProof({
      channel: 'web',
      deliveryId,
      customerId: pedido.cliente_id,
      orderId: pedidoId,
      conversationId: conversaId,
      sender: user.id,
      bytes: new Uint8Array(await fileBlob.arrayBuffer()),
      mimeType: fileBlob.type,
      db: supabaseAdmin,
      storage: supabaseAdmin.storage.from('payment-proofs'),
      apiKey,
      model,
    })
    if (processed.status === 'disabled') return { success: false, error: 'COMPROVANTE_PIPELINE_DESATIVADO' }
    if (processed.status === 'rejected') return { success: false, error: processed.error }
    if (processed.status === 'retryable') return { success: false, error: processed.error }
    await supabaseAdmin.storage.from('chat-midias').remove([payload.urlComprovante])

    // The admitted chat projection is created only after human review. Until then,
    // the original PDF remains private in Comprovantes PIX and absent from both chats.
    if (conversaId && processed.status !== 'duplicate') {
      await supabaseAdmin
        .from('conversas')
        .update({
          status: 'aberta',
          ia_ativa: false,
          data_atualizacao: new Date().toISOString(),
        })
        .eq('id', conversaId)

      const proofId = (processed as any).proofId
      if (proofId) {
        await supabaseAdmin
          .from('mensagens')
          .insert({
            conversa_id: conversaId,
            remetente: 'cliente',
            conteudo: '📎 Comprovante de pagamento anexado pelo cliente',
            url_anexo: `/api/payment-proofs/${proofId}/preview`,
            payment_proof_id: proofId,
            data_criacao: new Date().toISOString(),
          })
      }
    }

    safeRevalidatePath('/atendimento')
    safeRevalidatePath('/atendimento/pedidos')
    safeRevalidatePath('/cliente/pedidos')
    safeRevalidatePath('/cliente/chat')

    return { success: true, status: processed.status }
  } catch (error: any) {
    console.error('Erro na action enviarComprovantePagamentoCliente:', error)
    return { success: false, error: error.message || 'ERRO_INTERNO' }
  }
}
