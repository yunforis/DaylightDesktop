/** Legacy UI helper: capabilities no longer depend on personal/HR identity. */
export function hasRecruitmentAccess(user) {
  return Boolean(user);
}
