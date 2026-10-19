import { requireThat } from './errors.js';
import type { BotModule, JobDefinition } from './contracts/modules.js';
export function registerModules<R>(modules: readonly BotModule<R>[]) {
  const ids = new Set(modules.map((m) => m.id));
  requireThat(ids.size === modules.length, 'duplicate-module');
  const handlers = new Map<string, JobDefinition<R>>();
  const visiting = new Set<string>(),
    visited = new Set<string>();
  const visit = (id: string) => {
    requireThat(!visiting.has(id), 'module-dependency-cycle');
    if (visited.has(id)) return;
    const module = modules.find((m) => m.id === id);
    requireThat(module, 'missing-module-dependency');
    visiting.add(id);
    for (const dependency of module.requires ?? []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const module of modules) {
    visit(module.id);
    for (const job of module.jobs) {
      requireThat(
        !handlers.has(job.kind) &&
          Number.isInteger(job.payloadVersion) &&
          job.payloadVersion > 0,
        'duplicate-or-invalid-job',
      );
      handlers.set(job.kind, job);
    }
  }
  return {
    modules,
    handlers,
    webhook: (repository: string, event: string, payload: unknown) =>
      modules.flatMap((m) => m.webhook?.(repository, event, payload) ?? []),
  };
}
export type ModuleRegistry<R = never> = ReturnType<typeof registerModules<R>>;
