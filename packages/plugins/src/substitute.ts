const VAR = /\$\{([A-Za-z_][A-Za-z0-9_]*)(:-([^}]*))?\}/g;

/** Substitute ${NAME} / ${NAME:-default}. NAME resolves from `vars`, then process.env. */
export function substituteVars(text: string, vars: Record<string, string>): string {
  return text.replace(VAR, (_m, name: string, _g2, def?: string) => {
    const v = vars[name] ?? process.env[name];
    if (v !== undefined) return v;
    if (def !== undefined) return def;
    throw new Error(`undefined variable \${${name}} (no default)`);
  });
}

/** Build a child-process env with the plugin path vars layered over process.env. */
export function hookEnv(vars: Record<string, string>): NodeJS.ProcessEnv {
  return { ...process.env, ...vars };
}
