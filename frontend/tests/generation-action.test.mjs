import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
const source = ts.transpileModule(await readFile(new URL('../src/generation-action.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { generationAction } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const job = (id, state, session = 'default') => ({ id, state, session });
const action = (jobs, session = 'default', submitting = false, pending = new Set()) => generationAction(jobs, session, submitting, pending);

test('Generate returns for all terminal states and other sessions', () => {
  for (const state of ['completed', 'cancelled', 'failed']) {
    assert.deepEqual(action([job('a', state)]), { job: undefined, disabled: false, label: 'Generate' });
  }
  assert.equal(action([job('a', 'running', 'other')]).label, 'Generate');
});
test('running jobs take priority over queued jobs, with earliest queued as fallback', () => {
  const jobs = [job('first', 'queued'), job('second', 'queued'), job('active', 'running')];
  assert.equal(action(jobs).job.id, 'active');
  assert.equal(action(jobs.slice(0, 2)).job.id, 'first');
  assert.equal(action(jobs).label, 'Cancel');
});
test('selected session determines Cancel target', () => {
  const jobs = [job('a', 'running'), job('b', 'queued', 'other')];
  assert.equal(action(jobs, 'default').job.id, 'a');
  assert.equal(action(jobs, 'other').job.id, 'b');
  assert.equal(action(jobs, 'empty').label, 'Generate');
});
test('submission and cancellation disable the action until settled', () => {
  assert.equal(action([], 'default', true).label, 'Submitting…');
  assert.equal(action([], 'default', true).disabled, true);
  for (const result of [action([job('a', 'cancelling')]), action([job('a', 'running')], 'default', false, new Set(['a']))]) {
    assert.equal(result.label, 'Cancelling…');
    assert.equal(result.disabled, true);
  }
  const retry = action([job('a', 'running')]);
  assert.equal(retry.label, 'Cancel');
  assert.equal(retry.disabled, false);
});
test('lifecycle follows subsequent active jobs after completion or cancellation', () => {
  let jobs = [job('a', 'queued')];
  assert.equal(action(jobs).label, 'Cancel');
  jobs[0].state = 'running';
  assert.equal(action(jobs).label, 'Cancel');
  jobs[0].state = 'cancelling';
  assert.equal(action(jobs).label, 'Cancelling…');
  jobs[0].state = 'cancelled';
  assert.equal(action(jobs).label, 'Generate');
  jobs.push(job('b', 'queued'));
  assert.equal(action(jobs).job.id, 'b');
});
