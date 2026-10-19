import { Effect } from 'effect';
import type { AutomationSettings as Settings } from '../contracts/settings.js';
import type { Project } from '../contracts/project.js';
import { requireThat } from '../../kernel/errors.js';
import { audit } from '../../kernel/audit.js';
import { renew } from '../../kernel/jobs.js';
import type { Job } from '../../kernel/contracts/jobs.js';
import type { GitHubAPI as GitHub, Pull } from '../ci/model.js';
import { admitBaseConfig } from '../../kernel/policy.js';
import { route } from './policy.js';

// Keep the transport adapter local to avoid a runtime dependency cycle.
const remote = <A>(work: () => Promise<A>) => Effect.tryPromise(work);
export const routeOpenPulls = (
  settings: Settings,
  project: Project,
  job: Job,
  api: GitHub,
  pulls: Pull[],
) =>
  Effect.gen(function* () {
    const open = pulls.filter(
      (pr) => pr.state === 'open' && pr.base.ref === project.baseBranch,
    );
    requireThat(open.length <= 100, 'review-routing-snapshot-limit');
    let labels: { name: string }[] | undefined;
    for (const pull of open) {
      yield* renew(job);
      const baseConfig = yield* remote(() =>
        api.file('.ryro-bot.toml', pull.base.sha),
      );
      admitBaseConfig(baseConfig.toString('utf8'), project, settings.revision);
      const details = yield* remote(() =>
        api.get<Pull & { changed_files: number }>(
          `/repos/${project.repository}/pulls/${pull.number}`,
        ),
      );
      const files = yield* remote(() =>
        api.list<{ filename: string; previous_filename?: string }>(
          `/pulls/${pull.number}/files`,
        ),
      );
      requireThat(
        files.length === details.changed_files &&
          details.head.sha === pull.head.sha &&
          details.base.sha === pull.base.sha,
        'changed-pull-snapshot',
      );
      const result = route(
        project,
        [
          ...new Set(
            files.flatMap((f) =>
              f.previous_filename
                ? [f.filename, f.previous_filename]
                : [f.filename],
            ),
          ),
        ],
        pull.user.login,
      );
      yield* audit('review-routing', {
        repository: project.repository,
        policyRevision: settings.revision,
        baseSha: pull.base.sha,
        producedSha: pull.head.sha,
        botVersion: settings.version,
        evidence: { pr: pull.number, ...result, mode: settings.mode },
      });
      if (settings.mode !== 'publish' || !project.publicationEnabled) continue;
      yield* remote(() => api.rules(project.baseBranch));
      labels ??= yield* remote(() => api.list<{ name: string }>('/labels'));
      for (const name of result.labels)
        if (!labels.some((l) => l.name === name)) {
          yield* renew(job);
          yield* remote(() =>
            api.createLabel({
              name,
              color: '336699',
              description: 'Review routing: ' + name.slice(5),
            }),
          );
          labels.push({ name });
        }
      const current = yield* remote(() =>
        api.get<Pull & { labels: { name: string }[] }>(
          `/repos/${project.repository}/pulls/${pull.number}`,
        ),
      );
      requireThat(
        current.head.sha === pull.head.sha &&
          current.base.sha === pull.base.sha,
        'pull-moved-before-routing',
      );
      const missingLabels = result.labels.filter(
        (name) => !current.labels.some((label) => label.name === name),
      );
      if (missingLabels.length) {
        yield* renew(job);
        yield* remote(() => api.addLabels(pull.number, missingLabels));
      }
      const requested = yield* remote(() =>
        api.get<{ users: { login: string }[] }>(
          `/repos/${project.repository}/pulls/${pull.number}/requested_reviewers`,
        ),
      );
      const reviews = yield* remote(() =>
        api.list<{ user: { login: string }; commit_id: string; state: string }>(
          `/pulls/${pull.number}/reviews`,
        ),
      );
      const reviewed = new Map<string, { commit_id: string; state: string }>();
      for (const review of reviews)
        reviewed.set(review.user.login.toLowerCase(), review);
      const missing = result.reviewers
        .map((r) => r.slice(1))
        .filter(
          (login) =>
            !requested.users.some(
              (u) => u.login.toLowerCase() === login.toLowerCase(),
            ) &&
            !(
              reviewed.get(login.toLowerCase())?.commit_id === pull.head.sha &&
              ['APPROVED', 'CHANGES_REQUESTED'].includes(
                reviewed.get(login.toLowerCase())!.state,
              )
            ),
        );
      if (missing.length) {
        yield* renew(job);
        yield* remote(() => api.requestReview(pull.number, missing));
      }
    }
  });
