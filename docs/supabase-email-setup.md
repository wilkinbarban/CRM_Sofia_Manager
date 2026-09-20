# Runbook: Configuração de E-mail e Autenticação no Supabase

Este guia descreve os passos necessários para configurar o redirecionamento de autenticação e o template de e-mail de confirmação no painel (Dashboard) do Supabase para a **Casa de Asados**.

---

## 1. Configuração de URLs de Redirecionamento (URL Configuration)

Para que os fluxos de confirmação de e-mail e recuperação de senha redirecionem corretamente o usuário de volta à aplicação:

1. Acesse o **[Painel do Supabase](https://supabase.com/dashboard)**.
2. Selecione o projeto correspondente à **Casa de Asados**.
3. No menu lateral esquerdo, vá para **Authentication** -> **URL Configuration**.
4. Configure os seguintes campos:
   * **Site URL**:
     * Defina como a URL base oficial de produção:
       ```
       https://crmsofiamanager.duckdns.org
       ```
   * **Redirect URLs**:
     * Adicione a URL com suporte a subcaminhos curinga para permitir redirecionamentos dinâmicos seguros após o login/confirmação:
       ```
       https://crmsofiamanager.duckdns.org/**
       ```
5. Clique em **Save** no canto inferior ou superior da seção.

---

## 2. Configuração do Template de E-mail de Confirmação (Confirm Signup)

Para personalizar o e-mail de confirmação enviado aos novos clientes da churrascaria com o design oficial da marca:

1. No menu lateral do **Supabase Dashboard**, vá em **Authentication** -> **Email Templates**.
2. Sob a lista de templates, selecione a aba **Confirm signup** (Confirmação de cadastro).
3. Configure os seguintes campos:
   * **Subject (Assunto)**:
     ```
     Confirme seu e-mail - Asados Sofía
     ```
   * **Content (Conteúdo HTML)**:
     * Copie o conteúdo completo do arquivo localizado em `docs/templates/email-confirmacao.html` e cole-o no campo de texto do editor.
     * Certifique-se de que as variáveis obrigatórias do Supabase estejam presentes e sem alterações de sintaxe:
       * `{{ .Email }}`: Exibe o e-mail do usuário cadastrado.
       * `{{ .ConfirmationURL }}`: Link gerado dinamicamente para confirmar a conta.
4. Clique em **Save** para salvar as alterações do template.

---

## 3. Validação do Fluxo de E-mail

Para testar se o fluxo está operando corretamente:
1. Registre um novo usuário através da tela de cadastro (`/cadastro` ou `/login`).
2. Verifique se o e-mail recebido na caixa de entrada do usuário de teste segue a formatação oficial.
3. Clique no botão de confirmação e certifique-se de que ele redireciona o usuário com sucesso para a rota `https://crmsofiamanager.duckdns.org/verificar-email?sucesso=true`.
