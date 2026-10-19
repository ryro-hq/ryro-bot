import { Layer } from 'effect';
import { jobStoreLayer } from './jobs.ts';
import { auditStoreLayer } from './audit.ts';
import { catalogStoreLayer } from './catalog.ts';
import { discoveryStoreLayer } from './discovery.ts';
import { operationStoreLayer } from './operations.ts';
import { ciStoreLayer } from './ci.ts';

export const persistenceLayer = Layer.mergeAll(
  jobStoreLayer,
  auditStoreLayer,
  catalogStoreLayer,
  discoveryStoreLayer,
  operationStoreLayer,
  ciStoreLayer,
);
