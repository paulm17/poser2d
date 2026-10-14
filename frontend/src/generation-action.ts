import type { Job } from './engine';

export function generationAction(jobs: Job[], session: string, submitting: boolean, pendingCancellations: ReadonlySet<string>) {
  const job = jobs.find(job => job.session === session && (job.state === 'running' || job.state === 'cancelling'))
    ?? jobs.find(job => job.session === session && job.state === 'queued');
  const cancelling = !!job && (job.state === 'cancelling' || pendingCancellations.has(job.id));
  return { job, disabled: submitting || cancelling,
    label: submitting ? 'Submitting…' : cancelling ? 'Cancelling…' : job ? 'Cancel' : 'Generate' };
}
