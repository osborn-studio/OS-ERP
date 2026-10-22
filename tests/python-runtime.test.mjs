import test from 'node:test'
import assert from 'node:assert/strict'
import { resolvePythonRuntime } from '../scripts/lib/python-runtime.mjs'

const available = { status: 0, stdout: JSON.stringify({ executable: '/test-venv/bin/python', version: '3.12.0', openpyxl: '3.1.5' }) }

test('explicit Python failure is visible and cannot silently select a different interpreter', () => {
  const calls = []
  assert.throws(() => resolvePythonRuntime({ GML_PYTHON: '/missing/python' }, command => {
    calls.push(command)
    return { error: { code: 'ENOENT' }, status: null }
  }), { code: 'PYTHON_VERIFIER_UNAVAILABLE' })
  assert.deepEqual(calls, ['/missing/python'])
})

test('existing Python without openpyxl is not sufficient; implicit discovery may try the next interpreter', () => {
  const calls = []
  const result = resolvePythonRuntime({}, (command, args) => {
    calls.push(command)
    assert.match(args[1], /import json,sys,openpyxl/)
    return command === 'python3' ? { status: 1, stderr: "ModuleNotFoundError: No module named 'openpyxl'" } : available
  })
  assert.deepEqual(calls, ['python3', 'python'])
  assert.equal(result.executable, '/test-venv/bin/python')
  assert.equal(result.openpyxl, '3.1.5')
})

test('success exit without valid version metadata is rejected', () => {
  assert.throws(() => resolvePythonRuntime({ GML_PYTHON: '/bad/python' }, () => ({ status: 0, stdout: '{}' })), { code: 'PYTHON_VERIFIER_UNAVAILABLE' })
})

test('explicit Python module import failure and timeout are failures, not skips', () => {
  for (const failure of [{ status: 1, stderr: "No module named 'openpyxl'" }, { error: { code: 'ETIMEDOUT' }, status: null }]) {
    assert.throws(() => resolvePythonRuntime({ GML_PYTHON: '/test/python' }, () => failure), { code: 'PYTHON_VERIFIER_UNAVAILABLE' })
  }
})
