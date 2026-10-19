import { Layer } from 'effect';
import { jobStoreLayer } from './jobs.js';
import { auditStoreLayer } from './audit.js';
import { catalogStoreLayer } from './catalog.js';
import { discoveryStoreLayer } from './discovery.js';
import { operationStoreLayer } from './operations.js';
import { ciStoreLayer } from './ci.js';

export const persistenceLayer = Layer.mergeAll(
  jobStoreLayer,
  auditStoreLayer,
  catalogStoreLayer,
  discoveryStoreLayer,
  operationStoreLayer,
  ciStoreLayer,
);
