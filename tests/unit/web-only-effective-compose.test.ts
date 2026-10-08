import { describe, expect, it, afterEach } from 'vitest'
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import {
  createSandbox, FIXTURE_ID, FIXTURE_CANDIDATE_IMAGE_ID,
  FIXTURE_NETWORK_ID, Sandbox, makeInspectFixture, FIXTURE_IMAGE,
  PYTHON_BIN, HELPER_PATH,
} from '../helpers/web-target-sandbox'

let sb: Sandbox
afterEach(() => sb?.cleanup())

describe('web-only-effective-compose Unit U1 CLI', () => {
  it.each([
    ['missing candidate image', ['--action', 'generate-effective', '--bundle-dir', 'dummy'], 'candidate image locator required for generate-effective'],
    ['blank candidate image', ['--action', 'generate-effective', '--candidate-image', '  ', '--bundle-dir', 'dummy'], 'candidate image locator required for generate-effective'],
    ['missing bundle directory', ['--action', 'generate-effective', '--candidate-image', 'asados-web:candidate'], 'bundle directory required for generate-effective'],
    ['blank bundle directory', ['--action', 'generate-effective', '--candidate-image', 'asados-web:candidate', '--bundle-dir', '   '], 'bundle directory required for generate-effective'],
    ['extraneous bundle-dir on validate', ['--action', 'validate', '--bundle-dir', 'dummy'], 'extraneous bundle-dir on readonly action'],
    ['extraneous bundle-dir on inspect-resources', ['--action', 'inspect-resources', '--candidate-image', 'asados-web:candidate', '--bundle-dir', 'dummy'], 'extraneous bundle-dir on readonly action'],
    ['forbidden activate flag', ['--action', 'generate-effective', '--candidate-image', 'asados-web:candidate', '--bundle-dir', 'dummy', '--activate'], 'resource validation and generation deferred to S3; activation is unsupported'],
    ['forbidden generate flag', ['--action', 'generate-effective', '--candidate-image', 'asados-web:candidate', '--bundle-dir', 'dummy', '--generate'], 'resource validation and generation deferred to S3; activation is unsupported'],
  ])('rejects invalid arguments early: %s before daemon calls', (_, args, errMsg) => {
    sb = createSandbox()
    const ret = sb.runHelper(['--root', sb.opRoot, ...args])
    expect(ret.status).toBe(2)
    expect(JSON.parse(ret.stdout.trim())).toEqual({ status: 'error', error: errMsg })
    expect(readFileSync(sb.spyLog, 'utf8').trim()).toBe('')
  })

  it('generates effective bundle with 0700 dir, 0600 payloads, pinned images, only web, and zero mutations', () => {
    sb = createSandbox()
    const bundleDir = join(sb.dir, 'effective-bundle')
    const secretCompose = JSON.stringify({
      services: {
        web: {
          image: 'asados-web:latest',
          build: { context: '.', dockerfile: 'Dockerfile' },
          ports: [{ mode: 'ingress', target: 3000, published: '3020', protocol: 'tcp', host_ip: '127.0.0.1' }],
          environment: { PORT: '3000', SECRET_API_KEY: 'topsecret999' },
          networks: { default: { aliases: ['asados-web', 'crm-sofia-web'] } },
        },
        redis: { image: 'redis:7' },
      },
      networks: { default: { name: 'asados_default' } },
      volumes: { redis_data: {} },
    })

    const ret = sb.runHelper(
      ['--root', sb.opRoot, '--action', 'generate-effective', '--candidate-image', 'asados-web:candidate', '--bundle-dir', bundleDir],
      {
        FAKE_DOCKER_COMPOSE_CONFIG_OUTPUT: secretCompose,
        FAKE_DOCKER_INSPECT_OUTPUT: makeInspectFixture(sb.opRoot),
      },
    )
    expect(ret.status).toBe(0)
    const out = JSON.parse(ret.stdout.trim())
    expect(out.status).toBe('ok')
    expect(out.action).toBe('generate-effective')
    expect(out.candidate_image_id).toBe(FIXTURE_CANDIDATE_IMAGE_ID)
    expect(out.current_image_id).toBe(FIXTURE_IMAGE)
    expect(out.networks).toEqual(['asados_default'])
    expect(out.ports).toEqual({ target: 3000, published: 3020, host_ip: '127.0.0.1', protocol: 'tcp' })
    expect(ret.stdout).not.toContain('topsecret999')
    expect(ret.stderr).not.toContain('topsecret999')

    expect(statSync(bundleDir).mode & 0o777).toBe(0o700)
    expect(statSync(out.candidate_compose_path).mode & 0o777).toBe(0o600)
    expect(statSync(out.rollback_compose_path).mode & 0o777).toBe(0o600)
    expect(statSync(out.manifest_path).mode & 0o777).toBe(0o600)

    const manifest = JSON.parse(readFileSync(out.manifest_path, 'utf8'))
    expect(manifest.schema_version).toBe('1.0')
    expect(manifest.candidate_compose_sha256).toBe(out.candidate_compose_sha256)
    expect(manifest.rollback_compose_sha256).toBe(out.rollback_compose_sha256)
    expect(manifest.candidate_image_id).toBe(FIXTURE_CANDIDATE_IMAGE_ID)
    expect(manifest.current_image_id).toBe(FIXTURE_IMAGE)
    expect(JSON.stringify(manifest)).not.toContain('topsecret999')

    const candDoc = JSON.parse(readFileSync(out.candidate_compose_path, 'utf8'))
    expect(Object.keys(candDoc.services)).toEqual(['web'])
    expect(candDoc.services.web.image).toBe(FIXTURE_CANDIDATE_IMAGE_ID)
    expect(candDoc.services.web.build).toBeUndefined()
    expect(candDoc.services.web.depends_on).toBeUndefined()
    expect(candDoc.services.web.environment.SECRET_API_KEY).toBe('topsecret999')
    expect(candDoc.services.web.networks).toEqual({ asados_default: { aliases: ['asados-web', 'crm-sofia-web'] } })
    expect(candDoc.networks).toEqual({ asados_default: { name: 'asados_default', external: true } })
    expect(candDoc.volumes).toBeUndefined()

    const rollDoc = JSON.parse(readFileSync(out.rollback_compose_path, 'utf8'))
    expect(Object.keys(rollDoc.services)).toEqual(['web'])
    expect(rollDoc.services.web.image).toBe(FIXTURE_IMAGE)
    expect(rollDoc.services.web.build).toBeUndefined()
    expect(rollDoc.services.web.depends_on).toBeUndefined()
    expect(rollDoc.services.web.environment.SECRET_API_KEY).toBe('topsecret999')
    expect(rollDoc.networks).toEqual({ asados_default: { name: 'asados_default', external: true } })

    const spyLines = readFileSync(sb.spyLog, 'utf8').trim().split('\n')
    expect(spyLines.length).toBe(5)
    for (const line of spyLines) {
      expect(line).not.toMatch(/(?:^|\s)(run|rm|tag|build|push|up|down)(?:\s|$)/)
    }
  })

  it('executes successfully from an arbitrary working directory outside the repository', () => {
    sb = createSandbox()
    const bundleDir = join(sb.dir, 'arb-bundle')
    const arbCwd = tmpdir()
    const ret = spawnSync(PYTHON_BIN, [
      '-B', HELPER_PATH, '--root', sb.opRoot,
      '--action', 'generate-effective', '--candidate-image', 'asados-web:candidate',
      '--bundle-dir', bundleDir,
    ], {
      cwd: arbCwd,
      env: {
        PATH: join(sb.dir, 'bin'),
        PYTHONDONTWRITEBYTECODE: '1',
        SPY_LOG: sb.spyLog,
        FAKE_DOCKER_INSPECT_OUTPUT: makeInspectFixture(sb.opRoot),
      },
      encoding: 'utf8',
    })
    expect(ret.status).toBe(0)
    const out = JSON.parse(ret.stdout.trim())
    expect(out.status).toBe('ok')
    expect(existsSync(out.candidate_compose_path)).toBe(true)
  })

  it('validates external network name and marks external true with rollback image pinned', () => {
    sb = createSandbox()
    const bundleDir = join(sb.dir, 'ext-bundle')
    const composeExt = JSON.stringify({
      services: {
        web: {
          ports: [{ mode: 'ingress', target: 3000, published: '3020', protocol: 'tcp', host_ip: '127.0.0.1' }],
          networks: { ext_net: { aliases: ['asados-web', 'crm-sofia-web'] } },
        },
      },
      networks: { ext_net: { name: 'external_runtime_net', external: true } },
    })

    const ret = sb.runHelper(
      ['--root', sb.opRoot, '--action', 'generate-effective', '--candidate-image', 'asados-web:candidate', '--bundle-dir', bundleDir],
      {
        FAKE_DOCKER_COMPOSE_CONFIG_OUTPUT: composeExt,
        FAKE_DOCKER_INSPECT_OUTPUT: makeInspectFixture(sb.opRoot, {}, {
          NetworkSettings: { Networks: { external_runtime_net: { NetworkID: FIXTURE_NETWORK_ID, Aliases: ['asados-web', 'crm-sofia-web'] } } },
        }),
        FAKE_DOCKER_NETWORK_INSPECT_OUTPUT: JSON.stringify([{ Id: FIXTURE_NETWORK_ID, Name: 'external_runtime_net', Labels: {} }]),
      },
    )
    expect(ret.status).toBe(0)
    const out = JSON.parse(ret.stdout.trim())
    expect(out.networks).toEqual(['external_runtime_net'])

    const candDoc = JSON.parse(readFileSync(out.candidate_compose_path, 'utf8'))
    expect(candDoc.networks).toEqual({ external_runtime_net: { name: 'external_runtime_net', external: true } })
    const rollDoc = JSON.parse(readFileSync(out.rollback_compose_path, 'utf8'))
    expect(rollDoc.services.web.image).toBe(FIXTURE_IMAGE)
    expect(rollDoc.networks).toEqual({ external_runtime_net: { name: 'external_runtime_net', external: true } })
  })

  it('accepts a bare service network entry that compose renders as null', () => {
    sb = createSandbox()
    const bundleDir = join(sb.dir, 'null-net-bundle')
    const composeNullNet = JSON.stringify({
      services: {
        web: {
          ports: [{ mode: 'ingress', target: 3000, published: '3020', protocol: 'tcp', host_ip: '127.0.0.1' }],
          networks: { supabase_private: null },
        },
      },
      networks: { supabase_private: { name: 'asados-supabase-private', external: true } },
    })

    const ret = sb.runHelper(
      ['--root', sb.opRoot, '--action', 'generate-effective', '--candidate-image', 'asados-web:candidate', '--bundle-dir', bundleDir],
      {
        FAKE_DOCKER_COMPOSE_CONFIG_OUTPUT: composeNullNet,
        FAKE_DOCKER_INSPECT_OUTPUT: makeInspectFixture(sb.opRoot, {}, {
          NetworkSettings: { Networks: { 'asados-supabase-private': { NetworkID: FIXTURE_NETWORK_ID, Aliases: ['asados-web'] } } },
        }),
        FAKE_DOCKER_NETWORK_INSPECT_OUTPUT: JSON.stringify([{ Id: FIXTURE_NETWORK_ID, Name: 'asados-supabase-private', Labels: {} }]),
      },
    )
    expect(ret.status).toBe(0)
    const out = JSON.parse(ret.stdout.trim())
    expect(out.networks).toEqual(['asados-supabase-private'])

    const candDoc = JSON.parse(readFileSync(out.candidate_compose_path, 'utf8'))
    expect(candDoc.services.web.networks).toEqual({ 'asados-supabase-private': {} })
    expect(candDoc.networks).toEqual({ 'asados-supabase-private': { name: 'asados-supabase-private', external: true } })
  })

  it('fails closed before bundle write when web service defines dependencies', () => {
    sb = createSandbox()
    const bundleDir = join(sb.dir, 'deps-bundle')
    const composeWithDeps = JSON.stringify({
      services: {
        web: {
          ports: [{ mode: 'ingress', target: 3000, published: '3020', protocol: 'tcp', host_ip: '127.0.0.1' }],
          depends_on: ['db'],
        },
      },
    })
    const ret = sb.runHelper(
      ['--root', sb.opRoot, '--action', 'generate-effective', '--candidate-image', 'asados-web:candidate', '--bundle-dir', bundleDir],
      {
        FAKE_DOCKER_COMPOSE_CONFIG_OUTPUT: composeWithDeps,
        FAKE_DOCKER_INSPECT_OUTPUT: makeInspectFixture(sb.opRoot),
      },
    )
    expect(ret.status).not.toBe(0)
    expect(JSON.parse(ret.stdout.trim()).error).toBe('unexpected compose web service dependencies')
    expect(existsSync(bundleDir)).toBe(false)
  })

  it('preserves existing bundle directory collision and sanitizes writer failure', () => {
    sb = createSandbox()
    const bundleDir = join(sb.dir, 'existing-bundle')
    mkdirSync(bundleDir, 0o700)
    writeFileSync(join(bundleDir, 'foreign.txt'), 'foreign payload')

    const ret = sb.runHelper(
      ['--root', sb.opRoot, '--action', 'generate-effective', '--candidate-image', 'asados-web:candidate', '--bundle-dir', bundleDir],
      { FAKE_DOCKER_INSPECT_OUTPUT: makeInspectFixture(sb.opRoot) },
    )
    expect(ret.status).toBe(1)
    expect(JSON.parse(ret.stdout.trim())).toEqual({ status: 'error', error: 'bundle generation failed' })
    expect(ret.stdout + ret.stderr).not.toContain('Traceback')
    expect(existsSync(join(bundleDir, 'foreign.txt'))).toBe(true)
    expect(readFileSync(join(bundleDir, 'foreign.txt'), 'utf8')).toBe('foreign payload')
  })

  it('build_effective_compose handles multiple networks and pins images without build or deps', () => {
    const pythonScript = `import json, os, sys
_s = os.path.dirname(os.path.realpath("${HELPER_PATH}"))
if _s not in sys.path: sys.path.insert(0, _s)
import importlib.util
spec = importlib.util.spec_from_file_location("preflight", "${HELPER_PATH}")
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

base_web = {
    "image": "old:tag",
    "build": {"context": "."},
    "depends_on": ["other"],
    "ports": [{"target": 3000, "published": 3020}],
    "environment": {"A": "1"},
}
net_info = {
    "net_a": {"aliases": ["a1", "a2"]},
    "net_b": {"aliases": []},
}
c_doc = mod.build_effective_compose(base_web, "sha256:cand", net_info)
r_doc = mod.build_effective_compose(base_web, "sha256:roll", net_info)
assert list(c_doc["services"].keys()) == ["web"]
assert c_doc["services"]["web"]["image"] == "sha256:cand"
assert "build" not in c_doc["services"]["web"]
assert "depends_on" not in c_doc["services"]["web"]
assert c_doc["services"]["web"]["networks"] == {"net_a": {"aliases": ["a1", "a2"]}, "net_b": {}}
assert c_doc["networks"] == {"net_a": {"name": "net_a", "external": True}, "net_b": {"name": "net_b", "external": True}}
assert r_doc["services"]["web"]["image"] == "sha256:roll"
print("MULTI_NET_VERIFIED")`

    const ret = spawnSync(PYTHON_BIN, ['-B', '-c', pythonScript], {
      env: { PYTHONDONTWRITEBYTECODE: '1' },
      encoding: 'utf8',
    })
    expect(ret.status).toBe(0)
    expect(ret.stdout.trim()).toBe('MULTI_NET_VERIFIED')
  })
})
