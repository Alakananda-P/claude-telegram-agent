import { z } from 'zod';

export const projectRecordSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,47}$/),
  name: z.string().min(1).max(80), description: z.string().max(4000).default(''),
  status: z.enum(['active', 'archived', 'trashed', 'purging', 'purged']),
  createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
  archivedAt: z.string().datetime().optional(), trashedAt: z.string().datetime().optional(),
  purgeAt: z.string().datetime().optional(), purgedAt: z.string().datetime().optional(),
});
export type ProjectRecord = z.infer<typeof projectRecordSchema>;
export type ProjectState = { projects?: ProjectRecord[] };
export class ProjectError extends Error {}
export function projectAcceptsWork(state: ProjectState, id: string): boolean {
  const p = state.projects?.find(p => p.id === id);
  return !p || p.status === 'active';
}
export function assertProjectWork(state: ProjectState, id: string): void {
  const p = state.projects?.find(p => p.id === id);
  if (p && p.status !== 'active') throw new ProjectError(p.status === 'archived'
    ? 'This project is archived. Restore the project before starting work.'
    : p.status === 'trashed' ? 'This project is in Trash. Restore it before starting work.'
    : 'This project was permanently deleted or its purge is in progress.');
}
export function projectVisible(state: ProjectState, id: string): boolean {
  const p = state.projects?.find(p => p.id === id);
  return !p || p.status === 'active' || p.status === 'archived';
}
