import type { Mode, Project, Binding } from './project.js';
export interface AutomationSettings {
  mode: Mode;
  revision: string;
  version: string;
  appLogin?: string;
  projects: Project[];
  bindings: Record<string, Binding>;
  schedulerSeconds: number;
}
