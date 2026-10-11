import { describe, expect, it } from 'vitest'

// Runner opt-in is a safety check, not proof of authentication.
if (
  process.env.LOCAL_SUPABASE_SERVICE_RUNNER !== '1' ||
  process.env.NEXT_PUBLIC_SUPABASE_URL !== 'http://127.0.0.1:55321' ||
  process.env.SUPABASE_INTERNAL_URL !== 'http://127.0.0.1:55321' ||
  !process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
  !process.env.SUPABASE_SERVICE_ROLE_KEY
) {
  throw new Error('Use npm run test:unit:supabase with the disposable local stack.')
}

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY

const {
  obterOuCriarCarrinhoAtivo,
  adicionarItemAoCarrinho,
  atualizarQuantidadeItemCarrinho,
  removerItemDoCarrinho,
  limparCarrinho,
  converterCarrinhoEmPedido,
} = await import('@/lib/carrinho/service')
const { createClient } = await import('@supabase/supabase-js')

describe('Web Client & Operator Unified Cart Management Flow', () => {
  const supabase = createClient(supabaseUrl, supabaseServiceKey)

  it('allows client to assemble a custom order, recalculate totals and isolate from other clients', async () => {
    // 1. Obter produtos reais do banco de dados
    const { data: produtos } = await supabase
      .from('produtos')
      .select('id, nome, preco_centavos')
      .eq('ativo', true)
      .limit(2)

    expect(produtos).toBeDefined()
    expect(produtos!.length).toBeGreaterThanOrEqual(2)

    const prod1 = produtos![0]
    const prod2 = produtos![1]

    // Cliente A e Cliente B
    const clienteAId = 'c3c3c3c3-c3c3-c3c3-c3c3-c3c3c3c3c3c3'
    const clienteBId = 'd4d4d4d4-d4d4-d4d4-d4d4-d4d4d4d4d4d4'

    // Limpar carrinhos residuais
    await limparCarrinho({ clienteId: clienteAId })
    await limparCarrinho({ clienteId: clienteBId })

    // 2. Cliente A adiciona Produto 1
    const add1 = await adicionarItemAoCarrinho({
      clienteId: clienteAId,
      produtoId: prod1.id,
      quantidade: 1,
    })
    expect(add1.success).toBe(true)
    expect(add1.carrinho?.total_centavos).toBe(prod1.preco_centavos)

    // 3. Cliente A adiciona Produto 2
    const add2 = await adicionarItemAoCarrinho({
      clienteId: clienteAId,
      produtoId: prod2.id,
      quantidade: 2,
    })
    expect(add2.success).toBe(true)
    expect(add2.carrinho?.itens_carrinho?.length).toBe(2)
    const expectedTotalA = prod1.preco_centavos + prod2.preco_centavos * 2
    expect(add2.carrinho?.total_centavos).toBe(expectedTotalA)

    // 4. Cliente B adiciona apenas Produto 2 com quantidade 1
    const addB = await adicionarItemAoCarrinho({
      clienteId: clienteBId,
      produtoId: prod2.id,
      quantidade: 1,
    })
    expect(addB.success).toBe(true)
    expect(addB.carrinho?.total_centavos).toBe(prod2.preco_centavos)

    // 5. Garantir Isolamento Estrito: O carrinho do Cliente A NÃO foi afetado pelo Cliente B
    const cartA = await obterOuCriarCarrinhoAtivo(clienteAId)
    expect(cartA.success).toBe(true)
    expect(cartA.carrinho?.total_centavos).toBe(expectedTotalA)
    expect(cartA.carrinho?.itens_carrinho?.length).toBe(2)

    // 6. Atualização de quantidade no carrinho do Cliente A (diminui prod2 de 2 para 1)
    const updA = await atualizarQuantidadeItemCarrinho({
      clienteId: clienteAId,
      produtoId: prod2.id,
      quantidade: 1,
    })
    expect(updA.success).toBe(true)
    expect(updA.carrinho?.total_centavos).toBe(prod1.preco_centavos + prod2.preco_centavos)

    // 7. Remoção de item do carrinho
    const remA = await removerItemDoCarrinho({
      clienteId: clienteAId,
      produtoId: prod1.id,
    })
    expect(remA.success).toBe(true)
    expect(remA.carrinho?.itens_carrinho?.length).toBe(1)
    expect(remA.carrinho?.total_centavos).toBe(prod2.preco_centavos)
  })

  it('allows operator (admin, supervisor, vendedor) to convert client cart into confirmed order with pickup window', async () => {
    const clienteId = 'c3c3c3c3-c3c3-c3c3-c3c3-c3c3c3c3c3c3'

    const { data: prod, error: produtoError } = await supabase
      .from('produtos')
      .select('id, nome, preco_centavos, ativo, controlar_estoque, quantidade_estoque')
      .eq('ativo', true)
      .or('controlar_estoque.is.false,quantidade_estoque.gte.1')
      .order('id')
      .limit(1)
      .single()

    expect(produtoError).toBeNull()
    expect(prod).toBeDefined()
    expect(prod?.ativo).toBe(true)
    expect(prod?.controlar_estoque === false || (prod?.quantidade_estoque ?? 0) >= 1).toBe(true)

    // Limpar e criar novo item
    await limparCarrinho({ clienteId })
    const addRes = await adicionarItemAoCarrinho({
      clienteId,
      produtoId: prod!.id,
      quantidade: 1,
    })
    expect(addRes.success, addRes.error).toBe(true)
    const carrinhoId = addRes.carrinho!.id

    // Operador converte o carrinho em pedido oficial
    const convRes = await converterCarrinhoEmPedido({
      carrinhoId,
      meioPagamento: 'pix',
      horarioRetirada: '12:30',
    })

    expect(convRes.success, convRes.error).toBe(true)
    expect(convRes.pedidoId).toBeDefined()

    // Verificar se o pedido foi persistido no banco
    const { data: pedido } = await supabase
      .from('pedidos')
      .select('*')
      .eq('id', convRes.pedidoId!)
      .single()

    expect(pedido).toBeDefined()
    expect(pedido?.cliente_id).toBe(clienteId)
    expect(pedido?.status).toBe('confirmado')
    expect(pedido?.meio_pagamento).toBe('pix')

    // Verificar se um novo carrinho limpo é gerado para o cliente
    const novoCarrinho = await obterOuCriarCarrinhoAtivo(clienteId)
    expect(novoCarrinho.success).toBe(true)
    expect(novoCarrinho.carrinho?.id).not.toBe(carrinhoId)
    expect(novoCarrinho.carrinho?.itens_carrinho?.length || 0).toBe(0)
  })
})
