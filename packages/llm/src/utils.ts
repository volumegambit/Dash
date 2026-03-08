export function bareModelId(model: string): string {
  const slash = model.indexOf('/');
  return slash !== -1 ? model.slice(slash + 1) : model;
}
