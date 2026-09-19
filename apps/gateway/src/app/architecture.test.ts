import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const sourceDir = fileURLToPath(new URL('../', import.meta.url));

function parse(path: string) {
  return ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
}

function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}

describe('gateway application boundaries', () => {
  it('keeps agent/channel services independent of HTTP and WebSocket transports', () => {
    const violations: string[] = [];
    for (const folder of ['agents', 'channels']) {
      for (const file of readdirSync(join(sourceDir, folder), { recursive: true })) {
        if (typeof file !== 'string' || !file.endsWith('.ts') || file.endsWith('.test.ts')) {
          continue;
        }
        walk(parse(join(sourceDir, folder, file)), (node) => {
          let module: string | undefined;
          if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
            if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
              module = node.moduleSpecifier.text;
            }
          } else if (
            ts.isCallExpression(node) &&
            (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
              (ts.isIdentifier(node.expression) && node.expression.text === 'require')) &&
            node.arguments[0] &&
            ts.isStringLiteral(node.arguments[0])
          ) {
            module = node.arguments[0].text;
          }
          if (
            module &&
            /^(?:hono(?:\/|$)|@hono\/|ws(?:\/|$)|node:https?$)|(?:^|\/)(?:management-api|chat-ws|lan-mobile-app|bootstrap|application|listener)\.js$/.test(
              module,
            )
          ) {
            violations.push(`${folder}/${file}: ${module}`);
          }
        });
      }
    }
    expect(violations).toEqual([]);
  });

  it('leaves agent/channel lifecycle mutations behind service entrypoints', () => {
    const forbidden: Record<string, Set<string>> = {
      agentRegistry: new Set(['register', 'remove', 'disable', 'enable']),
      channelRegistry: new Set(['register', 'update', 'remove', 'removeRoutesForAgent', 'save']),
      gateway: new Set(['registerAgent', 'deregisterAgent', 'registerChannel', 'stopChannel']),
    };
    const violations: string[] = [];
    walk(parse(join(sourceDir, 'management-api.ts')), (node) => {
      if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return;
      const call = node.expression;
      if (
        ts.isIdentifier(call.expression) &&
        forbidden[call.expression.text]?.has(call.name.text)
      ) {
        violations.push(`${call.expression.text}.${call.name.text}`);
      }
    });
    // Memory/skill-specific registry updates remain separate domain operations;
    // create/delete/enable/disable and adapter ownership belong to services.
    expect(violations).toEqual([]);
  });
});
