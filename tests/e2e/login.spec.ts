import { expect, test } from '@playwright/test'

test('public login page renders', async ({ page }) => {
  await page.goto('/login')

  await expect(page.getByText(/CRM Sofia.*Manager/i)).toBeVisible()
  // Aba Cliente (Padrão: Celular de Curitiba e Senha)
  await expect(page.getByRole('button', { name: /Sou Cliente/i })).toBeVisible()
  await expect(page.getByLabel(/Celular de Curitiba/i)).toBeVisible()
  await expect(page.getByLabel(/Senha/i)).toBeVisible()
  await expect(page.getByRole('button', { name: /Entrar na Conta/i })).toBeVisible()

  // Aba Operador / Equipe (E-mail Corporativo e Senha)
  await page.getByRole('button', { name: /Equipe \/ Operador/i }).click()
  await expect(page.getByLabel(/E-mail Corporativo/i)).toBeVisible()
  await expect(page.getByLabel(/Senha/i)).toBeVisible()
  await expect(page.getByRole('button', { name: /Entrar na Conta/i })).toBeVisible()
})
