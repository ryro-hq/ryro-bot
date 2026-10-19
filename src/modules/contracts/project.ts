export type Mode = 'observe' | 'prepare' | 'publish';
export interface Owner {
  owners: string[];
  deputies: string[];
}
export interface Project {
  repository: string;
  repositoryId?: number;
  canonicalRepository?: string;
  aliases?: string[];
  modules?: string[];
  workflows?: string[];
  policy: string;
  baseBranch: string;
  fallback: string[];
  independentReviewers: string[];
  categories: Record<string, Owner>;
  packages: Record<
    string,
    Owner & {
      category: string;
      paths: string[];
      profiles: string[];
      discovery?: Channel;
    }
  >;
  shared: { paths: string[]; categories: string[]; affectsAll: boolean }[];
  limits: {
    versionsPerBatch: number;
    openPrs: number;
    combinations: number;
    catalogBytes: number;
    lockBytes: number;
    estimatedBytesPerCombination: number;
    actionsMatrixRows: number;
  };
  requiredChecks: string[];
  hosts: string[];
  preparationWorkflow: string;
  qualificationWorkflow: string;
  publicationEnabled: boolean;
}
export interface Channel {
  url: string;
  origin: string;
  format: 'html' | 'github';
  prefix: string;
  suffix: string;
  classification: 'numeric' | 'even-minor';
}
export interface Binding {
  repositoryId: number;
  installationId: number;
}
