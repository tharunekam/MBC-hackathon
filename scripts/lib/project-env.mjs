import { existsSync } from 'node:fs';

/** Load optional project configuration without overriding values provided by the caller. */
export function loadProjectEnv(path) {
  if (existsSync(path)) process.loadEnvFile(path);
}
