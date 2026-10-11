import { fileURLToPath } from 'node:url'
import { loadConfigFromFile } from 'vite'
import { defineConfig } from 'vitest/config'

const loaded = await loadConfigFromFile(
  { command: 'serve', mode: 'test' },
  fileURLToPath(new URL('./vitest.config.mts', import.meta.url)),
)
if (!loaded) throw new Error('Base Vitest configuration is missing.')
const baseConfig = loaded.config

export default defineConfig({
  ...baseConfig,
  test: {
    ...baseConfig.test,
    include: [
      'tests/unit/roles-authentication-e2e.test.ts',
      'tests/unit/web-client-operator-cart-flow.test.ts',
    ],
    exclude: [],
  },
})
