/** Validate a skill name: lowercase alphanumeric + hyphens, starts alnum, max 64 chars. */
export function isValidSkillName(name: string): boolean {
  return /^[a-z0-9][a-z0-9-]*$/.test(name) && name.length <= 64;
}
