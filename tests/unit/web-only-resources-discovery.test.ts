import { describe, expect, it, afterEach } from 'vitest'
import { readFileSync, writeFileSync } from 'node:fs'
import {
  createSandbox, FIXTURE_ID, FIXTURE_CANDIDATE_IMAGE_ID,
  FIXTURE_NETWORK_ID, Sandbox, makeInspectFixture, FIXTURE_IMAGE,
} from '../helpers/web-target-sandbox'

let sb: Sandbox
afterEach(() => sb?.cleanup())

function assertDocker(
  sb: Sandbox,
  args: string[],
  expected: { status: number; stderr: string; stdout?: string },
  env?: Record<string, string>,
) {
  writeFileSync(sb.spyLog, '')
  const ret = sb.runDocker(args, env)
  expect(ret.status).toBe(expected.status)
  expect(ret.stderr.trim()).toBe(expected.stderr)
  if (expected.stdout !== undefined) {
    expect(ret.stdout.trim()).toBe(expected.stdout)
  }
  const host = env?.DOCKER_HOST ?? 'none'
  const ctx = env?.DOCKER_CONTEXT ?? 'none'
  expect(readFileSync(sb.spyLog, 'utf8').trim()).toBe(`${args.join(' ')} | DOCKER_HOST=${host} | DOCKER_CONTEXT=${ctx}`)
}

describe('web-only-sandbox-mock-contract', () => {
  it('enforces exact semantic argv allowlist on docker compose config', () => {
    sb = createSandbox()
    const base = [
      '--host', 'unix:///var/run/docker.sock', 'compose',
      '--project-directory', sb.opRoot, '--env-file', `${sb.opRoot}/.env`,
      '-f', `${sb.opRoot}/docker-compose.yml`, '--project-name', 'asados',
      'config', '--format', 'json',
    ]
    assertDocker(sb, base, { status: 0, stderr: '' })
    expect(JSON.parse(sb.runDocker(base).stdout).services.web.image).toBe('asados-web:latest')

    assertDocker(sb, [...base.slice(0, 4), '/wrong/dir', ...base.slice(5)], {
      status: 1, stderr: 'deny compose project-directory: /wrong/dir',
    })
    assertDocker(sb, [...base.slice(0, 6), `${sb.opRoot}/wrong.env`, ...base.slice(7)], {
      status: 1, stderr: `deny compose env-file: ${sb.opRoot}/wrong.env`,
    })
    assertDocker(sb, [...base.slice(0, 8), `${sb.opRoot}/wrong.yml`, ...base.slice(9)], {
      status: 1, stderr: `deny compose config: ${sb.opRoot}/wrong.yml`,
    })
    assertDocker(sb, [...base.slice(0, 10), 'other-proj', ...base.slice(11)], {
      status: 1, stderr: 'deny compose project-name: other-proj',
    })
    assertDocker(sb, ['--host', 'unix:///var/run/docker.sock', 'compose', '--wrong-flag', sb.opRoot, ...base.slice(5)], {
      status: 1, stderr: 'deny compose args: --host unix:///var/run/docker.sock compose --wrong-flag ' + sb.opRoot + ' ' + base.slice(5).join(' '),
    })
    assertDocker(sb, [...base, '--extra-arg'], {
      status: 1, stderr: 'deny compose args: ' + [...base, '--extra-arg'].join(' '),
    })
    assertDocker(sb, ['--host', 'unix:///var/run/docker.sock', 'compose', 'up'], {
      status: 1, stderr: 'deny mutation: up',
    })
  })

  it('enforces exact semantic argv allowlist on docker image inspect', () => {
    sb = createSandbox()
    assertDocker(sb, ['--host', 'unix:///var/run/docker.sock', 'image', 'inspect', 'asados-web:candidate'], {
      status: 0, stderr: '',
    })

    assertDocker(sb, ['--host', 'unix:///var/run/docker.sock', 'image', 'inspect', 'unknown:locator'], {
      status: 1, stderr: 'deny unknown image inspect locator: unknown:locator',
    })
    assertDocker(sb, ['--host', 'unix:///var/run/docker.sock', 'image', 'inspect'], {
      status: 1, stderr: 'deny image inspect args: --host unix:///var/run/docker.sock image inspect',
    })
    assertDocker(sb, ['--host', 'unix:///var/run/docker.sock', 'image', 'inspect', 'asados-web:candidate', 'extra'], {
      status: 1, stderr: 'deny image inspect args: --host unix:///var/run/docker.sock image inspect asados-web:candidate extra',
    })
  })

  it('enforces exact semantic argv allowlist on docker network inspect', () => {
    sb = createSandbox()
    assertDocker(sb, ['--host', 'unix:///var/run/docker.sock', 'network', 'inspect', FIXTURE_NETWORK_ID], {
      status: 0, stderr: '',
    })

    assertDocker(sb, ['--host', 'unix:///var/run/docker.sock', 'network', 'inspect', 'bad-net-id'], {
      status: 1, stderr: 'deny unknown network inspect id: bad-net-id',
    })
    assertDocker(sb, ['--host', 'unix:///var/run/docker.sock', 'network', 'inspect'], {
      status: 1, stderr: 'deny network inspect args: --host unix:///var/run/docker.sock network inspect',
    })
    assertDocker(sb, ['--host', 'unix:///var/run/docker.sock', 'network', 'inspect', FIXTURE_NETWORK_ID, 'extra'], {
      status: 1, stderr: `deny network inspect args: --host unix:///var/run/docker.sock network inspect ${FIXTURE_NETWORK_ID} extra`,
    })
  })

  it('rejects remote or non-unix docker host and unknown docker commands', () => {
    sb = createSandbox()
    assertDocker(sb, ['--host', 'tcp://1.2.3.4:2375', 'ps'], {
      status: 1, stderr: 'deny host',
    })
    assertDocker(sb, ['--host', 'unix:///var/run/docker.sock', 'unknown-subcommand'], {
      status: 1, stderr: 'deny unknown docker command: unknown-subcommand',
    })
  })

  it('isolates command-scoped fault injection across docker commands', () => {
    sb = createSandbox()
    const composeBase = [
      '--host', 'unix:///var/run/docker.sock', 'compose',
      '--project-directory', sb.opRoot, '--env-file', `${sb.opRoot}/.env`,
      '-f', `${sb.opRoot}/docker-compose.yml`, '--project-name', 'asados',
      'config', '--format', 'json',
    ]

    assertDocker(sb, composeBase, { status: 2, stderr: 'compose_failed_err', stdout: '' }, {
      FAKE_DOCKER_COMPOSE_EXIT: '2', FAKE_DOCKER_COMPOSE_STDERR: 'compose_failed_err',
    })
    assertDocker(sb, ['--host', 'unix:///var/run/docker.sock', 'image', 'inspect', 'asados-web:candidate'], {
      status: 0, stderr: '',
    })

    assertDocker(sb, ['--host', 'unix:///var/run/docker.sock', 'image', 'inspect', 'asados-web:candidate'], {
      status: 3, stderr: 'image_failed_err', stdout: '',
    }, {
      FAKE_DOCKER_IMAGE_EXIT: '3', FAKE_DOCKER_IMAGE_STDERR: 'image_failed_err',
    })
    assertDocker(sb, composeBase, { status: 0, stderr: '' })

    assertDocker(sb, ['--host', 'unix:///var/run/docker.sock', 'network', 'inspect', FIXTURE_NETWORK_ID], {
      status: 4, stderr: 'network_failed_err', stdout: '',
    }, {
      FAKE_DOCKER_NETWORK_EXIT: '4', FAKE_DOCKER_NETWORK_STDERR: 'network_failed_err',
    })
    assertDocker(sb, composeBase, { status: 0, stderr: '' })
  })

  it('preserves backward-compatible global FAKE_DOCKER_EXIT behavior for S2 suites', () => {
    sb = createSandbox()
    const psArgs = [
      '--host', 'unix:///var/run/docker.sock', 'ps', '-aq',
      '--filter', 'label=com.docker.compose.project=asados',
      '--filter', 'label=com.docker.compose.service=web',
    ]
    assertDocker(sb, psArgs, { status: 5, stderr: 'global_ps_fail', stdout: '' }, {
      FAKE_DOCKER_EXIT: '5', FAKE_DOCKER_STDERR: 'global_ps_fail',
    })
  })

  it('records exact spy log entries and asserts positive status, fixture payload, and secret safety for all 3 calls', () => {
    sb = createSandbox()
    writeFileSync(`${sb.opRoot}/.env`, 'SECRET_KEY=supersecret99\nPORT=3000\n')
    const imgRet = sb.runDocker(['--host', 'unix:///var/run/docker.sock', 'image', 'inspect', 'asados-web:candidate'])
    expect(imgRet.status).toBe(0)
    expect(imgRet.stderr).toBe('')
    expect(JSON.parse(imgRet.stdout)[0].Id).toBe(FIXTURE_CANDIDATE_IMAGE_ID)
    expect(imgRet.stdout + imgRet.stderr).not.toContain('supersecret99')

    const compRet = sb.runDocker([
      '--host', 'unix:///var/run/docker.sock', 'compose',
      '--project-directory', sb.opRoot, '--env-file', `${sb.opRoot}/.env`,
      '-f', `${sb.opRoot}/docker-compose.yml`, '--project-name', 'asados',
      'config', '--format', 'json',
    ])
    expect(compRet.status).toBe(0)
    expect(compRet.stderr).toBe('')
    expect(JSON.parse(compRet.stdout).services.web.image).toBe('asados-web:latest')
    expect(compRet.stdout + compRet.stderr).not.toContain('supersecret99')

    const netRet = sb.runDocker(['--host', 'unix:///var/run/docker.sock', 'network', 'inspect', FIXTURE_NETWORK_ID])
    expect(netRet.status).toBe(0)
    expect(netRet.stderr).toBe('')
    expect(JSON.parse(netRet.stdout)[0].Id).toBe(FIXTURE_NETWORK_ID)
    expect(netRet.stdout + netRet.stderr).not.toContain('supersecret99')

    const log = readFileSync(sb.spyLog, 'utf8').trim()
    expect(log).not.toContain('supersecret99')
    const lines = log.split('\n')
    expect(lines).toEqual([
      `--host unix:///var/run/docker.sock image inspect asados-web:candidate | DOCKER_HOST=none | DOCKER_CONTEXT=none`,
      `--host unix:///var/run/docker.sock compose --project-directory ${sb.opRoot} --env-file ${sb.opRoot}/.env -f ${sb.opRoot}/docker-compose.yml --project-name asados config --format json | DOCKER_HOST=none | DOCKER_CONTEXT=none`,
      `--host unix:///var/run/docker.sock network inspect ${FIXTURE_NETWORK_ID} | DOCKER_HOST=none | DOCKER_CONTEXT=none`,
    ])
  })

  it('confirms baseline preflight helper fails-closed on deferred inspect-resources action', () => {
    sb = createSandbox()
    const ret = sb.runHelper(['--root', sb.opRoot, '--action', 'inspect-resources'])
    expect(ret.status).toBe(2)
    expect(JSON.parse(ret.stdout.trim())).toEqual({
      status: 'error', error: 'candidate image locator required for inspect-resources',
    })
    expect(readFileSync(sb.spyLog, 'utf8').trim()).toBe('')
  })
})

const SPY_PS = () => `--host unix:///var/run/docker.sock ps -aq --filter label=com.docker.compose.project=asados --filter label=com.docker.compose.service=web | DOCKER_HOST=unix:///var/run/docker.sock | DOCKER_CONTEXT=none`
const SPY_INSPECT = () => `--host unix:///var/run/docker.sock inspect ${FIXTURE_ID} | DOCKER_HOST=unix:///var/run/docker.sock | DOCKER_CONTEXT=none`
const SPY_IMAGE = (cand = 'asados-web:candidate') => `--host unix:///var/run/docker.sock image inspect ${cand} | DOCKER_HOST=unix:///var/run/docker.sock | DOCKER_CONTEXT=none`
const SPY_COMPOSE = (opRoot: string) => `--host unix:///var/run/docker.sock compose --project-directory ${opRoot} --env-file ${opRoot}/.env -f ${opRoot}/docker-compose.yml --project-name asados config --format json | DOCKER_HOST=unix:///var/run/docker.sock | DOCKER_CONTEXT=none`
const SPY_NET = (netId = FIXTURE_NETWORK_ID) => `--host unix:///var/run/docker.sock network inspect ${netId} | DOCKER_HOST=unix:///var/run/docker.sock | DOCKER_CONTEXT=none`

const expectHelperError = (ret: ReturnType<Sandbox['runHelper']>, err: string, expectedSpyLines: string[], code = 1) => {
  expect(ret.status).toBe(code)
  expect(JSON.parse(ret.stdout.trim())).toEqual({ status: 'error', error: err })
  const lines = readFileSync(sb.spyLog, 'utf8').trim()
  expect(lines ? lines.split('\n') : []).toEqual(expectedSpyLines)
}

describe('web-only-resources-discovery-domain', () => {
  it('discovers and validates canonical operational resources with safe metadata and exact terminal spy', () => {
    sb = createSandbox()
    writeFileSync(`${sb.opRoot}/.env`, 'SECRET_TOKEN=dontleakme\nPORT=3000\n')
    const ret = sb.runHelper(['--root', sb.opRoot, '--project', 'asados', '--action', 'inspect-resources', '--candidate-image', 'asados-web:candidate'], {
      FAKE_DOCKER_INSPECT_OUTPUT: makeInspectFixture(sb.opRoot),
    })
    expect(ret.status).toBe(0)
    expect(JSON.parse(ret.stdout.trim())).toEqual({
      status: 'ok', action: 'inspect-resources', container_id: FIXTURE_ID, container_name: 'crm-sofia-web',
      candidate_image_id: FIXTURE_CANDIDATE_IMAGE_ID, current_image_id: FIXTURE_IMAGE,
      project: 'asados', service: 'web',
      ports: { target: 3000, published: 3020, host_ip: '127.0.0.1', protocol: 'tcp' },
      networks: ['asados_default'], mounts: [], endpoint: 'unix:///var/run/docker.sock',
    })
    expect(ret.stdout + ret.stderr).not.toContain('dontleakme')
    expect(readFileSync(sb.spyLog, 'utf8').trim().split('\n')).toEqual([
      SPY_PS(), SPY_INSPECT(), SPY_IMAGE(), SPY_COMPOSE(sb.opRoot), SPY_NET(),
    ])
  })

  it.each([
    ['remote docker host env', { DOCKER_HOST: 'tcp://10.0.0.1:2375' }, 'remote or non-unix DOCKER_HOST rejected'],
    ['docker context override', { DOCKER_CONTEXT: 'custom-ctx' }, 'conflicting DOCKER_CONTEXT override rejected'],
  ])('fails closed early before docker execution on %s', (_, env, err) => {
    sb = createSandbox()
    const ret = sb.runHelper(['--root', sb.opRoot, '--action', 'inspect-resources', '--candidate-image', 'asados-web:candidate'], env)
    expectHelperError(ret, err, [])
  })

  it.each([
    ['host port mismatch', { HostConfig: { PortBindings: { '3000/tcp': [{ HostIp: '127.0.0.1', HostPort: '3021' }] } } }, {}, 'container port bindings mismatch'],
    ['host ip mismatch', { HostConfig: { PortBindings: { '3000/tcp': [{ HostIp: '0.0.0.0', HostPort: '3020' }] } } }, {}, 'container port bindings mismatch'],
    ['extra host binding', { HostConfig: { PortBindings: { '3000/tcp': [{ HostIp: '127.0.0.1', HostPort: '3020' }], '8080/tcp': [{ HostIp: '127.0.0.1', HostPort: '8080' }] } } }, {}, 'container port bindings mismatch'],
    ['network ports mismatch', { NetworkSettings: { Ports: { '3000/tcp': [{ HostIp: '127.0.0.1', HostPort: '3021' }] } } }, {}, 'container network ports mismatch'],
    ['container missing mounts', { Mounts: null }, {}, 'invalid container mounts'],
    ['container bind mount', { Mounts: [{ Type: 'bind', Source: '/host', Destination: '/app' }] }, {}, 'invalid container mounts'],
    ['container volume mount', { Mounts: [{ Type: 'volume', Name: 'vol1', Destination: '/data' }] }, {}, 'invalid container mounts'],
    ['container host binds', { HostConfig: { Binds: ['/host:/app'] } }, {}, 'unexpected container binds'],
  ])('rejects container ports and mounts drift: %s', (_, ctr, env, err) => {
    sb = createSandbox()
    const ret = sb.runHelper(['--root', sb.opRoot, '--action', 'inspect-resources', '--candidate-image', 'asados-web:candidate'], {
      FAKE_DOCKER_INSPECT_OUTPUT: makeInspectFixture(sb.opRoot, {}, ctr), ...env,
    })
    expectHelperError(ret, err, [SPY_PS(), SPY_INSPECT(), SPY_IMAGE(), SPY_COMPOSE(sb.opRoot)])
  })

  it.each([
    ['compose published mismatch', { FAKE_DOCKER_COMPOSE_CONFIG_OUTPUT: JSON.stringify({ services: { web: { ports: [{ target: 3000, published: 3021, host_ip: '127.0.0.1', protocol: 'tcp' }] } } }) }, 'compose web ports mismatch'],
    ['compose missing explicit host_ip', { FAKE_DOCKER_COMPOSE_CONFIG_OUTPUT: JSON.stringify({ services: { web: { ports: [{ target: 3000, published: 3020, protocol: 'tcp' }] } } }) }, 'compose web ports mismatch'],
    ['compose extra port', { FAKE_DOCKER_COMPOSE_CONFIG_OUTPUT: JSON.stringify({ services: { web: { ports: [{ target: 3000, published: 3020, host_ip: '127.0.0.1', protocol: 'tcp' }, { target: 80, published: 8080 }] } } }) }, 'compose web ports mismatch'],
    ['compose declared volume', { FAKE_DOCKER_COMPOSE_CONFIG_OUTPUT: JSON.stringify({ services: { web: { ports: [{ target: 3000, published: 3020, host_ip: '127.0.0.1', protocol: 'tcp' }], volumes: ['/host:/app'] } } }) }, 'unexpected compose volumes'],
    ['compose volume invalid type', { FAKE_DOCKER_COMPOSE_CONFIG_OUTPUT: JSON.stringify({ services: { web: { ports: [{ target: 3000, published: 3020, host_ip: '127.0.0.1', protocol: 'tcp' }], volumes: 'invalid' } } }) }, 'unexpected compose volumes'],
  ])('rejects compose ports and volumes drift: %s', (_, env, err) => {
    sb = createSandbox()
    const ret = sb.runHelper(['--root', sb.opRoot, '--action', 'inspect-resources', '--candidate-image', 'asados-web:candidate'], {
      FAKE_DOCKER_INSPECT_OUTPUT: makeInspectFixture(sb.opRoot), ...env,
    })
    expectHelperError(ret, err, [SPY_PS(), SPY_INSPECT(), SPY_IMAGE(), SPY_COMPOSE(sb.opRoot)])
  })

  it.each([
    ['top-level networks invalid non-dict', 'invalid', 'invalid compose networks structure'],
    ['top-level networks false', false, 'invalid compose networks structure'],
    ['top-level networks 0', 0, 'invalid compose networks structure'],
    ['top-level networks empty string', '', 'invalid compose networks structure'],
    ['top-level networks null', null, 'invalid compose networks structure'],
    ['web networks invalid non-dict/list', false, 'invalid compose web networks'],
    ['web networks empty list', [], 'invalid compose web networks'],
    ['web networks 0', 0, 'invalid compose web networks'],
    ['web networks empty string', '', 'invalid compose web networks'],
    ['web networks null', null, 'invalid compose web networks'],
    ['web attachment non-dict boolean', { default: false }, 'invalid compose web networks'],
    ['web attachment non-dict integer', { default: 0 }, 'invalid compose web networks'],
    ['web attachment non-dict string', { default: 'val' }, 'invalid compose web networks'],
    ['web attachment non-dict null', { default: null }, 'invalid compose web networks'],
    ['declared aliases non-string', { default: { aliases: [123] } }, 'invalid compose network aliases'],
    ['string false external', 'false', 'invalid compose network external definition'],
    ['integer external', 1, 'invalid compose network external definition'],
    ['external 0', 0, 'invalid compose network external definition'],
    ['external null', null, 'invalid compose network external definition'],
    ['network name false', { default: { name: false } }, 'invalid compose network name'],
    ['network name 0', { default: { name: 0 } }, 'invalid compose network name'],
    ['network name empty string', { default: { name: '' } }, 'invalid compose network name'],
    ['network name whitespace', { default: { name: '   ' } }, 'invalid compose network name'],
    ['network name null', { default: { name: null } }, 'invalid compose network name'],
    ['network name list', { default: { name: [] } }, 'invalid compose network name'],
  ])('rejects non-dict or non-boolean network definitions: %s', (desc, val, err) => {
    sb = createSandbox()
    const web = { ports: [{ target: 3000, published: 3020, host_ip: '127.0.0.1', protocol: 'tcp' }] }
    let compose: string
    if (desc.startsWith('top-level')) compose = JSON.stringify({ services: { web }, networks: val })
    else if (desc.startsWith('network name')) compose = JSON.stringify({ services: { web: { ...web, networks: { default: {} } } }, networks: val })
    else if (desc.includes('external')) compose = JSON.stringify({ services: { web: { ...web, networks: { ext_net: {} } } }, networks: { ext_net: { name: 'external_runtime_net', external: val } } })
    else compose = JSON.stringify({ services: { web: { ...web, networks: val } } })
    const ret = sb.runHelper(['--root', sb.opRoot, '--action', 'inspect-resources', '--candidate-image', 'asados-web:candidate'], {
      FAKE_DOCKER_COMPOSE_CONFIG_OUTPUT: compose, FAKE_DOCKER_INSPECT_OUTPUT: makeInspectFixture(sb.opRoot),
    })
    expectHelperError(ret, err, [SPY_PS(), SPY_INSPECT(), SPY_IMAGE(), SPY_COMPOSE(sb.opRoot)])
  })

  it('permits external network with exact boolean true without project label', () => {
    sb = createSandbox()
    const composeWithExt = JSON.stringify({
      services: { web: { ports: [{ target: 3000, published: 3020, host_ip: '127.0.0.1', protocol: 'tcp' }], networks: { ext_net: { aliases: ['asados-web', 'crm-sofia-web'] } } } },
      networks: { ext_net: { name: 'external_runtime_net', external: true } },
    })
    const ret = sb.runHelper(['--root', sb.opRoot, '--action', 'inspect-resources', '--candidate-image', 'asados-web:candidate'], {
      FAKE_DOCKER_COMPOSE_CONFIG_OUTPUT: composeWithExt,
      FAKE_DOCKER_INSPECT_OUTPUT: makeInspectFixture(sb.opRoot, {}, {
        NetworkSettings: { Networks: { external_runtime_net: { NetworkID: FIXTURE_NETWORK_ID, Aliases: ['asados-web', 'crm-sofia-web'] } } },
      }),
      FAKE_DOCKER_NETWORK_INSPECT_OUTPUT: JSON.stringify([{ Id: FIXTURE_NETWORK_ID, Name: 'external_runtime_net', Labels: {} }]),
    })
    expect(ret.status).toBe(0)
    expect(JSON.parse(ret.stdout.trim()).networks).toEqual(['external_runtime_net'])
    expect(readFileSync(sb.spyLog, 'utf8').trim().split('\n')).toEqual([
      SPY_PS(), SPY_INSPECT(), SPY_IMAGE(), SPY_COMPOSE(sb.opRoot), SPY_NET(),
    ])
  })

  it('permits canonical default network when networks keys are legitimately omitted', () => {
    sb = createSandbox()
    const composeOmitted = JSON.stringify({
      services: { web: { ports: [{ target: 3000, published: 3020, host_ip: '127.0.0.1', protocol: 'tcp' }] } },
    })
    const ret = sb.runHelper(['--root', sb.opRoot, '--action', 'inspect-resources', '--candidate-image', 'asados-web:candidate'], {
      FAKE_DOCKER_COMPOSE_CONFIG_OUTPUT: composeOmitted,
      FAKE_DOCKER_INSPECT_OUTPUT: makeInspectFixture(sb.opRoot),
    })
    expect(ret.status).toBe(0)
    expect(JSON.parse(ret.stdout.trim()).networks).toEqual(['asados_default'])
    expect(readFileSync(sb.spyLog, 'utf8').trim().split('\n')).toEqual([
      SPY_PS(), SPY_INSPECT(), SPY_IMAGE(), SPY_COMPOSE(sb.opRoot), SPY_NET(),
    ])
  })

  it('permits custom explicit network name with full runtime and inspect crosscheck', () => {
    sb = createSandbox()
    const composeCustom = JSON.stringify({
      services: { web: { ports: [{ target: 3000, published: 3020, host_ip: '127.0.0.1', protocol: 'tcp' }], networks: { custom_net: { aliases: ['asados-web', 'crm-sofia-web'] } } } },
      networks: { custom_net: { name: 'corp_internal_web' } },
    })
    const ret = sb.runHelper(['--root', sb.opRoot, '--action', 'inspect-resources', '--candidate-image', 'asados-web:candidate'], {
      FAKE_DOCKER_COMPOSE_CONFIG_OUTPUT: composeCustom,
      FAKE_DOCKER_INSPECT_OUTPUT: makeInspectFixture(sb.opRoot, {}, {
        NetworkSettings: { Networks: { corp_internal_web: { NetworkID: FIXTURE_NETWORK_ID, Aliases: ['asados-web', 'crm-sofia-web'] } } },
      }),
      FAKE_DOCKER_NETWORK_INSPECT_OUTPUT: JSON.stringify([{ Id: FIXTURE_NETWORK_ID, Name: 'corp_internal_web', Labels: { 'com.docker.compose.project': 'asados' } }]),
    })
    expect(ret.status).toBe(0)
    expect(JSON.parse(ret.stdout.trim()).networks).toEqual(['corp_internal_web'])
    expect(readFileSync(sb.spyLog, 'utf8').trim().split('\n')).toEqual([
      SPY_PS(), SPY_INSPECT(), SPY_IMAGE(), SPY_COMPOSE(sb.opRoot), SPY_NET(),
    ])
  })

  it.each([
    ['missing expected network', { NetworkSettings: { Networks: { other_net: { NetworkID: FIXTURE_NETWORK_ID, Aliases: ['asados-web', 'crm-sofia-web'] } } } }, {}, 'container networks mismatch', false],
    ['invalid network id', { NetworkSettings: { Networks: { asados_default: { NetworkID: 'bad-id', Aliases: ['asados-web', 'crm-sofia-web'] } } } }, {}, 'invalid container network id', false],
    ['runtime aliases non-string', { NetworkSettings: { Networks: { asados_default: { NetworkID: FIXTURE_NETWORK_ID, Aliases: [123] } } } }, {}, 'invalid container network aliases', false],
    ['runtime aliases unhashable dict', { NetworkSettings: { Networks: { asados_default: { NetworkID: FIXTURE_NETWORK_ID, Aliases: [{}] } } } }, {}, 'invalid container network aliases', false],
    ['missing declared alias', { NetworkSettings: { Networks: { asados_default: { NetworkID: FIXTURE_NETWORK_ID, Aliases: ['asados-web'] } } } }, {}, 'container network aliases mismatch', false],
    ['network inspect id mismatch', {}, { FAKE_DOCKER_NETWORK_INSPECT_OUTPUT: JSON.stringify([{ Id: 'b'.repeat(64), Name: 'asados_default', Labels: { 'com.docker.compose.project': 'asados' } }]) }, 'network inspect metadata mismatch', true],
    ['network inspect name mismatch', {}, { FAKE_DOCKER_NETWORK_INSPECT_OUTPUT: JSON.stringify([{ Id: FIXTURE_NETWORK_ID, Name: 'wrong_net', Labels: { 'com.docker.compose.project': 'asados' } }]) }, 'network inspect metadata mismatch', true],
    ['network project label mismatch', {}, { FAKE_DOCKER_NETWORK_INSPECT_OUTPUT: JSON.stringify([{ Id: FIXTURE_NETWORK_ID, Name: 'asados_default', Labels: { 'com.docker.compose.project': 'other' } }]) }, 'network project ownership mismatch', true],
  ])('rejects network drift, ownership, and aliases mismatch: %s', (_, ctr, env, err, ranNetInspect) => {
    sb = createSandbox()
    const ret = sb.runHelper(['--root', sb.opRoot, '--action', 'inspect-resources', '--candidate-image', 'asados-web:candidate'], {
      FAKE_DOCKER_INSPECT_OUTPUT: makeInspectFixture(sb.opRoot, {}, ctr), ...env,
    })
    const expectedSpies = [SPY_PS(), SPY_INSPECT(), SPY_IMAGE(), SPY_COMPOSE(sb.opRoot)]
    if (ranNetInspect) expectedSpies.push(SPY_NET())
    expectHelperError(ret, err, expectedSpies)
  })

  it.each([
    ['non-amd64 architecture', { FAKE_DOCKER_IMAGE_INSPECT_OUTPUT: JSON.stringify([{ Id: FIXTURE_CANDIDATE_IMAGE_ID, Architecture: 'arm64', Os: 'linux' }]) }, 'invalid candidate image architecture or os'],
    ['non-linux os', { FAKE_DOCKER_IMAGE_INSPECT_OUTPUT: JSON.stringify([{ Id: FIXTURE_CANDIDATE_IMAGE_ID, Architecture: 'amd64', Os: 'windows' }]) }, 'invalid candidate image architecture or os'],
    ['invalid image id format', { FAKE_DOCKER_IMAGE_INSPECT_OUTPUT: JSON.stringify([{ Id: 'not-sha256', Architecture: 'amd64', Os: 'linux' }]) }, 'invalid candidate image id'],
  ])('rejects candidate image metadata drift: %s', (_, env, err) => {
    sb = createSandbox()
    const ret = sb.runHelper(['--root', sb.opRoot, '--action', 'inspect-resources', '--candidate-image', 'asados-web:candidate'], {
      FAKE_DOCKER_INSPECT_OUTPUT: makeInspectFixture(sb.opRoot), ...env,
    })
    expectHelperError(ret, err, [SPY_PS(), SPY_INSPECT(), SPY_IMAGE()])
  })

  it.each([
    ['image inspect', { FAKE_DOCKER_IMAGE_EXIT: '1', FAKE_DOCKER_IMAGE_STDERR: 'image_not_found' }, 'image_not_found', 'image'],
    ['compose', { FAKE_DOCKER_COMPOSE_EXIT: '1', FAKE_DOCKER_COMPOSE_STDERR: 'compose_syntax_error' }, 'compose_syntax_error', 'compose'],
    ['network inspect', { FAKE_DOCKER_NETWORK_EXIT: '1', FAKE_DOCKER_NETWORK_STDERR: 'network_not_found' }, 'network_not_found', 'network'],
  ])('fails scoped at %s stage asserting exact error and terminal spy', (_, env, marker, stage) => {
    sb = createSandbox()
    const ret = sb.runHelper(['--root', sb.opRoot, '--action', 'inspect-resources', '--candidate-image', 'asados-web:candidate'], {
      FAKE_DOCKER_INSPECT_OUTPUT: makeInspectFixture(sb.opRoot), ...env,
    })
    expect(ret.stdout + ret.stderr).not.toContain(marker)
    const spies = [SPY_PS(), SPY_INSPECT(), SPY_IMAGE()]
    if (stage === 'compose' || stage === 'network') spies.push(SPY_COMPOSE(sb.opRoot))
    if (stage === 'network') spies.push(SPY_NET())
    expectHelperError(ret, 'docker command execution failed', spies)
  })

  it.each([
    ['malformed compose json', { FAKE_DOCKER_COMPOSE_CONFIG_OUTPUT: '{bad-json' }, 'malformed compose config json'],
    ['malformed image inspect json', { FAKE_DOCKER_IMAGE_INSPECT_OUTPUT: 'not-json' }, 'malformed image inspect json'],
    ['malformed network inspect json', { FAKE_DOCKER_NETWORK_INSPECT_OUTPUT: 'not-json' }, 'malformed network inspect json'],
    ['missing web service in compose', { FAKE_DOCKER_COMPOSE_CONFIG_OUTPUT: JSON.stringify({ services: {} }) }, 'web service missing in compose config'],
  ])('sanitizes docker failures and malformed outputs: %s', (_, env, err) => {
    sb = createSandbox()
    const ret = sb.runHelper(['--root', sb.opRoot, '--action', 'inspect-resources', '--candidate-image', 'asados-web:candidate'], {
      FAKE_DOCKER_INSPECT_OUTPUT: makeInspectFixture(sb.opRoot), ...env,
    })
    const isImage = (err as string).includes('image')
    const expectedSpies = [SPY_PS(), SPY_INSPECT(), SPY_IMAGE()]
    if (!isImage) expectedSpies.push(SPY_COMPOSE(sb.opRoot))
    if ((err as string).includes('network')) expectedSpies.push(SPY_NET())
    expectHelperError(ret, err, expectedSpies)
    expect(ret.stdout + ret.stderr).not.toContain('Traceback')
  })
})
