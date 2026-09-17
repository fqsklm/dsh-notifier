/**
 * 极简测试执行器。
 *
 * 为什么不用 node:test：`node --test` 会为每个测试文件 spawn 子进程并通过管道通信，
 * 在受限环境（沙箱）里直接 EPERM；而 node:test 的程序化 `run()` 在这些 Node 版本上
 * 又不发事件流。这里用普通函数自己跑，结果同步落盘，任何环境都能用。
 *
 * 用法: node test/smoke.mjs
 */
import { appendFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
// 每套测试各写各的文件：`npm test` 跑两套，共用一个文件的话后一套会把前一套覆盖掉。
const outFile = process.env.DSH_NOTIFIER_REPORT
  ? join(HERE, process.env.DSH_NOTIFIER_REPORT)
  : join(HERE, 'last-run.txt')

const suites = []
let current = null
let totals = { pass: 0, fail: 0, skip: 0 }

function emit(line) {
  appendFileSync(outFile, `${line}\n`, 'utf8')
  process.stdout.write(`${line}\n`)
}

export function resetReport() {
  writeFileSync(outFile, '', 'utf8')
  totals = { pass: 0, fail: 0, skip: 0 }
}

export function describe(name, body) {
  const suite = { name, tests: [], before: [], after: [] }
  suites.push(suite)
  const previous = current
  current = suite
  try {
    body()
  } finally {
    current = previous
  }
}

export function before(fn) {
  if (!current) throw new Error('before() 必须在 describe() 里调用')
  current.before.push(fn)
}

export function after(fn) {
  if (!current) throw new Error('after() 必须在 describe() 里调用')
  current.after.push(fn)
}

export function it(name, body) {
  if (!current) throw new Error(`测试 "${name}" 不在 describe 里`)
  current.tests.push({ name, body })
}

export function itSkip(name) {
  if (!current) throw new Error(`测试 "${name}" 不在 describe 里`)
  current.tests.push({ name, body: null, skipped: true })
}

export async function report() {
  const failures = []
  for (const suite of suites) {
    emit(`▶ ${suite.name}`)
    let suiteBroken = null
    for (const hook of suite.before) {
      try {
        await withTimeout(hook, 15000, `${suite.name} › before`)
      } catch (error) {
        suiteBroken = error
        break
      }
    }
    if (suiteBroken) {
      emit(`  FAIL ${suite.name} › before 钩子`)
      failures.push({ label: `${suite.name} › before`, error: suiteBroken })
    }
    for (const test of suite.tests) {
      const label = `${suite.name} › ${test.name}`
      if (test.skipped || suiteBroken) {
        totals.skip += 1
        emit(`  - ${label} (skipped)`)
        continue
      }
      const started = Date.now()
      try {
        await withTimeout(test.body, 15000, label)
        totals.pass += 1
        emit(`  ok ${label} (${Date.now() - started}ms)`)
      } catch (error) {
        totals.fail += 1
        emit(`  FAIL ${label} (${Date.now() - started}ms)`)
        failures.push({ label, error })
      }
    }
    for (const hook of suite.after) {
      try {
        await withTimeout(hook, 15000, `${suite.name} › after`)
      } catch (error) {
        failures.push({ label: `${suite.name} › after`, error })
      }
    }
    emit(`✔ ${suite.name}`)
  }
  emit('')
  for (const failure of failures) {
    emit(`FAIL ${failure.label}`)
    emit(indent(failure.error?.stack ?? failure.error?.message ?? String(failure.error)))
  }
  emit(`${totals.pass} passed, ${totals.fail} failed, ${totals.skip} skipped`)
  return totals
}

function indent(text) {
  return String(text)
    .split('\n')
    .map((line) => `    ${line}`)
    .join('\n')
}

async function withTimeout(body, ms, label) {
  let timer
  try {
    await Promise.race([
      Promise.resolve().then(body),
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`测试超时（${ms}ms）: ${label}`)), ms)
        timer.unref?.()
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

export async function finish() {
  const result = await report()
  process.exit(result.fail > 0 ? 1 : 0)
}
