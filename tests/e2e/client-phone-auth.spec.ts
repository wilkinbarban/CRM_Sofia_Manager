import { test, expect } from '@playwright/test'

test.describe('E2E: Client Phone-First Authentication Flow', () => {
  test('Cadastro page renders Phone-First form without email and transitions to OTP verification', async ({ page }) => {
    await page.route('**/api/client-auth/signup', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          challengeId: 'test-challenge-123',
          destination: '5541999998888',
          expiresAt: new Date(Date.now() + 600000).toISOString()
        })
      })
    })

    await page.goto('/cadastro')

    // 1. Verify header & elements
    await expect(page.getByText('CRM Sofia Manager')).toBeVisible()
    await expect(page.getByText(/Crie sua conta em poucos segundos com seu celular de Curitiba/i)).toBeVisible()

    // 2. Verify inputs: Nome, Celular, Senha (no Email field)
    await expect(page.getByLabel(/Nome Completo/i)).toBeVisible()
    await expect(page.getByLabel(/Celular de Curitiba/i)).toBeVisible()
    await expect(page.getByLabel(/Senha de Acesso/i)).toBeVisible()
    await expect(page.locator('input[type="email"]')).toHaveCount(0)

    // 3. Fill form
    await page.getByLabel(/Nome Completo/i).fill('Cliente Teste Playwright')
    await page.getByLabel(/Celular de Curitiba/i).fill('41999998888')
    await page.getByLabel(/Senha de Acesso/i).fill('SenhaForte2026!')

    // 4. Submit registration
    await page.getByRole('button', { name: /Continuar para Verificação/i }).click()

    // 5. Verify transition to OTP verification card
    await expect(page.getByRole('heading', { name: /Confirme seu Telefone/i })).toBeVisible({ timeout: 10000 })
    await expect(page.getByText(/Enviamos um código de 6 dígitos/i)).toBeVisible()
    await expect(page.locator('input#codigoOtp')).toBeVisible()
    await expect(page.getByRole('button', { name: /Confirmar e Entrar/i })).toBeVisible()
  })

  test('Login page renders Segregated Client & Operator Tabs', async ({ page }) => {
    await page.goto('/login')

    // 1. Client tab is active by default
    await expect(page.getByRole('button', { name: /Sou Cliente/i })).toBeVisible()
    await expect(page.getByRole('button', { name: /Equipe \/ Operador/i })).toBeVisible()
    await expect(page.getByLabel(/Celular de Curitiba/i)).toBeVisible()
    await expect(page.getByLabel(/Senha/i)).toBeVisible()

    // 2. Switch to Operator tab
    await page.getByRole('button', { name: /Equipe \/ Operador/i }).click()
    await expect(page.getByLabel(/E-mail Corporativo/i)).toBeVisible()
    await expect(page.getByLabel(/Celular de Curitiba/i)).toHaveCount(0)

    // 3. Switch back to Client tab
    await page.getByRole('button', { name: /Sou Cliente/i }).click()
    await expect(page.getByLabel(/Celular de Curitiba/i)).toBeVisible()

    // 4. Open Password Recovery modal
    await page.getByRole('button', { name: /Esqueceu a senha\?/i }).click()
    await expect(page.getByText(/Recuperação de Senha/i)).toBeVisible()
    await expect(page.getByLabel(/Celular \(DDD 41\)/i)).toBeVisible()
  })

  test('Admin logs in with email and reaches /atendimento/admin dashboard', async ({ page }) => {
    await page.goto('/login')
    await page.getByRole('button', { name: /Equipe \/ Operador/i }).click()

    await page.getByLabel(/E-mail Corporativo/i).fill('admin@crmsofiamanager.com.br')
    await page.getByLabel(/Senha/i).fill('SenhaAdmin123')
    await page.getByRole('button', { name: /Entrar na Conta/i }).click()

    await page.waitForURL('**/atendimento/admin', { timeout: 10000 })
    expect(page.url()).toContain('/atendimento/admin')
  })

  test('Supervisor logs in with email and reaches /atendimento dashboard', async ({ page }) => {
    await page.goto('/login')
    await page.getByRole('button', { name: /Equipe \/ Operador/i }).click()

    await page.getByLabel(/E-mail Corporativo/i).fill('supervisor@crmsofiamanager.com.br')
    await page.getByLabel(/Senha/i).fill('SenhaSupervisor123')
    await page.getByRole('button', { name: /Entrar na Conta/i }).click()

    await page.waitForURL('**/atendimento', { timeout: 10000 })
    expect(page.url()).toContain('/atendimento')
  })

  test('Vendedor logs in with email and reaches /atendimento dashboard', async ({ page }) => {
    await page.goto('/login')
    await page.getByRole('button', { name: /Equipe \/ Operador/i }).click()

    await page.getByLabel(/E-mail Corporativo/i).fill('vendedor@crmsofiamanager.com.br')
    await page.getByLabel(/Senha/i).fill('SenhaVendedor123')
    await page.getByRole('button', { name: /Entrar na Conta/i }).click()

    await page.waitForURL('**/atendimento', { timeout: 10000 })
    expect(page.url()).toContain('/atendimento')
  })

  test('Cliente logs in with phone and password and reaches /cliente/chat', async ({ page }) => {
    await page.goto('/login')
    await page.getByRole('button', { name: /Sou Cliente/i }).click()

    await page.getByLabel(/Celular de Curitiba/i).fill('41999998888')
    await page.getByLabel(/Senha/i).fill('SenhaCliente123')
    await page.getByRole('button', { name: /Entrar na Conta/i }).click()

    await page.waitForURL('**/cliente/chat', { timeout: 10000 })
    expect(page.url()).toContain('/cliente/chat')
  })
})
