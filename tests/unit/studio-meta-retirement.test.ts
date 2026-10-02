import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import yaml from 'js-yaml'

const root = process.cwd()
const read = (...parts: string[]) => readFileSync(join(root, ...parts), 'utf8')

interface ComposeService {
  container_name?: string
  image?: string
  depends_on?: Record<string, { condition?: string }> | string[]
  ports?: string[]
  networks?: {
    default?: {
      aliases?: string[]
    }
  }
  [key: string]: unknown
}

interface ComposeDocument {
  name?: string
  services: Record<string, ComposeService>
  [key: string]: unknown
}

function parseCompose(content: string): ComposeDocument {
  return yaml.load(content) as ComposeDocument
}

function assertStudioMetaServicesAbsent(doc: ComposeDocument) {
  expect(doc.services).toBeDefined()
  expect(doc.services).not.toHaveProperty('studio')
  expect(doc.services).not.toHaveProperty('meta')
}

function assertNoStudioDependency(serviceName: string, service: ComposeService | undefined) {
  expect(service, `Expected service ${serviceName} to be defined`).toBeDefined()
  const dependsOn = service?.depends_on
  if (!dependsOn) {
    return
  }
  if (Array.isArray(dependsOn)) {
    expect(dependsOn, `${serviceName} depends_on array must not contain studio`).not.toContain('studio')
    expect(dependsOn, `${serviceName} depends_on array must not contain meta`).not.toContain('meta')
  } else if (typeof dependsOn === 'object' && dependsOn !== null) {
    expect(dependsOn, `${serviceName} depends_on must not reference studio`).not.toHaveProperty('studio')
    expect(dependsOn, `${serviceName} depends_on must not reference meta`).not.toHaveProperty('meta')
  }
}

describe('Studio and postgres-meta retirement', () => {
  describe('Docker Compose base stack', () => {
    it('completely removes studio and meta service definitions and container references', () => {
      const compose = read('ops', 'supabase', 'docker-compose.yml')
      const doc = parseCompose(compose)

      // Service-scoped structured YAML assertion
      assertStudioMetaServicesAbsent(doc)

      // Raw token / container / image / env reference checks
      expect(compose).not.toMatch(/^  studio:\s*$/m)
      expect(compose).not.toMatch(/^  meta:\s*$/m)
      expect(compose).not.toContain('asados-supabase-studio')
      expect(compose).not.toContain('asados-supabase-meta')
      expect(compose).not.toContain('supabase/studio:')
      expect(compose).not.toContain('supabase/postgres-meta:')
      expect(compose).not.toContain('STUDIO_PG_META_URL')
    })

    it('removes api-gw dependency on studio while retaining its gateway config and aliases', () => {
      const compose = read('ops', 'supabase', 'docker-compose.yml')
      const doc = parseCompose(compose)

      const apiGw = doc.services['api-gw']
      assertNoStudioDependency('api-gw', apiGw)
      expect(apiGw?.depends_on).toBeUndefined()

      // api-gw must retain network aliases and port mapping
      expect(apiGw?.container_name).toBe('asados-supabase-envoy')
      expect(apiGw?.networks?.default?.aliases).toEqual(
        expect.arrayContaining(['envoy', 'kong'])
      )
      expect(apiGw?.ports).toContain(
        '${API_GW_HTTP_PORT:-${KONG_HTTP_PORT:-8000}}:8000/tcp'
      )
    })

    it('allows legitimate healthy dependencies elsewhere while retaining data-plane services, edge functions, and volumes', () => {
      const compose = read('ops', 'supabase', 'docker-compose.yml')
      const doc = parseCompose(compose)

      const expectedServices = [
        'api-gw',
        'auth',
        'rest',
        'realtime',
        'storage',
        'functions',
        'db',
      ]
      for (const service of expectedServices) {
        expect(doc.services).toHaveProperty(service)
      }

      // Legitimate service_healthy dependencies elsewhere remain intact and allowed
      const authDepends = doc.services.auth?.depends_on as Record<string, { condition?: string }>
      expect(authDepends?.db?.condition).toBe('service_healthy')

      const restDepends = doc.services.rest?.depends_on as Record<string, { condition?: string }>
      expect(restDepends?.db?.condition).toBe('service_healthy')

      const realtimeDepends = doc.services.realtime?.depends_on as Record<string, { condition?: string }>
      expect(realtimeDepends?.db?.condition).toBe('service_healthy')

      const storageDepends = doc.services.storage?.depends_on as Record<string, { condition?: string }>
      expect(storageDepends?.db?.condition).toBe('service_healthy')
      expect(storageDepends?.rest?.condition).toBe('service_started')

      // Edge runtime specifically verified
      expect(compose).toContain('container_name: asados-supabase-edge-functions')
      expect(compose).toContain('image: supabase/edge-runtime:v1.74.0')
      expect(compose).toContain('./volumes/functions:/home/deno/functions:z')
      expect(compose).toContain('"start"')
      expect(compose).toContain('"--main-service"')
      expect(compose).toContain('"/home/deno/functions/main"')

      // Network and volumes
      expect(compose).toContain('name: asados-supabase-private')
      expect(compose).toContain('db-config:')
      expect(compose).toContain('deno-cache:')
    })

    describe('Synthetic Compose fixtures: service-scoped dependency rules', () => {
      it('allows unrelated healthy dependencies followed by ports when api-gw has no studio dependency', () => {
        const fixtureWithHealthyDepAndPorts = [
          'services:',
          '  auth:',
          '    image: supabase/gotrue:v2.189.0',
          '    depends_on:',
          '      db:',
          '        condition: service_healthy',
          '    ports:',
          '      - "9999:9999"',
          '  api-gw:',
          '    image: envoyproxy/envoy:v1.39.0',
          '    ports:',
          '      - "8000:8000"',
        ].join('\n')

        const doc = parseCompose(fixtureWithHealthyDepAndPorts)
        expect(() => assertStudioMetaServicesAbsent(doc)).not.toThrow()
        expect(() => assertNoStudioDependency('api-gw', doc.services['api-gw'])).not.toThrow()

        // Unrelated healthy dependency is allowed
        const authDepends = doc.services.auth?.depends_on as Record<string, { condition?: string }>
        expect(authDepends?.db?.condition).toBe('service_healthy')
      })

      it('rejects synthetic fixtures where api-gw depends on studio via object with condition', () => {
        const fixtureWithStudioDependency = [
          'services:',
          '  api-gw:',
          '    image: envoyproxy/envoy:v1.39.0',
          '    depends_on:',
          '      studio:',
          '        condition: service_healthy',
          '    ports:',
          '      - "8000:8000"',
        ].join('\n')

        const doc = parseCompose(fixtureWithStudioDependency)
        expect(() => assertNoStudioDependency('api-gw', doc.services['api-gw'])).toThrow(
          /must not reference studio/
        )
      })

      it('rejects synthetic fixtures where api-gw depends on studio via array', () => {
        const fixtureWithArrayStudioDependency = [
          'services:',
          '  api-gw:',
          '    image: envoyproxy/envoy:v1.39.0',
          '    depends_on:',
          '      - studio',
          '      - db',
        ].join('\n')

        const doc = parseCompose(fixtureWithArrayStudioDependency)
        expect(() => assertNoStudioDependency('api-gw', doc.services['api-gw'])).toThrow(
          /must not contain studio/
        )
      })

      it('rejects synthetic fixtures where studio or meta services are present', () => {
        const fixtureWithStudio = [
          'services:',
          '  studio:',
          '    image: supabase/studio:latest',
          '  api-gw:',
          '    image: envoyproxy/envoy:v1.39.0',
        ].join('\n')

        const doc = parseCompose(fixtureWithStudio)
        expect(() => assertStudioMetaServicesAbsent(doc)).toThrow()
      })
    })
  })

  describe('Kong API Gateway routing', () => {
    it('removes routes targeting studio and meta (/pg/, /api/mcp, /mcp, dashboard /)', () => {
      const kong = read('ops', 'supabase', 'volumes', 'api', 'kong.yml')

      expect(kong).not.toContain('url: http://meta:8080')
      expect(kong).not.toContain('url: http://studio:3000')
      expect(kong).not.toMatch(/paths:\s*\n\s*-\s*\/pg\//)
      expect(kong).not.toMatch(/paths:\s*\n\s*-\s*\/api\/mcp/)
      expect(kong).not.toMatch(/paths:\s*\n\s*-\s*\/mcp/)
      expect(kong).not.toMatch(/name:\s*dashboard-all/)
      expect(kong).not.toMatch(/name:\s*mcp-blocker/)
      expect(kong).not.toMatch(/name:\s*meta-all/)
    })

    it('retains edge functions and core data-plane routes', () => {
      const kong = read('ops', 'supabase', 'volumes', 'api', 'kong.yml')

      // Edge Functions route
      expect(kong).toContain('name: functions-v1')
      expect(kong).toContain('url: http://functions:9000/')
      expect(kong).toContain('- /functions/v1/')

      // Auth routes
      expect(kong).toContain('name: auth-v1-open')
      expect(kong).toContain('name: auth-v1')

      // PostgREST routes
      expect(kong).toContain('name: rest-v1')

      // Realtime routes
      expect(kong).toContain('name: realtime-v1-ws')

      // Storage routes
      expect(kong).toContain('name: storage-v1')
    })
  })

  describe('Verification and backup/restore scripts', () => {
    it('removes studio and meta from ops/supabase/verify.sh expected_containers', () => {
      const verify = read('ops', 'supabase', 'verify.sh')

      expect(verify).not.toContain('asados-supabase-studio')
      expect(verify).not.toContain('asados-supabase-meta')

      const expectedContainers = [
        'asados-supabase-envoy',
        'asados-supabase-auth',
        'asados-supabase-rest',
        'realtime-dev.supabase-realtime',
        'asados-supabase-storage',
        'asados-supabase-edge-functions',
        'asados-supabase-db',
      ]
      for (const container of expectedContainers) {
        expect(verify).toContain(container)
      }
    })

    it('updates clients in ops/supabase/restore.sh without studio or meta', () => {
      const restore = read('ops', 'supabase', 'restore.sh')

      expect(restore).toContain('clients="api-gw auth rest realtime storage functions"')
      expect(restore).not.toMatch(/clients=.*(?:studio|meta)/)
      expect(restore).toContain('docker compose stop $clients')
      expect(restore).toContain('docker compose up -d $clients')
      expect(restore).toContain('database.dump')
      expect(restore).toContain('storage.tar.gz')
    })
  })
})
