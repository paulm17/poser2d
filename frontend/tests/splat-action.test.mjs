import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
const source = ts.transpileModule(await readFile(new URL('../src/splat-action.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { splatAction } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const job = (state, source_take = 'a', kind = 'splat') => ({ id: state, state, source_take, kind });
test('splat action tracks submission, queue, completion and retry', () => {
  assert.equal(splatAction([], 'a', false).label, 'Generate splat');
  assert.equal(splatAction([], 'a', true).disabled, true);
  assert.equal(splatAction([job('queued')], 'a', false).label, 'Queued…');
  for (const state of ['running', 'cancelling']) {
    assert.equal(splatAction([job(state)], 'a', false).label, 'Generating splat…');
    assert.equal(splatAction([job(state)], 'a', false).disabled, true);
  }
  assert.equal(splatAction([job('completed')], 'a', false).label, 'View splat');
  for (const state of ['failed', 'cancelled']) {
    assert.equal(splatAction([job(state)], 'a', false).label, 'Generate splat');
    assert.equal(splatAction([job(state)], 'a', false).disabled, false);
  }
});
test('selection and retries use the latest splat belonging to that take', () => {
  const jobs = [job('completed', 'a', 'image'), job('failed'), job('queued')];
  assert.equal(splatAction(jobs, 'a', false).job.id, 'queued');
  assert.equal(splatAction(jobs, 'b', false).job, undefined);
  assert.equal(splatAction(jobs, undefined, false).job, undefined);
});
