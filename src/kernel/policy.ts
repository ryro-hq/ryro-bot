import { parse } from 'smol-toml';
import { requireThat } from './errors.ts';
import { gitSha, sha256 } from './values.ts';
export interface BasePolicy {
  readonly policy: string;
}
export function admitBaseConfig(
  text: string,
  project: BasePolicy,
  revision: string,
) {
  requireThat(Buffer.byteLength(text) <= 8192, 'config-too-large');
  const config = parse(text);
  requireThat(
    Object.keys(config).sort().join(',') ===
      'enabled,policy,policy_revision,schema',
    'unknown-opt-in-fields',
  );
  requireThat(
    config.schema === 1 &&
      config.enabled === true &&
      config.policy === project.policy &&
      config.policy_revision === gitSha(revision),
    'base-policy-mismatch',
  );
  return sha256(text);
}
