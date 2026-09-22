# Especificação Formal: Épica 7 — Integração de Pedidos e Pagamentos com Mercado Pago (pedidos_pagamento)

**ID da Mudança:** `epica7-pedidos-pagamento`  
**Domínio:** `pedidos_pagamento`  
**Status:** `Pendente de Revisão`  

---

## 1. Descrição Executiva
Este documento especifica os requisitos funcionais, não-funcionais e regras de segurança para a integração de pagamentos do portal **Asados** com a API do Mercado Pago Checkout Pro (Sandbox). O fluxo compreende a geração de preferências de pagamento associadas a um pedido no banco de dados, o redirecionamento seguro do cliente para a tela de pagamento do Mercado Pago e a recepção de confirmações via webhook assíncrono (IPN/Notification).

---

## 2. Requisitos de Negócio e de Sistema (RFC 2119)

### 2.1. Configuração de Ambiente e Credenciais
*   **REQ-PAG-001**: O sistema MUST carregar a credencial de autenticação da API do Mercado Pago a partir da variável de ambiente `MERCADO_PAGO_ACCESS_TOKEN`.
*   **REQ-PAG-002**: O sistema SHOULD utilizar o ambiente Sandbox (teste) do Mercado Pago para todas as operações de homologação do Checkout Pro.

### 2.2. Ação de Criação de Preferência (`gerarPreferenciaPagamento`)
*   **REQ-PAG-003**: O sistema MUST expor uma ação ou endpoint do servidor `gerarPreferenciaPagamento(pedidoId: string)` que recebe o identificador do pedido.
*   **REQ-PAG-004**: O sistema MUST validar a existência do pedido na tabela `public.pedidos` antes de prosseguir com a requisição ao Mercado Pago.
*   **REQ-PAG-005**: Ao chamar a API de preferências do Mercado Pago, o sistema MUST enviar os seguintes dados estruturados:
    *   `items`: Lista contendo os itens do pedido (nome do produto, quantidade e preço unitário convertido para decimais de Real, ex: `preco_centavos / 100`) ou um item consolidado único que represente o total dos produtos do pedido.
    *   `shipments`: Taxa de entrega do pedido representada pela coluna `taxa_entrega_centavos`, convertida para decimais de Real, quando aplicável.
    *   `back_urls`: URLs de redirecionamento do cliente para os estados `success` (sucesso), `failure` (falha) e `pending` (pendente), baseadas na URL base do site.
    *   `external_reference`: O `pedidoId` do banco de dados do sistema, servindo como chave de conciliação no webhook.
    *   `notification_url`: A URL pública absoluta do webhook `/api/webhooks/mercadopago` do sistema.
*   **REQ-PAG-006**: Ao obter a resposta de sucesso da API do Mercado Pago, o sistema MUST persistir o ID de preferência retornado na coluna `mercado_pago_preferencia_id` da tabela `public.pedidos`.
*   **REQ-PAG-007**: A ação MUST retornar o link de pagamento Checkout Pro (`init_point` ou `sandbox_init_point` no ambiente de teste) para redirecionamento do cliente.

### 2.3. Webhook de Notificações do Mercado Pago
*   **REQ-PAG-008**: O sistema MUST disponibilizar um endpoint público do tipo POST no caminho `/api/webhooks/mercadopago`.
*   **REQ-PAG-009**: O webhook MUST aceitar cargas de notificação contendo os parâmetros `topic` (ou `type`) com os valores `"payment"` ou `"merchant_order"`, juntamente com o ID do recurso (`resource` ou `data.id`).
*   **REQ-PAG-010**: O webhook MUST responder imediatamente com status HTTP `200 OK` (ou `201 Created`) logo após o recebimento básico do payload de notificação, garantindo que o Mercado Pago não envie retentativas devido a timeouts do processamento interno da transação.
*   **REQ-PAG-011**: O processamento e fetching dos detalhes da transação MUST ser feito de forma assíncrona ou não-bloqueante após o retorno imediato da resposta HTTP `200 OK`.
*   **REQ-PAG-012**: O sistema MUST consultar a API oficial do Mercado Pago utilizando a credencial `MERCADO_PAGO_ACCESS_TOKEN` para obter os detalhes e o status real da transação a partir do ID do recurso recebido.
*   **REQ-PAG-013**: Se o status do pagamento obtido for aprovado (`approved`):
    *   O sistema MUST atualizar a coluna `status_pagamento` da tabela `public.pedidos` para `'aprovado'`.
    *   O sistema MUST NOT atualizar a coluna `status` da tabela `public.pedidos` como efeito colateral da aprovação do pagamento.
*   **REQ-PAG-014**: Se o status do pagamento obtido for rejeitado (`rejected` ou `cancelled`):
    *   O sistema MUST atualizar a coluna `status_pagamento` da tabela `public.pedidos` para `'rejeitado'`.

### 2.5. Segurança e Row Level Security (RLS)
*   **REQ-PAG-017**: O endpoint de webhook do Mercado Pago `/api/webhooks/mercadopago` MUST processar as consultas e alterações no banco de dados utilizando um cliente de bypass seguro (Supabase Service Role ou Admin client) para permitir a escrita de tabelas sem exigir uma sessão de usuário ativa (uma vez que a chamada vem de forma anônima e sem cookies da aplicação).
*   **REQ-PAG-018**: As políticas RLS da tabela `public.pedidos` MUST garantir que os clientes comuns (`funcao = 'cliente'`) apenas leiam as suas próprias informações de pedido, impedindo que tenham acesso de leitura ao status de pagamentos de outros usuários.
*   **REQ-PAG-019**: Clientes comuns SHALL NOT possuir permissão de escrita (INSERT/UPDATE/DELETE) nas colunas de status do pedido (`status`), status de pagamento (`status_pagamento`) ou identificadores de integração (`mercado_pago_preferencia_id`).

---

## 3. Cenários de Aceitação (Dado / Quando / Então)

### 3.1. Geração de Preferência de Pagamento

#### Cenário 1: Geração com sucesso de link de pagamento para pedido válido
*   **Dado** que existe um pedido com ID `"9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d"` pertencente ao cliente autenticado, com `status_pagamento` igual a `'pendente'`,
*   **E** a variável de ambiente `MERCADO_PAGO_ACCESS_TOKEN` está configurada corretamente com uma chave válida,
*   **Quando** o cliente ou operador invoca a ação `gerarPreferenciaPagamento("9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d")`,
*   **Então** o sistema faz uma requisição HTTP POST para a API do Mercado Pago contendo os itens do pedido e a taxa de entrega convertidos para decimais,
*   **E** a API do Mercado Pago retorna um ID de preferência (ex: `"pref_12345678"`) e um ponto de início (ex: `"https://www.mercadopago.com.br/checkout/v1/redirect?pref_id=pref_12345678"`),
*   **E** o sistema salva o ID `"pref_12345678"` na coluna `mercado_pago_preferencia_id` do pedido,
*   **E** retorna a URL de redirecionamento para o usuário.

#### Cenário 2: Erro ao gerar preferência para pedido inexistente
*   **Dado** que não existe nenhum pedido com ID `"00000000-0000-0000-0000-000000000000"`,
*   **Quando** é solicitada a ação `gerarPreferenciaPagamento("00000000-0000-0000-0000-000000000000")`,
*   **Então** o sistema deve lançar um erro ou retornar uma resposta de falha indicando "Pedido não encontrado",
*   **E** nenhuma requisição à API do Mercado Pago deve ser efetuada.

---

### 3.2. Processamento do Webhook de Notificações

#### Cenário 1: Recebimento de notificação de pagamento aprovado
*   **Dado** que existe um pedido com ID `"9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d"` com `status_pagamento` igual a `'pendente'`,
*   **Quando** o endpoint `/api/webhooks/mercadopago` recebe uma requisição POST com o payload contendo `type` = `"payment"` e `data.id` = `"payment_9999"`,
*   **Então** o webhook responde imediatamente com status HTTP `200 OK`,
*   **E** de forma assíncrona, consulta a API do Mercado Pago com o ID `"payment_9999"` obtendo o status `"approved"`,
*   **E** atualiza no banco de dados apenas `status_pagamento = 'aprovado'`, preservando o `status` independente do pedido.

#### Cenário 3: Recebimento de notificação de pagamento rejeitado
*   **Dado** que existe um pedido com ID `"9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d"` com `status_pagamento` igual a `'pendente'`,
*   **Quando** o endpoint `/api/webhooks/mercadopago` recebe uma requisição POST indicando um pagamento com status `"rejected"`,
*   **Então** o webhook responde imediatamente com status HTTP `200 OK`,
*   **E** atualiza o banco de dados definindo a coluna `status_pagamento` do pedido como `'rejeitado'`,
*   **E** o status do pedido permanece como `'novo'`.

---

### 3.3. Segurança e Regras de Acesso

#### Cenário 1: Cliente visualiza dados de pagamento de seu próprio pedido
*   **Dado** que o usuário está autenticado no portal com o perfil vinculado ao `cliente_id` `"client_abc"`,
*   **Quando** ele solicita a leitura do pedido `"pedido_abc"` (que possui `cliente_id = 'client_abc'`),
*   **Então** a política RLS do Supabase permite o acesso completo de leitura ao registro do pedido, possibilitando a visualização de `status_pagamento` e `mercado_pago_preferencia_id`.

#### Cenário 2: Cliente bloqueado ao tentar ler dados de pagamento de pedido de outro cliente
*   **Dado** que o usuário está autenticado no portal com o perfil vinculado ao `cliente_id` `"client_abc"`,
*   **Quando** ele tenta acessar os dados do pedido `"pedido_xyz"` (que possui `cliente_id = 'client_xyz'`),
*   **Then** a política RLS do Supabase bloqueia a consulta, retornando uma resposta vazia ou erro de acesso não autorizado, impedindo a exposição do status e chaves de pagamento de terceiros.
