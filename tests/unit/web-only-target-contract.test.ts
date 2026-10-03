import { describe, expect, it, afterEach } from 'vitest'
import { writeFileSync, unlinkSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createSandbox, makeInspectFixture, FIXTURE_ID, FIXTURE_IMAGE, Sandbox } from '../helpers/web-target-sandbox'

let sb: Sandbox
afterEach(() => sb?.cleanup())

describe('web-only-target-contract', () => {
  it('validates canonical target with exact call sequence and sanitized context', () => {
    sb = createSandbox()
    const ret = sb.runHelper(['--root', sb.opRoot, '--project', 'asados'], {
      FAKE_DOCKER_INSPECT_OUTPUT: makeInspectFixture(sb.opRoot),
    })
    expect(ret.status).toBe(0)
    const out = JSON.parse(ret.stdout.trim())
    expect(out).toEqual({
      status: 'ok', container_id: FIXTURE_ID, container_name: 'crm-sofia-web',
      image_id: FIXTURE_IMAGE, image_ref: 'crm-sofia-web:20261002',
      project: 'asados', service: 'web', working_dir: sb.opRoot,
      config_files: join(sb.opRoot, 'docker-compose.yml'),
      endpoint: 'unix:///var/run/docker.sock', env_file_present: true,
    })
    expect(ret.stdout).not.toContain('PORT=3000')
    const spyLines = readFileSync(sb.spyLog, 'utf8').trim().split('\n')
    expect(spyLines).toEqual([
      `--host unix:///var/run/docker.sock ps -aq --filter label=com.docker.compose.project=asados --filter label=com.docker.compose.service=web | DOCKER_HOST=unix:///var/run/docker.sock | DOCKER_CONTEXT=none`,
      `--host unix:///var/run/docker.sock inspect ${FIXTURE_ID} | DOCKER_HOST=unix:///var/run/docker.sock | DOCKER_CONTEXT=none`,
    ])
  })

  it.each([
    ['working_dir', { 'com.docker.compose.project.working_dir': '/wrong' }, {}],
    ['empty working_dir', { 'com.docker.compose.project.working_dir': '' }, {}],
    ['config_files', { 'com.docker.compose.project.config_files': '/wrong.yml' }, {}],
    ['project', { 'com.docker.compose.project': 'wrong-project' }, {}],
    ['service', { 'com.docker.compose.service': 'wrong-service' }, {}],
    ['short ID', {}, { Id: '1234abcd' }],
    ['non-hex ID', {}, { Id: 'z'.repeat(64) }],
    ['newline ID', {}, { Id: FIXTURE_ID + '\n' }],
    ['numeric ID', {}, { Id: 123456 }],
    ['missing ID', {}, { Id: '' }],
    ['non-sha256 image', {}, { Image: 'asados-web:latest' }],
    ['newline image', {}, { Image: FIXTURE_IMAGE + '\n' }],
    ['non-string working_dir', { 'com.docker.compose.project.working_dir': 12345 }, {}],
  ])('rejects binding mismatch and invalid types for %s', (_, lbl, ctr) => {
    sb = createSandbox()
    const ret = sb.runHelper(['--root', sb.opRoot], {
      FAKE_DOCKER_INSPECT_OUTPUT: makeInspectFixture(sb.opRoot, lbl, ctr),
    })
    expect(ret.status).not.toBe(0)
    expect(JSON.parse(ret.stdout.trim()).status).toBe('error')
  })

  it.each([
    ['ps duplicates', { FAKE_DOCKER_PS_OUTPUT: 'cid1\ncid2' }],
    ['inspect duplicates', { FAKE_DOCKER_INSPECT_OUTPUT: JSON.stringify([{}, {}]) }],
    ['malformed JSON', { FAKE_DOCKER_INSPECT_OUTPUT: '{invalid' }],
    ['empty inspect', { FAKE_DOCKER_INSPECT_OUTPUT: '[]' }],
    ['non-dict record', { FAKE_DOCKER_INSPECT_OUTPUT: JSON.stringify(['str']) }],
    ['missing labels', { FAKE_DOCKER_INSPECT_OUTPUT: JSON.stringify([{ Config: {} }]) }],
  ])('rejects invalid docker outputs and duplicates for %s', (_, env) => {
    sb = createSandbox()
    const ret = sb.runHelper(['--root', sb.opRoot], env)
    expect(ret.status).not.toBe(0)
    expect(JSON.parse(ret.stdout.trim()).status).toBe('error')
  })

  it('rejects missing or ambiguous operational root files fail-closed', () => {
    sb = createSandbox()
    expect(sb.runHelper(['--root', join(sb.dir, 'missing-dir')]).status).not.toBe(0)
    unlinkSync(join(sb.opRoot, 'docker-compose.yml'))
    expect(sb.runHelper(['--root', sb.opRoot]).status).not.toBe(0)
    writeFileSync(join(sb.opRoot, 'docker-compose.yml'), '{}'); writeFileSync(join(sb.opRoot, 'docker-compose.yaml'), '{}')
    expect(sb.runHelper(['--root', sb.opRoot]).status).not.toBe(0)
    unlinkSync(join(sb.opRoot, 'docker-compose.yaml')); unlinkSync(join(sb.opRoot, '.env'))
    expect(sb.runHelper(['--root', sb.opRoot]).status).not.toBe(0)
  })

  it('asserts constant error payload on docker command timeout', () => {
    sb = createSandbox()
    const ret = sb.runHelper(['--root', sb.opRoot], { FAKE_DOCKER_DELAY: '11' })
    expect(ret.status).not.toBe(0)
    expect(JSON.parse(ret.stdout.trim())).toEqual({ status: 'error', error: 'docker command timed out' })
    expect(ret.stdout + ret.stderr).not.toContain('Traceback')
  }, 25000)

  it('sanitizes docker stderr failures and input markers without traceback', () => {
    sb = createSandbox()
    const rFail = sb.runHelper(['--root', sb.opRoot], { FAKE_DOCKER_EXIT: '1', FAKE_DOCKER_STDERR: 'secret' })
    expect(rFail.status).not.toBe(0); expect(rFail.stdout + rFail.stderr).not.toMatch(/secret|Traceback/)
    const rLabel = sb.runHelper(['--root', sb.opRoot], {
      FAKE_DOCKER_INSPECT_OUTPUT: makeInspectFixture(sb.opRoot, { 'com.docker.compose.service': 'labelsecret' }),
    })
    expect(rLabel.status).not.toBe(0); expect(rLabel.stdout + rLabel.stderr).not.toMatch(/labelsecret|Traceback/)
    const rArg = sb.runHelper(['--root', sb.opRoot, '--bad-flag', 'argsecret'])
    expect(rArg.status).toBe(2); expect(rArg.stdout + rArg.stderr).not.toMatch(/argsecret|Traceback/)
  })

  it.each([
    ['generate flag', ['--generate'], {}],
    ['activate flag', ['--activate'], {}],
    ['unknown action', ['--action', 'deploy'], {}],
    ['docker context override', [], { DOCKER_CONTEXT: 'remote' }],
    ['remote docker host env', [], { DOCKER_HOST: 'tcp://1.2.3.4:2375' }],
    ['remote docker host arg', ['--docker-host', 'tcp://1.2.3.4:2375'], {}],
  ])('early fails on unsupported %s before docker execution', (_, args, env) => {
    sb = createSandbox()
    const ret = sb.runHelper(args, env)
    expect(ret.status).not.toBe(0)
    expect(readFileSync(sb.spyLog, 'utf8').trim()).toBe('')
  })

  it('enforces exact positional docker mock arguments rejecting malformed invocations', () => {
    sb = createSandbox()
    const base = ['--host', 'unix:///var/run/docker.sock', 'ps', '-aq', '--filter', 'label=com.docker.compose.project=asados', '--filter', 'label=com.docker.compose.service=web']
    expect(sb.runDocker(base).status).toBe(0)
    expect(sb.runDocker([...base, '--extra']).status).not.toBe(0)
    expect(sb.runDocker([...base.slice(0, 5), 'label=com.docker.compose.project=asados --bad', ...base.slice(6)]).status).not.toBe(0)
    expect(sb.runDocker(['--host', 'tcp://1.2.3.4:2375', ...base.slice(2)]).status).not.toBe(0)
  })
})
