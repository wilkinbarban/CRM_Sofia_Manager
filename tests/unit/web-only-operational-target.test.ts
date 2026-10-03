import { describe, expect, it, afterEach } from 'vitest'
import { readFileSync, symlinkSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { createSandbox, makeInspectFixture, FIXTURE_ID, FIXTURE_IMAGE, Sandbox } from '../helpers/web-target-sandbox'

let sb: Sandbox

afterEach(() => {
  sb?.cleanup()
})

describe('web-only-operational-target', () => {
  it('validates canonical web operational target and emits safe allowlist metadata', () => {
    sb = createSandbox()
    writeFileSync(join(sb.opRoot, '.env'), 'SECRET_MARKER=supersecret123\nPORT=3000\n')
    const ret = sb.runHelper(['--root', sb.opRoot, '--project', 'asados'], {
      FAKE_DOCKER_INSPECT_OUTPUT: makeInspectFixture(sb.opRoot),
    })
    expect(ret.status).toBe(0)
    const out = JSON.parse(ret.stdout.trim())
    expect(out).toEqual({
      status: 'ok',
      container_id: FIXTURE_ID,
      container_name: 'crm-sofia-web',
      image_id: FIXTURE_IMAGE,
      image_ref: 'crm-sofia-web:20261002',
      project: 'asados',
      service: 'web',
      working_dir: sb.opRoot,
      config_files: join(sb.opRoot, 'docker-compose.yml'),
      endpoint: 'unix:///var/run/docker.sock',
      env_file_present: true,
    })
    const allowedKeys = [
      'status', 'container_id', 'container_name', 'image_id', 'image_ref',
      'project', 'service', 'working_dir', 'config_files', 'endpoint', 'env_file_present',
    ]
    expect(Object.keys(out).sort()).toEqual(allowedKeys.sort())
    expect(ret.stdout).not.toContain('supersecret123')
    expect(ret.stderr).not.toContain('supersecret123')
    const spyLines = readFileSync(sb.spyLog, 'utf8').trim().split('\n')
    expect(spyLines).toEqual([
      `--host unix:///var/run/docker.sock ps -aq --filter label=com.docker.compose.project=asados --filter label=com.docker.compose.service=web | DOCKER_HOST=unix:///var/run/docker.sock | DOCKER_CONTEXT=none`,
      `--host unix:///var/run/docker.sock inspect ${FIXTURE_ID} | DOCKER_HOST=unix:///var/run/docker.sock | DOCKER_CONTEXT=none`,
    ])
  })

  it.each([
    ['CLI root alias and dot-segments', { useRawCliRoot: true }],
    ['working_dir label alias and dot-segments', { useRawWorkingDir: true }],
    ['config_files label symlink alias and dot-segments', { useRawConfigFile: true }],
    ['combined CLI root, working_dir label, and config_files label raw aliases', {
      useRawCliRoot: true,
      useRawWorkingDir: true,
      useRawConfigFile: true,
    }],
  ])('resolves canonical root and config for %s', (_, opts) => {
    sb = createSandbox()
    const aliasRoot = join(sb.dir, 'alias-op-root')
    symlinkSync(sb.opRoot, aliasRoot)
    mkdirSync(join(sb.opRoot, 'sub-dir'), { recursive: true })
    const rawRoot = `${aliasRoot}/./sub-dir/../`
    expect(rawRoot).toContain('/./')
    expect(rawRoot).toContain('/../')

    const aliasConfig = join(sb.dir, 'alias-compose.yml')
    symlinkSync(join(sb.opRoot, 'docker-compose.yml'), aliasConfig)
    mkdirSync(join(sb.dir, 'config-sub'), { recursive: true })
    const rawConfigFile = `${sb.dir}/./config-sub/../alias-compose.yml`
    expect(rawConfigFile).toContain('/./')
    expect(rawConfigFile).toContain('/../')

    const cliRoot = opts.useRawCliRoot ? rawRoot : sb.opRoot
    const workingDirLabel = opts.useRawWorkingDir ? rawRoot : sb.opRoot
    const configFileLabel = opts.useRawConfigFile ? rawConfigFile : join(sb.opRoot, 'docker-compose.yml')

    const ret = sb.runHelper(['--root', cliRoot, '--project', 'asados'], {
      FAKE_DOCKER_INSPECT_OUTPUT: makeInspectFixture(sb.opRoot, {
        'com.docker.compose.project.working_dir': workingDirLabel,
        'com.docker.compose.project.config_files': configFileLabel,
      }),
    })
    expect(ret.status).toBe(0)
    const out = JSON.parse(ret.stdout.trim())
    expect(out.working_dir).toBe(sb.opRoot)
    expect(out.config_files).toBe(join(sb.opRoot, 'docker-compose.yml'))
    const spyLines = readFileSync(sb.spyLog, 'utf8').trim().split('\n')
    expect(spyLines).toEqual([
      `--host unix:///var/run/docker.sock ps -aq --filter label=com.docker.compose.project=asados --filter label=com.docker.compose.service=web | DOCKER_HOST=unix:///var/run/docker.sock | DOCKER_CONTEXT=none`,
      `--host unix:///var/run/docker.sock inspect ${FIXTURE_ID} | DOCKER_HOST=unix:///var/run/docker.sock | DOCKER_CONTEXT=none`,
    ])
  })

  it('fails closed when conflicting DOCKER_CONTEXT is set before docker execution', () => {
    sb = createSandbox()
    const ret = sb.runHelper(['--root', sb.opRoot], { DOCKER_CONTEXT: 'remote-env' })
    expect(ret.status).not.toBe(0)
    const out = JSON.parse(ret.stdout.trim())
    expect(out).toEqual({ status: 'error', error: 'conflicting DOCKER_CONTEXT override rejected' })
    expect(readFileSync(sb.spyLog, 'utf8').trim()).toBe('')
  })

  it('fails closed when remote DOCKER_HOST is set via env or flag before docker execution', () => {
    sb = createSandbox()
    const retEnv = sb.runHelper(['--root', sb.opRoot], { DOCKER_HOST: 'tcp://10.0.0.1:2375' })
    expect(retEnv.status).not.toBe(0)
    expect(JSON.parse(retEnv.stdout.trim())).toEqual({ status: 'error', error: 'remote or non-unix DOCKER_HOST rejected' })
    expect(readFileSync(sb.spyLog, 'utf8').trim()).toBe('')

    const retArg = sb.runHelper(['--root', sb.opRoot, '--docker-host', 'tcp://10.0.0.1:2375'])
    expect(retArg.status).not.toBe(0)
    expect(JSON.parse(retArg.stdout.trim())).toEqual({ status: 'error', error: 'remote or non-unix docker host rejected' })
    expect(readFileSync(sb.spyLog, 'utf8').trim()).toBe('')
  })

  it('fails closed on working_dir mismatch with non-traceback json error', () => {
    sb = createSandbox()
    const ret = sb.runHelper(['--root', sb.opRoot], {
      FAKE_DOCKER_INSPECT_OUTPUT: makeInspectFixture(sb.opRoot, {
        'com.docker.compose.project.working_dir': '/other/root',
      }),
    })
    expect(ret.status).not.toBe(0)
    expect(JSON.parse(ret.stdout.trim())).toEqual({ status: 'error', error: 'container working directory mismatch' })
    expect(ret.stdout + ret.stderr).not.toContain('Traceback')
  })

  it('fails closed on config_files mismatch including multiple comma-separated config paths', () => {
    sb = createSandbox()
    const retSingle = sb.runHelper(['--root', sb.opRoot], {
      FAKE_DOCKER_INSPECT_OUTPUT: makeInspectFixture(sb.opRoot, {
        'com.docker.compose.project.config_files': '/other/docker-compose.yml',
      }),
    })
    expect(retSingle.status).not.toBe(0)
    expect(JSON.parse(retSingle.stdout.trim())).toEqual({ status: 'error', error: 'container config files mismatch' })

    const multiplePaths = `${join(sb.opRoot, 'docker-compose.yml')},${join(sb.opRoot, 'docker-compose.override.yml')}`
    const retMultiple = sb.runHelper(['--root', sb.opRoot], {
      FAKE_DOCKER_INSPECT_OUTPUT: makeInspectFixture(sb.opRoot, {
        'com.docker.compose.project.config_files': multiplePaths,
      }),
    })
    expect(retMultiple.status).not.toBe(0)
    expect(JSON.parse(retMultiple.stdout.trim())).toEqual({ status: 'error', error: 'container config files mismatch' })
  })

  it('fails closed on project mismatch', () => {
    sb = createSandbox()
    const ret = sb.runHelper(['--root', sb.opRoot, '--project', 'asados'], {
      FAKE_DOCKER_INSPECT_OUTPUT: makeInspectFixture(sb.opRoot, {
        'com.docker.compose.project': 'wrong-project',
      }),
    })
    expect(ret.status).not.toBe(0)
    expect(JSON.parse(ret.stdout.trim())).toEqual({ status: 'error', error: 'container project mismatch' })
  })

  it('fails closed on service mismatch and refuses non-web service argument', () => {
    sb = createSandbox()
    const retServiceArg = sb.runHelper(['--root', sb.opRoot, '--service', 'db'])
    expect(retServiceArg.status).toBe(2)
    expect(JSON.parse(retServiceArg.stdout.trim())).toEqual({
      status: 'error',
      error: 'only web service preflight supported in S2',
    })
    expect(readFileSync(sb.spyLog, 'utf8').trim()).toBe('')

    const retInspectMismatch = sb.runHelper(['--root', sb.opRoot], {
      FAKE_DOCKER_INSPECT_OUTPUT: makeInspectFixture(sb.opRoot, {
        'com.docker.compose.service': 'worker',
      }),
    })
    expect(retInspectMismatch.status).not.toBe(0)
    expect(JSON.parse(retInspectMismatch.stdout.trim())).toEqual({
      status: 'error',
      error: 'container service mismatch',
    })
  })

  it('fails closed when duplicate web containers are detected without hint but allows explicit hint bypass', () => {
    sb = createSandbox()
    const retNoHint = sb.runHelper(['--root', sb.opRoot], {
      FAKE_DOCKER_PS_OUTPUT: 'cid1\ncid2\n',
    })
    expect(retNoHint.status).not.toBe(0)
    expect(JSON.parse(retNoHint.stdout.trim())).toEqual({
      status: 'error',
      error: 'duplicate containers found for service',
    })
    const spyLinesNoHint = readFileSync(sb.spyLog, 'utf8').trim().split('\n')
    expect(spyLinesNoHint).toEqual([
      `--host unix:///var/run/docker.sock ps -aq --filter label=com.docker.compose.project=asados --filter label=com.docker.compose.service=web | DOCKER_HOST=unix:///var/run/docker.sock | DOCKER_CONTEXT=none`,
    ])
    expect(spyLinesNoHint.some((l) => l.includes('inspect'))).toBe(false)

    sb.cleanup()
    sb = createSandbox()
    const retWithHint = sb.runHelper(['--root', sb.opRoot, '--container', 'crm-sofia-web'], {
      FAKE_DOCKER_PS_OUTPUT: 'cid1\ncid2\n',
      FAKE_DOCKER_INSPECT_OUTPUT: makeInspectFixture(sb.opRoot),
    })
    expect(retWithHint.status).toBe(0)
    expect(JSON.parse(retWithHint.stdout.trim()).status).toBe('ok')
    const spyLinesWithHint = readFileSync(sb.spyLog, 'utf8').trim().split('\n')
    expect(spyLinesWithHint.some((l) => l.includes(' ps '))).toBe(false)
    expect(spyLinesWithHint).toEqual([
      `--host unix:///var/run/docker.sock inspect crm-sofia-web | DOCKER_HOST=unix:///var/run/docker.sock | DOCKER_CONTEXT=none`,
    ])
  })

  it('fails closed on malformed docker output with sanitized non-traceback error', () => {
    sb = createSandbox()
    const ret = sb.runHelper(['--root', sb.opRoot], {
      FAKE_DOCKER_INSPECT_OUTPUT: '{malformed_json',
    })
    expect(ret.status).not.toBe(0)
    expect(JSON.parse(ret.stdout.trim())).toEqual({
      status: 'error',
      error: 'malformed docker inspect json',
    })
    expect(ret.stdout + ret.stderr).not.toContain('Traceback')
  })

  it('rejects unsupported generation or activation with stable error code 2 before docker spy', () => {
    sb = createSandbox()
    const retGen = sb.runHelper(['--root', sb.opRoot, '--generate'])
    expect(retGen.status).toBe(2)
    expect(JSON.parse(retGen.stdout.trim())).toEqual({
      status: 'error',
      error: 'resource validation and generation deferred to S3; activation is unsupported',
    })

    const retAct = sb.runHelper(['--root', sb.opRoot, '--activate'])
    expect(retAct.status).toBe(2)
    expect(JSON.parse(retAct.stdout.trim())).toEqual({
      status: 'error',
      error: 'resource validation and generation deferred to S3; activation is unsupported',
    })

    const retAction = sb.runHelper(['--root', sb.opRoot, '--action', 'restart'])
    expect(retAction.status).toBe(2)
    expect(JSON.parse(retAction.stdout.trim())).toEqual({
      status: 'error',
      error: 'resource validation and generation deferred to S3; activation is unsupported',
    })

    expect(readFileSync(sb.spyLog, 'utf8').trim()).toBe('')
  })
})
