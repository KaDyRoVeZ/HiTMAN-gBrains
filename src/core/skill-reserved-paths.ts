/**
 * Reserved skillpack paths: `skills/` at any depth plus `skillpack.json`, owned by
 * the shared skill publisher (put_skill / adoptSharedSkillpack), never by managed
 * knowledge import. `managedImportContent` refuses them with `skill_bundle_required`,
 * and managed sync discovery leaves them out so a seeded pack cannot block a sync.
 */
export function isReservedSkillBundlePath(path: string): boolean {
  const normalized = path.replaceAll('\\', '/');
  return /(^|\/)skills(\/|$)/i.test(normalized) || /(^|\/)skillpack\.json$/i.test(normalized);
}
