import { describe, expect, it, afterEach } from 'vitest'
import { readFileSync, writeFileSync } from 'node:fs'
import {
  createSandbox, FIXTURE_ID, FIXTURE_CANDIDATE_IMAGE_ID,
  FIXTURE_NETWORK_ID, Sandbox,
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
      status: 'error', error: 'resource validation and generation deferred to S3; activation is unsupported',
    })
    expect(readFileSync(sb.spyLog, 'utf8').trim()).toBe('')
  })
})
