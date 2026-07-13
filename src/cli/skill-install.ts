import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
// Bun inlines the canonical skill into the compiled binary, so an installed
// `sharemd` carries the skill matching its own tool surface — no repo needed.
import SKILL_MD from '../../skills/sharemd/SKILL.md' with { type: 'text' };

export type InstallScope = 'project' | 'user';

export interface SkillInstallResult {
  path: string;
  action: 'created' | 'updated' | 'unchanged';
}

/** Where the skill lands: `.claude/skills/sharemd/SKILL.md` under cwd or $HOME. */
export function skillInstallPath(scope: InstallScope, cwd = process.cwd(), home = homedir()): string {
  const base = scope === 'user' ? home : cwd;
  return join(base, '.claude', 'skills', 'sharemd', 'SKILL.md');
}

export async function installSkill(
  scope: InstallScope,
  cwd = process.cwd(),
  home = homedir(),
): Promise<SkillInstallResult> {
  const path = skillInstallPath(scope, cwd, home);
  const file = Bun.file(path);
  const existing = (await file.exists()) ? await file.text() : null;
  if (existing === SKILL_MD) {
    return { path, action: 'unchanged' };
  }
  await mkdir(join(path, '..'), { recursive: true });
  await Bun.write(path, SKILL_MD);
  return { path, action: existing === null ? 'created' : 'updated' };
}
