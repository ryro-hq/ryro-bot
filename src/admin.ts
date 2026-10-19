import { NodeRuntime, NodeServices } from '@effect/platform-node';
import { Effect } from 'effect';
import { adminProgram } from './adapters/cli/admin.ts';
NodeRuntime.runMain(
  adminProgram(process.argv.slice(2)).pipe(Effect.provide(NodeServices.layer)),
);
