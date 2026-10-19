import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Console, Effect } from 'effect';
import { loadAdminSettings } from '../../app/config/service.ts';
import { loadDatabaseSettings } from '../../app/config/database.ts';
import { loadProjects } from '../../app/config/registry.ts';
import { databaseLayer } from '../postgres/client.ts';
import {
  checkMigrations,
  migrate,
  migrationStatus,
} from '../postgres/migrations.ts';
import { administer, adminStatus } from '../postgres/admin.ts';
import { requireThat } from '../../kernel/errors.ts';
import { ownershipArtifacts, route } from '../../modules/reviews/policy.ts';

export const adminProgram = (argv: string[], env = process.env) =>
  Effect.gen(function* () {
    const [command = 'help', repository, ...args] = argv;
    if (command === 'help' || command === '--help') {
      yield* Console.log(
        'admin migrate [apply|status|check] | status | owners REPO DEST | route REPO AUTHOR PATH... | reconcile REPO | discover REPO PACKAGE | inventory REPO | hold REPO PACKAGE VERSION STATE REASON | recover-dispatch REPO BATCH RUN',
      );
      return;
    }
    if (command === 'owners' || command === 'route') {
      const project = loadProjects(env).find((p) =>
        [p.repository, p.canonicalRepository, ...(p.aliases ?? [])].includes(
          repository,
        ),
      );
      requireThat(project, 'unregistered-project');
      if (command === 'route') {
        requireThat(args[0], 'author-required');
        yield* Console.log(
          JSON.stringify(route(project, args.slice(1), args[0]), null, 2),
        );
      } else {
        requireThat(args[0], 'destination-required');
        for (const [path, bytes] of Object.entries(
          ownershipArtifacts(project),
        )) {
          const destination = resolve(args[0], path);
          mkdirSync(resolve(destination, '..'), { recursive: true });
          writeFileSync(destination, bytes);
        }
      }
      return;
    }
    requireThat(
      [
        'migrate',
        'status',
        'reconcile',
        'discover',
        'inventory',
        'hold',
        'recover-dispatch',
      ].includes(command),
      'unknown-admin-command',
    );
    const db = loadDatabaseSettings(env);
    yield* Effect.gen(function* () {
      if (command === 'migrate') {
        const action = repository ?? 'apply';
        requireThat(
          ['apply', 'status', 'check'].includes(action),
          'invalid-migration-command',
        );
        if (action === 'apply') yield* migrate;
        if (action === 'check') yield* checkMigrations;
        yield* Console.log(JSON.stringify(yield* migrationStatus));
        return;
      }
      yield* checkMigrations;
      if (command === 'status') yield* adminStatus;
      else {
        requireThat(repository, 'repository-required');
        yield* administer(command, repository, args, loadAdminSettings(env));
      }
    }).pipe(
      Effect.provide(
        databaseLayer(db.databaseUrl, db.databaseCa, db.localDatabase),
      ),
    );
  });
