import type { Cohort, Mode, Result } from './manifest.ts'
import { random } from './manifest.ts'

export interface Tokens {
  uncachedInput: number
  cachedInput: number
  cacheWrite: number
  output: number
  reasoning: number
  total: number
}
export type Charges = {
  _tag: 'Recorded'
  amount: number
  currency: string
  receipts: string[]
} | {
  _tag: 'Unavailable'
  reason: string
}
export interface Usage {
  tokens: Tokens
  reasoningCategory: {
    _tag: 'Recorded'
  } | {
    _tag: 'Unavailable'
    reason: string
  }
  charges: Charges
  responses: {
    id: string
    completed: string | null
  }[]
}
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
function number(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
    throw new Error('Invalid exposed usage.')
  return value
}
export function parseUsage(jsonl: string, cutoff: string, namespace = ''): Result<Usage> {
  try {
    const boundary = Date.parse(cutoff)
    if (!Number.isFinite(boundary))
      throw new Error('Usage cutoff requires a valid timestamp.')
    const rows = new Map<string, {
      tokens: Tokens
      at: string | null
    }>()
    const receiptMap = new Map<string, {
      amount: number
      currency: string
      id: string
    }>()
    let missingReasoning = false
    for (const [index, line] of jsonl.split('\n').entries()) {
      if (!line.trim().startsWith('{'))
        continue
      const event = record(JSON.parse(line))
      const payload = record(event.payload)
      const part = record(event.part)
      const at = typeof event.timestamp === 'string' ? event.timestamp : typeof event._observedCompleted === 'string' ? event._observedCompleted : null
      if (event.type === 'recorder.invalid_json')
        throw new Error('Command output contains incomplete JSON. Exposed usage cannot be complete.')
      const recognized = ['provider_charge', 'token_usage_record', 'turn.completed', 'step_finish'].includes(String(event.type))
      if (recognized && (!at || !Number.isFinite(Date.parse(at))))
        throw new Error('Usage records require valid completion timestamps.')
      if (at && Date.parse(at) > boundary)
        continue
      if (event.type === 'provider_charge') {
        if (typeof event.currency !== 'string' || typeof event.receiptId !== 'string')
          throw new Error('Provider charge requires a currency and receipt.')
        const receipt = { amount: number(event.amount), currency: event.currency, id: event.receiptId }
        const prior = receiptMap.get(receipt.id)
        if (prior && (prior.amount !== receipt.amount || prior.currency !== receipt.currency))
          throw new Error('Conflicting provider charge receipt.')
        receiptMap.set(receipt.id, receipt)
      }
      let tokens: Tokens, id: string
      if (event.type === 'token_usage_record' || event.type === 'turn.completed') {
        const usage = record(event.type === 'token_usage_record' ? payload.usage : event.usage)
        if (usage.reasoning_output_tokens === undefined)
          missingReasoning = true
        const input = number(usage.input_tokens)
        const cachedInput = number(usage.cached_input_tokens)
        const cacheWrite = number(usage.cache_write_input_tokens ?? 0)
        const output = number(usage.output_tokens)
        const reasoning = number(usage.reasoning_output_tokens ?? 0)
        if (cachedInput + cacheWrite > input || reasoning > output)
          throw new Error('Usage subsets exceed their totals.')
        tokens = { uncachedInput: input - cachedInput - cacheWrite, cachedInput, cacheWrite, output, reasoning, total: input + output }
        if (event.type === 'token_usage_record' && typeof payload.response_id !== 'string')
          throw new Error('Native usage requires a response ID.')
        id = typeof payload.response_id === 'string' ? payload.response_id : `${namespace}turn-${index}`
      }
      else
        if (event.type === 'step_finish') {
          const usage = record(part.tokens)
          const cache = record(usage.cache)
          const uncachedInput = number(usage.input)
          const output = number(usage.output) + number(usage.reasoning)
          const cachedInput = number(cache.read)
          const cacheWrite = number(cache.write)
          const reasoning = number(usage.reasoning)
          tokens = { uncachedInput, output, cachedInput, cacheWrite, reasoning, total: uncachedInput + output + cachedInput + cacheWrite }
          if (usage.total !== undefined && usage.total !== tokens.total)
            throw new Error('OpenCode usage total disagrees with categories.')
          id = typeof part.id === 'string' ? part.id : `${namespace}step-${index}`
        }
        else {
          continue
        }
      rows.set(id, { tokens, at })
    }
    if (!rows.size)
      return { _tag: 'Err', message: 'No complete exposed response usage. Charges and token totals are unavailable.' }
    const tokens: Tokens = { uncachedInput: 0, cachedInput: 0, cacheWrite: 0, output: 0, reasoning: 0, total: 0 }
    for (const row of rows.values()) {
      for (const key of Object.keys(tokens) as (keyof Tokens)[])
        tokens[key] += row.tokens[key]
    }
    const receipts = [...receiptMap.values()]
    const currencies = new Set(receipts.map(r => r.currency))
    const charges: Charges = receipts.length && currencies.size === 1
      ? { _tag: 'Recorded', amount: receipts.reduce((n, r) => n + r.amount, 0), currency: receipts[0].currency, receipts: receipts.map(r => r.id) }
      : { _tag: 'Unavailable', reason: receipts.length ? 'Charge currencies differ.' : 'No actual provider charge receipts were recorded.' }
    return { _tag: 'Ok', value: { tokens, reasoningCategory: missingReasoning ? { _tag: 'Unavailable', reason: 'Some completed responses expose only combined output. Reasoning zero means unobserved, not measured zero.' } : { _tag: 'Recorded' }, charges, responses: [...rows.entries()].map(([id, row]) => ({ id, completed: row.at })) } }
  }
  catch (error) {
    return { _tag: 'Err', message: (error as Error).message }
  }
}
export function combineUsage(sources: Result<Usage>[]): Result<Usage> {
  const failure = sources.find(source => source._tag === 'Err')
  if (failure?._tag === 'Err')
    return failure
  const records = sources.flatMap(source => source._tag === 'Ok' ? [source.value] : [])
  if (!records.length)
    return { _tag: 'Err', message: 'No complete imported usage.' }
  const responses = records.flatMap(record => record.responses)
  const ids = responses.map(response => response.id)
  if (new Set(ids).size !== ids.length)
    return { _tag: 'Err', message: 'Imported phase files overlap response IDs.' }
  const tokens: Tokens = { uncachedInput: 0, cachedInput: 0, cacheWrite: 0, output: 0, reasoning: 0, total: 0 }
  for (const record of records) {
    for (const key of Object.keys(tokens) as (keyof Tokens)[])
      tokens[key] += record.tokens[key]
  }
  const charges = records.flatMap(record => record.charges._tag === 'Recorded' ? [record.charges] : [])
  const receipts = charges.flatMap(charge => charge.receipts)
  if (new Set(receipts).size !== receipts.length)
    return { _tag: 'Err', message: 'Imported phase files overlap provider receipts.' }
  return { _tag: 'Ok', value: { tokens, responses, reasoningCategory: records.every(record => record.reasoningCategory._tag === 'Recorded') ? { _tag: 'Recorded' } : { _tag: 'Unavailable', reason: 'Some imported phases expose combined output only.' }, charges: charges.length === records.length && new Set(charges.map(charge => charge.currency)).size === 1 ? { _tag: 'Recorded', amount: charges.reduce((sum, charge) => sum + charge.amount, 0), currency: charges[0].currency, receipts } : { _tag: 'Unavailable', reason: 'Actual charges are unavailable for some imported phases.' } } }
}
export interface AttemptMetric {
  task: string
  mode: Mode
  cohort: Cohort
  repeat: number
  attempt: number
  quality: 'passed' | 'failed' | 'refused' | 'unavailable'
  seconds: number
  setupSeconds?: number
  preparedSeconds?: number
  usage: { _tag: 'Recorded', value: Usage } | { _tag: 'Unavailable', reason: string }
}
export function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b)
  return s.length ? (s[Math.floor((s.length - 1) / 2)] + s[Math.floor(s.length / 2)]) / 2 : 0
}
function interval(workflows: {
  task: string
  seconds: number
}[], seed: number): {
  _tag: 'Recorded'
  low: number
  high: number
  method: string
} | {
  _tag: 'Unavailable'
  reason: string
} {
  const taskIds = [...new Set(workflows.map(w => w.task))].sort()
  if (workflows.length < 2)
    return { _tag: 'Unavailable', reason: 'At least two recorded workflows are required. One task cannot establish task generality.' }
  const rng = random(seed)
  const values: number[] = []
  for (let run = 0; run < 1000; run++) {
    const sampled: number[] = []
    for (let i = 0; i < taskIds.length; i++) {
      const rows = workflows.filter(w => w.task === taskIds[Math.floor(rng() * taskIds.length)]).sort((a, b) => a.seconds - b.seconds)
      for (let j = 0; j < rows.length; j++)
        sampled.push(rows[Math.floor(rng() * rows.length)].seconds)
    }
    values.push(median(sampled))
  }
  values.sort((a, b) => a - b)
  return { _tag: 'Recorded', low: values[25], high: values[974], method: '95% hierarchical task/workflow percentile bootstrap, 1000 draws; descriptive only.' }
}
function canonicalAttempts(rows: AttemptMetric[]): AttemptMetric[] {
  return [...rows].sort((a, b) => a.cohort.localeCompare(b.cohort) || a.mode.localeCompare(b.mode) || a.task.localeCompare(b.task) || a.repeat - b.repeat || a.attempt - b.attempt)
}
export function aggregateAttempts(input: AttemptMetric[], seed: number) {
  const rows = canonicalAttempts(input)
  const ids = rows.flatMap(row => row.usage._tag === 'Recorded' ? row.usage.value.responses.map(response => response.id) : [])
  const duplicateResponses = new Set(ids.filter((id, index) => ids.indexOf(id) !== index))
  const receiptIdsGlobal = rows.flatMap(row => row.usage._tag === 'Recorded' && row.usage.value.charges._tag === 'Recorded' ? row.usage.value.charges.receipts : [])
  const duplicateReceipts = new Set(receiptIdsGlobal.filter((id, index) => receiptIdsGlobal.indexOf(id) !== index))
  return [...new Set(rows.map(r => `${r.cohort}:${r.mode}`))].map((key) => {
    const all = rows.filter(r => `${r.cohort}:${r.mode}` === key)
    const workflows = [...new Set(all.map(r => `${r.task}:${r.repeat}`))].map(id => ({ id, task: all.find(r => `${r.task}:${r.repeat}` === id)!.task, rows: all.filter(r => `${r.task}:${r.repeat}` === id).sort((a, b) => a.attempt - b.attempt) }))
    const passed = workflows.filter(w => w.rows.at(-1)!.quality === 'passed')
    const durations = workflows.map(w => ({ task: w.task, seconds: w.rows.reduce((n, r) => n + r.seconds, 0) }))
    const observedTokens = all.flatMap(row => row.usage._tag === 'Recorded' ? [row.usage.value] : [])
    const overlappingResponses = observedTokens.flatMap(usage => usage.responses.map(response => response.id)).filter(id => duplicateResponses.has(id))
    const tokenTotal: Tokens = { uncachedInput: 0, cachedInput: 0, cacheWrite: 0, output: 0, reasoning: 0, total: 0 }
    for (const row of observedTokens) {
      for (const field of Object.keys(tokenTotal) as (keyof Tokens)[])
        tokenTotal[field] += row.tokens[field]
    }
    const receipts = observedTokens.flatMap(usage => usage.charges._tag === 'Recorded' ? [usage.charges] : [])
    const receiptIds = receipts.flatMap(r => r.receipts)
    const charges: Charges = receipts.length === all.length && new Set(receipts.map(r => r.currency)).size === 1 && new Set(receiptIds).size === receiptIds.length && !receiptIds.some(id => duplicateReceipts.has(id))
      ? { _tag: 'Recorded', amount: receipts.reduce((n, r) => n + r.amount, 0), currency: receipts[0].currency, receipts: receipts.flatMap(r => r.receipts) }
      : { _tag: 'Unavailable', reason: 'Actual provider charges are unavailable for one or more attempts.' }
    return {
      cohort: all[0].cohort,
      mode: all[0].mode,
      attempts: all.length,
      workflows: workflows.length,
      completedWorkflows: passed.length,
      failures: all.filter(r => r.quality === 'failed').length,
      refusals: all.filter(r => r.quality === 'refused').length,
      unavailable: all.filter(r => r.quality === 'unavailable').length,
      repairs: all.filter(r => r.attempt > 0).length,
      totalSeconds: all.reduce((n, r) => n + r.seconds, 0),
      medianWorkflowSeconds: median(durations.map(r => r.seconds)),
      medianSuccessfulWorkflowSeconds: passed.length ? median(passed.map(w => w.rows.reduce((n, r) => n + r.seconds, 0))) : null,
      firstUseSetupSeconds: all.reduce((n, r) => n + (r.setupSeconds ?? 0), 0),
      preparedUseSeconds: all.reduce((n, r) => n + (r.preparedSeconds ?? r.seconds), 0),
      uncertainty: interval(durations, seed),
      tokens: overlappingResponses.length ? { _tag: 'Unavailable' as const, reason: 'Completed responses have more than one attempt owner.', responseIds: [...new Set(overlappingResponses)] } : observedTokens.length === all.length ? { _tag: 'Recorded' as const, value: tokenTotal } : { _tag: 'Partial' as const, observed: tokenTotal, missingAttempts: all.length - observedTokens.length },
      charges,
    }
  })
}
export function pairAttempts(input: AttemptMetric[], seed: number) {
  const rows = canonicalAttempts(input)
  return [...new Set(rows.map(row => row.cohort))].map(cohort => ({ cohort, comparisons: (['forced', 'hybrid'] as const).map((mode) => {
    const keys = [...new Set(rows.filter(row => row.cohort === cohort).map(row => `${row.task}:${row.repeat}`))]
    const pairs = keys.map((key) => {
      const workflow = (selected: Mode) => rows.filter(row => row.cohort === cohort && row.mode === selected && `${row.task}:${row.repeat}` === key).sort((a, b) => a.attempt - b.attempt)
      const direct = workflow('direct')
      const treatment = workflow(mode)
      const initial = rows.find(row => row.cohort === cohort && `${row.task}:${row.repeat}` === key)!
      return { task: initial.task, repeat: initial.repeat, directQuality: direct.at(-1)?.quality ?? 'unavailable', treatmentQuality: treatment.at(-1)?.quality ?? 'unavailable', directSeconds: direct.reduce((sum, row) => sum + row.seconds, 0), treatmentSeconds: treatment.reduce((sum, row) => sum + row.seconds, 0), directAttempts: direct.length, treatmentAttempts: treatment.length }
    })
    const observed = pairs.filter(pair => pair.directAttempts && pair.treatmentAttempts)
    return { mode, pairs, completePairs: observed.length, successfulPairs: observed.filter(pair => pair.directQuality === 'passed' && pair.treatmentQuality === 'passed').length, allAttemptPairedDifference: observed.length ? { _tag: 'Recorded', medianSeconds: median(observed.map(pair => pair.treatmentSeconds - pair.directSeconds)), uncertainty: interval(observed.map(pair => ({ task: pair.task, seconds: pair.treatmentSeconds - pair.directSeconds })), seed), meaning: 'Treatment minus direct. Includes failed workflows and repairs. Quality states must be inspected before interpreting cost.' } : { _tag: 'Unavailable', reason: 'No complete paired workflows.' } }
  }) }))
}
export function reportMarkdown(rows: AttemptMetric[], seed: number, manifestHash: string, study: string, gates: {
  task: string
  mode: Mode
  id: string
  _tag: string
  required: boolean
}[] = []): string {
  const summaries = aggregateAttempts(rows, seed)
  const lines = ['# Experiment report', '', `Study: ${study}. Manifest SHA-256: \`${manifestHash}\`.`, '', '## Quality before cost', '', '| Cohort | Mode | Completed workflows | Failures | Refusals | Unavailable | Repairs |', '| --- | --- | ---: | ---: | ---: | ---: | ---: |']
  for (const s of summaries)
    lines.push(`| ${s.cohort} | ${s.mode} | ${s.completedWorkflows}/${s.workflows} | ${s.failures} | ${s.refusals} | ${s.unavailable} | ${s.repairs} |`)
  if (gates.length) {
    lines.push('', '## Common quality gates', '', '| Task | Mode | Gate | Required | State |', '| --- | --- | --- | --- | --- |')
    for (const gate of gates)
      lines.push(`| ${gate.task} | ${gate.mode} | ${gate.id} | ${gate.required} | ${gate._tag} |`)
    lines.push('', 'Unavailable protected-plan capability cannot establish equal protected-plan quality.')
  }
  lines.push('', '## All-attempt resources', '', '| Cohort | Mode | Summed seconds | Median workflow seconds | Successful median | Tokens | Actual charges |', '| --- | --- | ---: | ---: | ---: | --- | --- |')
  for (const s of summaries)
    lines.push(`| ${s.cohort} | ${s.mode} | ${s.totalSeconds.toFixed(3)} | ${s.medianWorkflowSeconds.toFixed(3)} | ${s.medianSuccessfulWorkflowSeconds?.toFixed(3) ?? 'Unavailable'} | ${s.tokens._tag} | ${s.charges._tag} |`)
  lines.push('', 'Every attempt remains in totals. Workflow medians include repairs and failed workflows.', 'Token categories, task-level rows, bootstrap intervals, controller costs, and phase spans are in report.json.', 'Cached context counts once in total tokens. Reasoning is already included in output.', 'Unrecorded charges are unavailable. Zero placeholders are not prices.', 'Pilot and scripted measurements cannot establish restored agent gains.', 'Timing includes child tracing. Load samples are observations, not corrections.', '')
  return lines.join('\n')
}
