import { canonical, sha256 } from '../../kernel/values.js';
import type { Project } from './project.js';
export const policyDigest = (project: Project) => sha256(canonical(project));
