import { canonical, sha256 } from '../../kernel/values.ts';
import type { Project } from './project.ts';
export const policyDigest = (project: Project) => sha256(canonical(project));
