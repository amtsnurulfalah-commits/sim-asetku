/** Conservative inventory only: candidates always require human review before deletion. */
const ts = require('typescript');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const config = ts.readConfigFile(path.join(root, 'tsconfig.json'), ts.sys.readFile);
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
const program = ts.createProgram(parsed.fileNames, parsed.options);
const checker = program.getTypeChecker();
const local = program.getSourceFiles().filter(s => s.fileName.startsWith(root + '/') && !s.fileName.includes('/node_modules/'));
const sources = local.filter(s => s.fileName.startsWith(root + '/src/'));
const edges = new Map();
for (const source of local) {
  const dependencies = [];
  const visit = node => {
    const parent = node.parent;
    if (parent && ts.isStringLiteral(node) && (
      ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent) ||
      ts.isCallExpression(parent) && parent.expression.kind === ts.SyntaxKind.ImportKeyword
    )) {
      const resolved = ts.resolveModuleName(node.text, source.fileName, parsed.options, ts.sys).resolvedModule;
      if (resolved) dependencies.push(resolved.resolvedFileName);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  edges.set(source.fileName, dependencies);
}
const roots = [...edges.keys()].filter(file => !file.includes('/src/') || /\/(page|route|layout|error|loading|not-found|global-error|middleware|proxy)\.[jt]sx?$/.test(file));
const reached = new Set();
const walk = file => {
  if (reached.has(file)) return;
  reached.add(file);
  for (const dependency of edges.get(file) ?? []) walk(dependency);
};
roots.forEach(walk);
const references = new Map();
for (const source of local) {
  if (source.fileName.includes('/.next/')) continue;
  const visit = node => {
    if (ts.isIdentifier(node)) {
      let symbol = checker.getSymbolAtLocation(node);
      if (symbol?.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
      const parent = node.parent;
      const declaration = parent?.name === node && (
        ts.isVariableDeclaration(parent) || ts.isFunctionDeclaration(parent) ||
        ts.isClassDeclaration(parent) || ts.isTypeAliasDeclaration(parent) ||
        ts.isInterfaceDeclaration(parent) || ts.isParameter(parent) ||
        ts.isMethodDeclaration(parent) || ts.isPropertyDeclaration(parent)
      );
      if (symbol && !declaration) references.set(symbol, (references.get(symbol) ?? 0) + 1);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}
const protectedNames = new Set(['default', 'runtime', 'dynamic', 'maxDuration', 'metadata', 'GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD']);
const exportCandidates = [];
let protectedFrameworkExports = 0;
for (const source of sources) {
  const module = checker.getSymbolAtLocation(source);
  if (!module) continue;
  for (let symbol of checker.getExportsOfModule(module)) {
    if (symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
    if (references.get(symbol)) continue;
    if (protectedNames.has(symbol.name)) { protectedFrameworkExports++; continue; }
    exportCandidates.push({file:path.relative(root,source.fileName),name:symbol.name});
  }
}
const unreachable = sources.filter(source => !reached.has(source.fileName)).map(source => path.relative(root, source.fileName));
console.log(JSON.stringify({sourceFiles:sources.length,reachable:sources.length-unreachable.length,unreachable,exportCandidates,protectedFrameworkExports,note:'Includes framework entry points, tests, operator scripts and static dynamic-import paths. SQL functions/migrations and configuration assets require separate review. Never delete from this inventory alone.'},null,2));
