import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * Regression guard for issue #197, seed-data half: the migration
 * `20260920040000_retire_old_brand_from_seed_data.sql` must strip the retired
 * business identity, neighbourhood and city from the customer-visible copy that
 * lives in the database, without damaging that copy.
 *
 * Independent verification found the previous shape corrupted the Janelas de
 * Retirada article body. The nested chain replaced only the tail fragment
 * `no Umbará, Ganchinho, Sítio Cercado e Pinheirinho` with `em um raio de até
 * 5 km`, while the source sentence already carried `em um raio de até 5 km`
 * immediately before it, so the customer read
 * `em um raio de até 5 km em um raio de até 5 km`.
 *
 * Why a source-level test instead of executing the migration: running it needs a
 * live PostgreSQL instance with 20260816260000 and 20260828160000 already
 * applied, which is deliberately outside this task. The honest contract here is
 * the transformation itself, so the test interprets the migration's own
 * `replace`, exact-rename and tag statements and applies them, in order, to the
 * verbatim historical rows read from the migrations that wrote them.
 */

const MIGRATION = 'supabase/migrations/20260920040000_retire_old_brand_from_seed_data.sql'
const ORIGINAL_SEED = 'supabase/migrations/20260816260000_seed_combos_e_base_conhecimento_oficial.sql'
const CURRENT_SEED = 'supabase/migrations/20260828160000_update_brand_and_combos_brasa_sabor.sql'
const HOURS_SEED = 'supabase/migrations/20260708000000_estoque_horarios.sql'

/** Business identity, neighbourhood and city the brand sweep retires from copy. */
const RETIRED_COPY = ['Asados', 'Casa de Assados', 'Brasa & Sabor', 'Umbará', 'Umbar', 'Curitiba']
const RADIUS = 'em um raio de até 5 km'
const JANELAS_BODY_MARKER = 'Casa de Assados'
const COMBO4_CITY_MARKER = 'custo-benefício de Curitiba'

const read = (path: string) => readFileSync(path, 'utf8')

function expectNoRetiredCopy(text: string, label: string) {
  for (const token of RETIRED_COPY) {
    expect(text, `${label} must not keep "${token}"`).not.toContain(token)
  }
}

/** `--` comment lines carry prose (including retired strings), never statements. */
function withoutComments(sql: string): string {
  return sql
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n')
}

const migration = withoutComments(read(MIGRATION))
const originalSeed = read(ORIGINAL_SEED)
const currentSeed = read(CURRENT_SEED)
const hoursSeed = read(HOURS_SEED)

function extract(sql: string, pattern: RegExp, label: string): string {
  const match = sql.match(pattern)
  if (!match) throw new Error(`historical fixture not found: ${label}`)
  return match[1]
}

function parseSqlStringArray(literal: string): string[] {
  return [...literal.matchAll(/'((?:[^']|'')*)'/g)].map((match) => match[1].replaceAll("''", "'"))
}

/** Verbatim historical fixture: article body as written by 20260816260000. */
const janelasBodyOriginal = extract(
  originalSeed,
  /'(A Casa de Assados Sofia opera[\s\S]*?)'/,
  'Janelas body from 20260816260000',
)
/** Verbatim historical fixture: same article body as rewritten by 20260828160000. */
const janelasBodyCurrent = extract(
  currentSeed,
  /'(A Casa de Assados Brasa & Sabor opera[\s\S]*?)'/,
  'Janelas body from 20260828160000',
)
const janelasTitleOriginal = extract(
  originalSeed,
  /'(Janelas de Retirada[^']*)'/,
  'Janelas title from 20260816260000',
)
const janelasTagsOriginal = parseSqlStringArray(
  extract(originalSeed, /(ARRAY\[[^\]]*'umbara'[^\]]*\])/, 'Janelas tags from 20260816260000'),
)
const combo4BodyOriginal = extract(
  originalSeed,
  /'(O Combo 4 \(Kit Churrasco[^']*)'/,
  'Combo 4 body from 20260816260000',
)
const outOfHoursMessage = (() => {
  const start = hoursSeed.indexOf('Olá! 😊 Agora estamos fora')
  const anchor = 'Equipe Asados ❤️'
  expect(start, 'out-of-hours message must exist in 20260708000000').toBeGreaterThanOrEqual(0)
  return hoursSeed.slice(start, hoursSeed.indexOf(anchor) + anchor.length)
})()

/** Statements of the migration under test, comments removed. */
function statements(sql: string): string[] {
  return sql
    .split(';')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0)
}

/** The single guarded update on `table` whose text contains `marker`. */
function guardedUpdate(table: string, marker: string): string {
  const matches = statements(migration).filter(
    (statement) => statement.startsWith(`update ${table}`) && statement.includes(marker),
  )
  expect(matches, `expected exactly one guarded update on ${table} matching "${marker}"`).toHaveLength(1)
  return matches[0]
}

/** The `set` clause of an update statement, without its `where` guard. */
function setClause(statement: string): string {
  expect(statement, 'a data update must be guarded by a where clause').toContain(' where ')
  return statement.split(/\s+where\s+/)[0]
}

type Replacement = { from: string; to: string }

/** Ordered `replace(<subject>, 'from', 'to')` pairs of a nested replacement chain. */
function replacementChain(statement: string): Replacement[] {
  const pairs: Replacement[] = []
  for (const match of setClause(statement).matchAll(/'((?:[^']|'')*)'\s*,\s*'((?:[^']|'')*)'/g)) {
    pairs.push({ from: match[1].replaceAll("''", "'"), to: match[2].replaceAll("''", "'") })
  }
  return pairs
}

/** Ordered replacement pairs of every guarded update on `table`, optionally by marker. */
function replacementChains(table: string, marker?: string): Replacement[] {
  const targets = statements(migration).filter(
    (statement) =>
      statement.startsWith(`update ${table}`) && (marker === undefined || statement.includes(marker)),
  )
  expect(targets, `expected at least one guarded update on ${table}`).not.toHaveLength(0)
  return targets.flatMap((statement) => replacementChain(statement))
}

/** SQL `replace` replaces every occurrence, exactly like split/join. */
function applyChain(input: string, chain: Replacement[]): string {
  return chain.reduce((text, { from, to }) => text.split(from).join(to), input)
}

type RenameRule = { table: string; column: string; from: string; to: string }

/** `update <table> set <col> = 'new' where <col> = 'old'` rules. */
function renameRules(sql: string): RenameRule[] {
  const pattern =
    /update\s+(public\.\w+)\s+set\s+(\w+)\s*=\s*'((?:[^']|'')*)'\s+where\s+\2\s*=\s*'((?:[^']|'')*)'/g
  return [...sql.matchAll(pattern)].map((match) => ({
    table: match[1],
    column: match[2],
    from: match[4].replaceAll("''", "'"),
    to: match[3].replaceAll("''", "'"),
  }))
}

function applyRenames(column: string, value: string): string {
  return renameRules(migration).reduce(
    (current, rule) => (rule.column === column && rule.from === current ? rule.to : current),
    value,
  )
}

type TagRule = { kind: 'replace'; from: string; to: string } | { kind: 'remove'; value: string }

/** `array_replace(tags, ...)` and `array_remove(tags, ...)` rules, in statement order. */
function tagRules(): TagRule[] {
  const rules: TagRule[] = []
  const updates = statements(migration).filter((statement) =>
    statement.startsWith('update public.base_conhecimento'),
  )
  for (const statement of updates) {
    const clause = setClause(statement)
    for (const match of clause.matchAll(/array_replace\(\s*tags\s*,\s*'([^']*)'\s*,\s*'([^']*)'\s*\)/g)) {
      rules.push({ kind: 'replace', from: match[1], to: match[2] })
    }
    for (const match of clause.matchAll(/array_remove\(\s*tags\s*,\s*'([^']*)'\s*\)/g)) {
      rules.push({ kind: 'remove', value: match[1] })
    }
  }
  return rules
}

function applyTagRules(tags: string[], rules: TagRule[]): string[] {
  return rules.reduce((current, rule) => {
    if (rule.kind === 'replace') return current.map((tag) => (tag === rule.from ? rule.to : tag))
    return current.filter((tag) => tag !== rule.value)
  }, tags)
}

describe('seed-data brand retirement migration (#197)', () => {
  it('exposes both historical Janelas article variants as fixtures', () => {
    expect(janelasBodyOriginal).toContain('A Casa de Assados Sofia opera')
    expect(janelasBodyCurrent).toContain('A Casa de Assados Brasa & Sabor opera')
    expect(janelasBodyOriginal).toContain('no balcão no Umbará')
    expect(janelasBodyCurrent).toContain(`${RADIUS} no Umbará, Ganchinho, Sítio Cercado e Pinheirinho`)
    expect(outOfHoursMessage).toContain('Equipe Asados')
    expect(outOfHoursMessage).toContain('churrasco de Curitiba')
  })

  it('transforms both Janelas article variants into retired-copy-free client copy', () => {
    const chain = replacementChains('public.base_conhecimento', JANELAS_BODY_MARKER)

    for (const [label, fixture] of [
      ['20260816260000', janelasBodyOriginal],
      ['20260828160000', janelasBodyCurrent],
    ] as const) {
      const transformed = applyChain(fixture, chain)

      expectNoRetiredCopy(transformed, `Janelas body from ${label}`)
      expect(transformed, `Janelas body from ${label}`).toContain(
        'Este ambiente de demonstração opera com o modelo inovador de Pré-Venda',
      )
      expect(transformed).toContain('no balcão de retirada em menos de 90 segundos')
      expect(transformed).toContain('chegando quentinho a mais de 65°C')
      expect(transformed).toContain('Janelas de Retirada de 15 minutos')
    }
  })

  it('keeps exactly one delivery radius instead of duplicating the phrase', () => {
    const chain = replacementChains('public.base_conhecimento', JANELAS_BODY_MARKER)

    for (const fixture of [janelasBodyOriginal, janelasBodyCurrent]) {
      const transformed = applyChain(fixture, chain)

      expect(transformed.match(new RegExp(RADIUS, 'g'))).toHaveLength(1)
      expect(transformed).not.toContain(`${RADIUS} ${RADIUS}`)
      expect(transformed).not.toMatch(/raio de até 5 km em um raio de até 5 km/i)
    }
  })

  it('converges both historical variants onto the same client copy', () => {
    const chain = replacementChains('public.base_conhecimento', JANELAS_BODY_MARKER)

    expect(applyChain(janelasBodyOriginal, chain)).toBe(applyChain(janelasBodyCurrent, chain))
  })

  it('reproduces the defect that shipped, so the duplication guard is not vacuous', () => {
    const shippedDefect: Replacement[] = [
      { from: 'A Casa de Assados Brasa & Sabor opera', to: 'Este ambiente de demonstração adota' },
      { from: 'A Casa de Assados Sofia opera', to: 'Este ambiente de demonstração adota' },
      { from: 'no balcão no Umbará', to: 'no balcão de retirada' },
      { from: 'no Umbará, Ganchinho, Sítio Cercado e Pinheirinho', to: RADIUS },
    ]

    const corrupted = applyChain(janelasBodyCurrent, shippedDefect)

    expect(corrupted).toContain(`${RADIUS} ${RADIUS}`)
    expect(corrupted.match(new RegExp(RADIUS, 'g'))).toHaveLength(2)
  })

  it('removes Curitiba from the Janelas title through an exact-equality rename', () => {
    const transformed = applyRenames('titulo', janelasTitleOriginal)

    expect(transformed).toBe('Janelas de Retirada (Takeaway) e Delivery Próprio')
    expectNoRetiredCopy(transformed, 'Janelas title')
    expect(transformed).toContain('Janelas de Retirada')
  })

  it('removes Curitiba from the Combo 4 article body with a full-fragment replacement', () => {
    const chain = replacementChains('public.base_conhecimento', COMBO4_CITY_MARKER)
    const transformed = applyChain(combo4BodyOriginal, chain)

    expectNoRetiredCopy(transformed, 'Combo 4 body')
    expect(transformed).toContain('com o melhor custo-benefício')
    expect(transformed).toContain('O Combo 4 (Kit Churrasco Família) custa R$ 169,90')
  })

  it('removes the retired brand and Curitiba from the out-of-hours customer message', () => {
    const chain = replacementChains('public.configuracoes_sistema')
    const transformed = applyChain(outOfHoursMessage, chain)

    expectNoRetiredCopy(transformed, 'MENSAGEM_FORA_HORARIO')
    expect(transformed).toContain('Equipe de Atendimento')
    expect(transformed).toContain('o melhor churrasco!')
    expect(transformed).toContain('{dias_semana}')
  })

  it('drops the retired neighbourhood and city from the Janelas tags', () => {
    const transformed = applyTagRules(janelasTagsOriginal, tagRules())

    expectNoRetiredCopy(transformed.join(' '), 'Janelas tags')
    expect(transformed).not.toContain('umbara')
    expect(transformed).not.toContain('curitiba')
    expect(transformed).toEqual(
      expect.arrayContaining(['horários', 'retirada', 'delivery', 'agendamento', 'sem fila', 'demonstracao']),
    )
    expect(new Set(transformed).size, 'tags must not be duplicated').toBe(transformed.length)
  })

  it('replaces the whole delivery-radius fragment instead of only its tail', () => {
    const statement = guardedUpdate('public.base_conhecimento', JANELAS_BODY_MARKER).replace(/\s+/g, ' ')

    expect(statement).toContain(
      `'${RADIUS} no Umbará, Ganchinho, Sítio Cercado e Pinheirinho', '${RADIUS}'`,
    )
    expect(statement).not.toMatch(/'no Umbará, Ganchinho, Sítio Cercado e Pinheirinho', 'em um raio/)
    expect(statement).toContain("where conteudo like '%Casa de Assados%'")
  })

  it('guards every data update so the migration stays forward-only and idempotent', () => {
    const updates = statements(migration).filter((statement) => /^update\s/.test(statement))
    expect(updates.length).toBeGreaterThan(0)

    for (const statement of updates) {
      expect(statement, `unguarded update: ${statement.split('\n')[0]}`).toMatch(/\bwhere\b/)
    }

    const bodyUpdates = updates.filter((entry) => /set conteudo = replace\(/.test(entry))
    expect(bodyUpdates.length, 'article bodies must be rewritten').toBeGreaterThan(0)
    for (const bodyUpdate of bodyUpdates) {
      expect(bodyUpdate.replace(/\s+/g, ' ')).toMatch(/ where conteudo like '%/)
    }

    const chain = replacementChains('public.base_conhecimento', JANELAS_BODY_MARKER)
    const once = applyChain(janelasBodyCurrent, chain)
    expect(applyChain(once, chain), 'a second pass must be a no-op').toBe(once)
  })
})
