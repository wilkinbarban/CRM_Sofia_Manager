/**
 * A1a Docker Dispatcher Unit 2 test suite: lifecycle transitions & dynamic inspect reflection contracts.
 * Part of 2-unit A1a partition:
 * - Unit 1: Readonly queries, strict query argv enforcement, and bad compose up denials.
 * - Unit 2 (this suite): Lifecycle state transitions (compose candidate/rollback up, manual state changes,
 *   and dynamic Image/Config.Image inspect reflections).
 *
 * RESTORATION & PROVENANCE MAPPING:
 * Full backup baseline (269 lines, SHA256 ab9aef6f3dbe451a5cfa8f8ef212418e06ab46c69d4278996e0e966e4bb9eefc):
 * /home/wilkin/proyectos/CRM_Sofia_Manager-web-deploy-safety-artifacts/A1a-pre-query-partition-20261007T080614024513/web-docker-dispatcher.test.ts
 *
 * Old backup lines 127-203 restored completely:
 * - Initial state assertion: getCurrentImageId, getCurrentConfigImage, {{.Image}}, {{.Config.Image}}.
 * - Candidate up transition: 8 tokens, getCurrentImageId, getCurrentConfigImage, {{.Image}}, {{.Config.Image}}, config JSON services.web.image.
 * - Rollback up transition: 8 tokens, getCurrentImageId, getCurrentConfigImage, {{.Image}}, {{.Config.Image}}, config JSON services.web.image.
 * - Manual state mutators: setCurrentImageId, setCurrentConfigImage, verified via inspect and manual rollback assertions.
 * - Invariant protection & negative vectors: wrong service ('other'), bare up, extra trailing tokens, malformed flags.
 */
import { describe, expect, it, afterEach } from 'vitest'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import type {
  DockerDispatcher,
  WebDockerDispatcherHelper,
} from '../helpers/web-docker-dispatcher'

type ExtendedDockerDispatcher = DockerDispatcher & {
  setCurrentImageId?: (id: string) => void
  setCurrentConfigImage?: (image: string) => void
}

const HELPER_PATH = join(process.cwd(), 'tests/helpers/web-docker-dispatcher.ts')
const helperExists = existsSync(HELPER_PATH)
let helperModule: WebDockerDispatcherHelper | null = null

if (helperExists) {
  const helperUrl = pathToFileURL(HELPER_PATH).href
  helperModule = (await import(/* @vite-ignore */ helperUrl)) as WebDockerDispatcherHelper
}

function getHelper(): WebDockerDispatcherHelper {
  if (!helperExists || !helperModule) {
    throw new Error(
      `web-docker-dispatcher capability missing: ${HELPER_PATH} does not exist. ` +
      'Independent capability RED prerequisite: helper must be implemented before behavior contracts run.'
    )
  }
  return helperModule
}

let dispatcher: ExtendedDockerDispatcher | null = null

afterEach(() => {
  dispatcher = null
})

describe('web-docker-dispatcher A1a Unit 2: lifecycle state transitions and dynamic inspect reflections', () => {
  it('dynamically reflects inspect Image and Config.Image across compose candidate/rollback transitions and manual state change', () => {
    const {
      createDockerDispatcher,
      FIXTURE_INITIAL_IMAGE_ID,
      FIXTURE_CANDIDATE_IMAGE_ID,
      FIXTURE_INITIAL_CONFIG_IMAGE,
      FIXTURE_CANDIDATE_CONFIG_IMAGE,
    } = getHelper()
    dispatcher = createDockerDispatcher() as ExtendedDockerDispatcher

    // Initial state: exact match on Image and Config.Image
    expect(dispatcher.getCurrentImageId()).toBe(FIXTURE_INITIAL_IMAGE_ID)
    expect(dispatcher.getCurrentConfigImage()).toBe(FIXTURE_INITIAL_CONFIG_IMAGE)

    const initInspect = dispatcher.runDocker(['inspect', 'crm-sofia-web', '--format', '{{.Image}}'])
    expect(initInspect.status).toBe(0)
    expect(initInspect.stdout.trim()).toBe(FIXTURE_INITIAL_IMAGE_ID)

    const initCfgInspect = dispatcher.runDocker(['inspect', 'crm-sofia-web', '--format', '{{.Config.Image}}'])
    expect(initCfgInspect.status).toBe(0)
    expect(initCfgInspect.stdout.trim()).toBe(FIXTURE_INITIAL_CONFIG_IMAGE)

    // Compose candidate transition (compose candidate up)
    const candCompose = join(dispatcher.opRoot, 'candidate-compose.yml')
    const upRes = dispatcher.runDocker(['compose', '-f', candCompose, 'up', '-d', '--no-deps', '--force-recreate', 'web'])
    expect(upRes.status).toBe(0)
    expect(dispatcher.getCurrentImageId()).toBe(FIXTURE_CANDIDATE_IMAGE_ID)
    expect(dispatcher.getCurrentConfigImage()).toBe(FIXTURE_CANDIDATE_CONFIG_IMAGE)

    const candInspect = dispatcher.runDocker(['inspect', 'crm-sofia-web', '--format', '{{.Image}}'])
    expect(candInspect.status).toBe(0)
    expect(candInspect.stdout.trim()).toBe(FIXTURE_CANDIDATE_IMAGE_ID)

    const candCfgInspect = dispatcher.runDocker(['inspect', 'crm-sofia-web', '--format', '{{.Config.Image}}'])
    expect(candCfgInspect.status).toBe(0)
    expect(candCfgInspect.stdout.trim()).toBe(FIXTURE_CANDIDATE_CONFIG_IMAGE)

    const candCfgRes = dispatcher.runDocker(['compose', '-f', candCompose, 'config', '--format', 'json'])
    expect(candCfgRes.status).toBe(0)
    const candDoc = JSON.parse(candCfgRes.stdout)
    expect(candDoc.services.web.image).toBe(FIXTURE_CANDIDATE_CONFIG_IMAGE)

    // Compose rollback transition (compose rollback up)
    const rollCompose = join(dispatcher.opRoot, 'rollback-compose.yml')
    const rollRes = dispatcher.runDocker(['compose', '-f', rollCompose, 'up', '-d', '--no-deps', '--force-recreate', 'web'])
    expect(rollRes.status).toBe(0)
    expect(dispatcher.getCurrentImageId()).toBe(FIXTURE_INITIAL_IMAGE_ID)
    expect(dispatcher.getCurrentConfigImage()).toBe(FIXTURE_INITIAL_CONFIG_IMAGE)

    const rollInspect = dispatcher.runDocker(['inspect', 'crm-sofia-web', '--format', '{{.Image}}'])
    expect(rollInspect.status).toBe(0)
    expect(rollInspect.stdout.trim()).toBe(FIXTURE_INITIAL_IMAGE_ID)

    const rollCfgInspect = dispatcher.runDocker(['inspect', 'crm-sofia-web', '--format', '{{.Config.Image}}'])
    expect(rollCfgInspect.status).toBe(0)
    expect(rollCfgInspect.stdout.trim()).toBe(FIXTURE_INITIAL_CONFIG_IMAGE)

    const rollCfgRes = dispatcher.runDocker(['compose', '-f', rollCompose, 'config', '--format', 'json'])
    expect(rollCfgRes.status).toBe(0)
    const rollDoc = JSON.parse(rollCfgRes.stdout)
    expect(rollDoc.services.web.image).toBe(FIXTURE_INITIAL_CONFIG_IMAGE)

    // Preserve manual state change and rollback assertions
    if (typeof dispatcher.setCurrentImageId !== 'function' || typeof dispatcher.setCurrentConfigImage !== 'function') {
      expect.fail('manual state change capability (setCurrentImageId/setCurrentConfigImage) not implemented on dispatcher')
    }
    dispatcher.setCurrentImageId(FIXTURE_CANDIDATE_IMAGE_ID)
    dispatcher.setCurrentConfigImage(FIXTURE_CANDIDATE_CONFIG_IMAGE)
    expect(dispatcher.getCurrentImageId()).toBe(FIXTURE_CANDIDATE_IMAGE_ID)
    expect(dispatcher.getCurrentConfigImage()).toBe(FIXTURE_CANDIDATE_CONFIG_IMAGE)

    const manualInspect = dispatcher.runDocker(['inspect', 'crm-sofia-web', '--format', '{{.Image}}'])
    expect(manualInspect.status).toBe(0)
    expect(manualInspect.stdout.trim()).toBe(FIXTURE_CANDIDATE_IMAGE_ID)

    dispatcher.setCurrentImageId(FIXTURE_INITIAL_IMAGE_ID)
    dispatcher.setCurrentConfigImage(FIXTURE_INITIAL_CONFIG_IMAGE)
    expect(dispatcher.getCurrentImageId()).toBe(FIXTURE_INITIAL_IMAGE_ID)
    expect(dispatcher.getCurrentConfigImage()).toBe(FIXTURE_INITIAL_CONFIG_IMAGE)

    const manualRollback = dispatcher.runDocker(['inspect', 'crm-sofia-web', '--format', '{{.Image}}'])
    expect(manualRollback.status).toBe(0)
    expect(manualRollback.stdout.trim()).toBe(FIXTURE_INITIAL_IMAGE_ID)
  })

  describe('lifecycle transition parameterization across custom identities', () => {
    interface IdentityCase {
      name: string
      initialImg: string
      initialCfg: string
      candidateImg: string
      candidateCfg: string
    }

    const identities: IdentityCase[] = [
      {
        name: 'default fixture identities',
        initialImg: 'sha256:1111111111111111111111111111111111111111111111111111111111111111',
        initialCfg: 'crm-sofia-web:current',
        candidateImg: 'sha256:2222222222222222222222222222222222222222222222222222222222222222',
        candidateCfg: 'crm-sofia-web:candidate',
      },
      {
        name: 'custom build identities',
        initialImg: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        initialCfg: 'custom-sofia-web:v1.0.0',
        candidateImg: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        candidateCfg: 'custom-sofia-web:v1.0.1',
      },
    ]

    it.each(identities)('executes full up transition cycle for $name', ({ initialImg, initialCfg, candidateImg, candidateCfg }) => {
      const helper = getHelper()
      const d = helper.createDockerDispatcher({
        initialImageId: initialImg,
        initialConfigImage: initialCfg,
        candidateImageId: candidateImg,
        candidateConfigImage: candidateCfg,
      })

      expect(d.getCurrentImageId()).toBe(initialImg)
      expect(d.getCurrentConfigImage()).toBe(initialCfg)

      const candCompose = join(d.opRoot, 'candidate-compose.yml')
      const upRes = d.runDocker(['compose', '-f', candCompose, 'up', '-d', '--no-deps', '--force-recreate', 'web'])
      expect(upRes.status).toBe(0)
      expect(d.getCurrentImageId()).toBe(candidateImg)
      expect(d.getCurrentConfigImage()).toBe(candidateCfg)

      const rollCompose = join(d.opRoot, 'rollback-compose.yml')
      const rollRes = d.runDocker(['compose', '-f', rollCompose, 'up', '-d', '--no-deps', '--force-recreate', 'web'])
      expect(rollRes.status).toBe(0)
      expect(d.getCurrentImageId()).toBe(initialImg)
      expect(d.getCurrentConfigImage()).toBe(initialCfg)
    })
  })

  describe('strict transition rejection & state invariance on invalid up invocations', () => {
    const invalidUpVectors: Array<[string, (root: string) => string[]]> = [
      ['bare up without flags or service', (root) => ['compose', '-f', join(root, 'candidate-compose.yml'), 'up']],
      ["wrong service literal 'other'", (root) => ['compose', '-f', join(root, 'candidate-compose.yml'), 'up', '-d', '--no-deps', '--force-recreate', 'other']],
      ['trailing extra token on valid up', (root) => ['compose', '-f', join(root, 'candidate-compose.yml'), 'up', '-d', '--no-deps', '--force-recreate', 'web', 'extra']],
      ['unrecognized compose file path', () => ['compose', '-f', '/foreign/path/compose.yml', 'up', '-d', '--no-deps', '--force-recreate', 'web']],
      ['missing --force-recreate flag', (root) => ['compose', '-f', join(root, 'candidate-compose.yml'), 'up', '-d', '--no-deps', 'web']],
    ]

    it.each(invalidUpVectors)('denies %s and preserves current state without mutation', (_name, getArgv) => {
      const helper = getHelper()
      const d = helper.createDockerDispatcher()

      const baseImg = d.getCurrentImageId()
      const baseCfg = d.getCurrentConfigImage()

      const res = d.runDocker(getArgv(d.opRoot))
      expect(res.status).not.toBe(0)
      expect(res.stdout).toBe('')
      expect(res.stderr).toMatch(/deny/i)

      expect(d.getCurrentImageId()).toBe(baseImg)
      expect(d.getCurrentConfigImage()).toBe(baseCfg)
    })
  })
})
