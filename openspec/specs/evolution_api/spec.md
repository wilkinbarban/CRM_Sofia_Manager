# Especificação de Requisitos: Integração da Evolution API (evolution_api)

**ID da Mudança:** `epica9-melhorias-integracao`  
**Domínio:** `evolution_api`  
**Status:** `Aprovado`  

---

## 1. Descrição Executiva

Este documento especifica os requisitos técnicos e funcionais para a integração da Evolution API como um provedor alternativo de WhatsApp ao lado da API oficial da Meta Cloud. Inclui o serviço Docker Compose correspondente, a camada de abstração de provedor para mensagens de saída, o gerenciador de webhook dedicado para mensagens de entrada, e o roteamento via proxy reverso Nginx. Ambos os provedores coexistem no sistema, e o provedor ativo é selecionado dinamicamente por meio da chave de configuração `WHATSAPP_PROVIDER`.

---

## 2. Serviço Docker Compose

### 2.1 Definição do Serviço
*   **REQ-EVO-001**: Um novo serviço `evolution-api` MUST ser adicionado ao arquivo `docker-compose.yml` compartilhando a rede interna com o serviço web.
    *   Imagem: `atendai/evolution-api:v2.2.3` (versão fixada, nunca `latest`).
    *   Nome do container: `evolution-api`
    *   Mapeamento de portas: `8080:8080`
    *   Volume persistente: `evolution_store:/evolution/store`
*   **REQ-EVO-002**: O serviço `evolution-api` MUST ser configurado com as variáveis de ambiente necessárias para autenticação e escuta, usando a chave `EVOLUTION_API_KEY` do arquivo `.env` para a variável `AUTHENTICATION_API_KEY`, e `https://crmsofiamanager.duckdns.org/evolution` para a variável `SERVER_URL`.
*   **REQ-EVO-003**: Um volume nomeado `evolution_store` MUST ser declarado no bloco `volumes:` do Docker Compose para persistência de sessões e dados.

---

## 3. Proxy Reverso Nginx

### 3.1 Bloco de Localização (Location)
*   **REQ-EVO-004**: Um novo bloco `location /evolution/` MUST ser inserido no arquivo de configuração do Nginx (`nginx.conf`) no bloco do servidor HTTPS.
*   **REQ-EVO-005**: O bloco do Nginx MUST reescrever a requisição retirando o prefixo `/evolution/` antes de encaminhá-la para `http://127.0.0.1:8080/` e MUST dar suporte total a WebSockets (`Upgrade` e `Connection`).

---

## 4. Camada de Abstração do Provedor

### 4.1 Interface Unificada
*   **REQ-EVO-006**: O sistema MUST possuir uma interface comum `ProvedorWhatsApp` em `src/lib/whatsapp/provider.ts` com o seguinte contrato:
    *   `enviarMensagemTexto(telefone: string, texto: string): Promise<ResultadoEnvio>`
    *   `enviarMensagemMidia(telefone: string, tipo: TipoMidia, urlMidia: string): Promise<ResultadoEnvio>`
    *   `enviarTemplate(telefone: string, nomeTemplate: string, parametros?: string[]): Promise<ResultadoEnvio>`

### 4.2 Fábrica de Provedores (Factory)
*   **REQ-EVO-007**: A fábrica `obterProvedorAtivo()` MUST ler dinamicamente a chave `WHATSAPP_PROVIDER` do banco de dados (tabela `configuracoes_sistema`). Se o valor for `'meta'` ou estiver ausente, retorna o provedor da Meta. Se o valor for `'evolution'`, retorna o provedor da Evolution API.
*   **REQ-EVO-008**: A função utilitária `enviarMensagemWhatsapp()` em `send.ts` MUST ser refatorada para consumir a fábrica interna de provedores, garantindo compatibilidade reversa com todos os chamadores antigos.

### 4.3 Integração com a Evolution API
*   **REQ-EVO-009**: O provedor Evolution API (`src/lib/whatsapp/evolution.ts`) MUST realizar requisições POST para a instância configurada usando o cabeçalho `apikey`:
    *   Texto: `${EVOLUTION_API_URL}/message/sendText/${EVOLUTION_INSTANCE_NAME}`
    *   Mídia: `${EVOLUTION_API_URL}/message/sendMedia/${EVOLUTION_INSTANCE_NAME}`
*   **REQ-EVO-010**: O provedor Evolution API MUST suportar o modo MOCK. Se as credenciais forem temporárias ou inválidas, ele deve gerar um ID de mensagem simulado e registrar logs de aviso.

---

## 5. Webhook da Evolution API

### 5.1 Rota e Autenticação
*   **REQ-EVO-011**: Um novo endpoint de webhook de mensagens recebidas MUST ser disponibilizado sob a rota `/api/webhooks/evolution/route.ts`.
*   **REQ-EVO-012**: O webhook MUST autenticar as requisições checando se o cabeçalho `apikey` é igual ao valor configurado de `EVOLUTION_API_KEY` (obtido via `obterConfiguracaoSistema`). Se não for igual, retorna HTTP 401.

### 5.2 Processamento de Payload e Mídia
*   **REQ-EVO-013**: O webhook MUST interceptar o evento `messages.upsert`, extrair o número de telefone (limpando o sufixo `@s.whatsapp.net`), ID de mensagem (`whatsapp_mensagem_id`), texto e anexos de mídia.
*   **REQ-EVO-014**: O webhook MUST rotear as informações para a mesma esteira unificada de processamento usada pela Meta: identificar/criar cliente (enforced Curitiba DDD 41), associar conversa, inserir registro no banco e disparar pipeline de resposta da IA.
*   **REQ-EVO-015**: Para mensagens de mídia recebidas, o webhook MUST baixar o conteúdo em base64 chamando a API do Evolution e salvá-lo no bucket de armazenamento público `chat-midias` do Supabase.

---

## 6. Correção de Bug Pré-existente

*   **REQ-EVO-016**: No webhook original da Meta (`src/app/api/webhooks/whatsapp/route.ts`), a linha que realiza o download de mídia MUST ser alterada para utilizar o método dinâmico `obterConfiguracaoSistema('WHATSAPP_ACCESS_TOKEN')` em vez de `process.env.WHATSAPP_ACCESS_TOKEN`, eliminando a necessidade de reinicializar o servidor ao alterar o token via dashboard.

---

## 7. Cenários de Aceitação (Gherkin - Given/When/Then)

### Cenário 1: Roteamento de mensagem via provedor ativo
*   **Given** que a chave `WHATSAPP_PROVIDER` está configurada como `"evolution"`,
*   **When** o sistema chama o método centralizado de envio de mensagem,
*   **Then** a mensagem é enviada utilizando o endpoint correspondente da Evolution API,
*   **And** a integração com a API da Meta Cloud não é acionada.

### Cenário 2: Redirecionamento padrão para a Meta
*   **Given** que a chave `WHATSAPP_PROVIDER` não existe ou está vazia,
*   **When** o sistema envia uma mensagem,
*   **Then** o provedor padrão da Meta Cloud API é resolvido e utilizado para envio.

### Cenário 3: Validação e rejeição no webhook da Evolution
*   **Given** que o endpoint do webhook da Evolution recebe uma requisição POST,
*   **When** o cabeçalho `apikey` está ausente ou difere do cadastrado no sistema,
*   **Then** o webhook rejeita imediatamente a requisição com HTTP 401 e interrompe o processamento.

---

## 8. Limitações Conhecidas

*   A Evolution API (baseada em QR Code de celular comum) não oferece suporte nativo para templates oficiais aprovados pela Meta. O envio de templates através dela será emulado via mensagens de texto simples.
*   A alternância de provedores em tempo de execução pode gerar lacunas na recepção de respostas de webhooks em andamento.

## Requirements added by `humanized-multichannel-sofia-responses`

### Requirement: Evolution durable batch adoption and composing pace

When the default-closed Evolution adoption control is enabled, eligible non-duplicate WhatsApp/Evolution inbound messages MUST enter the shared durable Sofia batching contract after existing canonical intake, persistence, and policy gates. Evolution MUST NOT produce a direct per-message Sofia response through this adoption path.

After durable response-delivery authority is acquired, Evolution MUST use its embedded composing and delay capability. Its composing state MUST remain active throughout generation and only the remaining portion of the shared 2–6 second response-length-derived minimum. The Evolution send MUST remain a single fenced external response attempt.

#### Scenario: Evolution joins the shared batch

- GIVEN Evolution adoption is enabled and an eligible non-duplicate inbound message is accepted
- WHEN canonical intake and persistence finish
- THEN the message MUST join the conversation's durable pending Sofia batch
- AND the webhook MUST NOT generate a direct per-message Sofia response

#### Scenario: Evolution composing covers only the required pace

- GIVEN a durable Evolution response has final delivery authority
- AND generation completes before its computed 2–6 second minimum
- WHEN the final message is sent
- THEN Evolution MUST use embedded composing for generation and the remaining delay
- AND it MUST send only one fenced final response attempt
