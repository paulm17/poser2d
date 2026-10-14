import type { Job } from './engine';
export function splatAction(jobs: Job[], source: string | undefined, submitting: boolean) {
  const job = source ? [...jobs].reverse().find(j => j.kind === 'splat' && j.source_take === source) : undefined;
  const busy = submitting || !!job && ['queued', 'running', 'cancelling'].includes(job.state);
  return { job, disabled: busy, label: busy ? job?.state === 'queued' ? 'Queued…' : 'Generating splat…' : job?.state === 'completed' ? 'View splat' : 'Generate splat' };
}
