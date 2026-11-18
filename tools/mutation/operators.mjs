import ts from "typescript";

export const OPERATORS = ["path", "receiver", "swap"];

const UNORDERED = new Set([
  ts.SyntaxKind.FunctionDeclaration,
  ts.SyntaxKind.ClassDeclaration,
  ts.SyntaxKind.InterfaceDeclaration,
  ts.SyntaxKind.TypeAliasDeclaration,
  ts.SyntaxKind.EnumDeclaration,
  ts.SyntaxKind.ImportDeclaration,
  ts.SyntaxKind.ExportDeclaration,
  ts.SyntaxKind.EmptyStatement,
]);

export function generateMutants(source, fileName, operators = OPERATORS) {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const imported = importedNames(sourceFile);
  const chains = collectChains(sourceFile).filter((c) => !inDiagnostic(c.node, imported));
  const heads = new Set(chains.filter((c) => c.headName).map((c) => headKey(c)));
  const mutants = [];
  const lineOf = (pos) => sourceFile.getLineAndCharacterOfPosition(pos).line + 1;
  const add = (operator, start, end, replacement, original = source.slice(start, end)) => {
    mutants.push({
      operator,
      line: lineOf(start),
      start,
      end,
      anchors: [start],
      original,
      replacement,
      text: source.slice(0, start) + replacement + source.slice(end),
    });
  };

  if (operators.includes("path")) {
    for (const chain of chains) {
      const { pieces } = chain;
      for (let i = 1; i < pieces.length - 1; i++) {
        add("path", chain.start, chain.end, without(pieces, i).join(""));
      }
      const alias = chain.headName && aliasOf(chain.node, chain.headName);
      if (alias) {
        for (let i = 1; i < alias.length; i++) {
          add("path", chain.start, chain.end, [...without(alias, i), ...pieces.slice(1)].join(""));
        }
      }
    }
  }

  if (operators.includes("receiver")) {
    for (const chain of chains) {
      if (!chain.headName) {
        continue;
      }
      const locals = receiversInScope(chain.node, chain.start);
      if (!locals.has(chain.headName)) {
        continue;
      }
      for (const name of locals) {
        if (name !== chain.headName && heads.has(headKey(chain, name))) {
          add("receiver", chain.start, chain.end, [name, ...chain.pieces.slice(1)].join(""));
        }
      }
    }
  }

  if (operators.includes("swap")) {
    const visit = (node) => {
      const statements =
        ts.isBlock(node) || ts.isCaseOrDefaultClause(node) ? node.statements : null;
      if (statements) {
        for (let i = 0; i + 1 < statements.length; i++) {
          const [a, b] = [statements[i], statements[i + 1]];
          if (
            UNORDERED.has(a.kind) ||
            UNORDERED.has(b.kind) ||
            isDiagnostic(a, imported) ||
            isDiagnostic(b, imported) ||
            inDiagnostic(a, imported) ||
            isInertDeclaration(a, b) ||
            isInertDeclaration(b, a)
          ) {
            continue;
          }
          const [textA, textB] = [a.getText(sourceFile), b.getText(sourceFile)];
          if (textA === textB) {
            continue;
          }
          const start = a.getStart(sourceFile);
          const between = source.slice(a.end, b.getStart(sourceFile));
          add("swap", start, b.end, textB + between + textA, firstLine(textA));
          const mutant = mutants[mutants.length - 1];
          mutant.replacement = `moved below: ${firstLine(textB)}`;
          mutant.anchors.push(b.getStart(sourceFile));
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  const seen = new Set();
  return mutants.filter((m) => {
    if (m.text === source || seen.has(m.text)) {
      return false;
    }
    seen.add(m.text);
    return true;
  });
}

// Debug output: `debugLog(...)` and `if (debug.<channel>) { ... }` without an else. The
// operators target the logic; Stryker's mutators cover the messages.
function isDiagnostic(node, imported) {
  if (ts.isExpressionStatement(node)) {
    const call = node.expression;
    return (
      ts.isCallExpression(call) &&
      ts.isIdentifier(call.expression) &&
      call.expression.text === "debugLog" &&
      imported.has("debugLog")
    );
  }
  if (ts.isIfStatement(node) && !node.elseStatement && imported.has("debug")) {
    let mentions = false;
    const visit = (n) => {
      if (ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.expression)) {
        mentions ||= n.expression.text === "debug";
      }
      ts.forEachChild(n, visit);
    };
    visit(node.expression);
    return mentions;
  }
  return false;
}

function inDiagnostic(node, imported) {
  for (let n = node; n; n = n.parent) {
    if (isDiagnostic(n, imported)) {
      return true;
    }
  }
  return false;
}

// `let failed = false` next to a statement that does not name `failed`: in either order the
// same, so a swap with it is equivalent by construction.
function isInertDeclaration(declaration, other) {
  if (!ts.isVariableStatement(declaration)) {
    return false;
  }
  const names = [];
  for (const decl of declaration.declarationList.declarations) {
    const init = decl.initializer;
    const inert =
      !init ||
      ts.isLiteralExpression(init) ||
      init.kind === ts.SyntaxKind.TrueKeyword ||
      init.kind === ts.SyntaxKind.FalseKeyword ||
      init.kind === ts.SyntaxKind.NullKeyword ||
      (ts.isIdentifier(init) && init.text === "undefined");
    if (!inert) {
      return false;
    }
    bindingNames(decl.name, names);
  }
  let named = false;
  const visit = (n) => {
    named ||= ts.isIdentifier(n) && names.includes(n.text);
    ts.forEachChild(n, visit);
  };
  visit(other);
  return !named;
}

function firstLine(text) {
  return text.split("\n")[0].trim();
}

function without(pieces, i) {
  return [...pieces.slice(0, i), ...pieces.slice(i + 1)];
}

function headKey(chain, head = chain.headName) {
  return `${head}${chain.pieces[1].replace(/[!?]/g, "")}`;
}

function importedNames(sourceFile) {
  const names = new Set();
  for (const statement of sourceFile.statements) {
    const bindings = ts.isImportDeclaration(statement) && statement.importClause;
    if (!bindings) {
      continue;
    }
    if (bindings.name) {
      names.add(bindings.name.text);
    }
    const named = bindings.namedBindings;
    if (named && ts.isNamedImports(named)) {
      named.elements.forEach((element) => names.add(element.name.text));
    } else if (named) {
      names.add(named.name.text);
    }
  }
  return names;
}

function isChainLink(node) {
  return ts.isPropertyAccessExpression(node) || ts.isNonNullExpression(node);
}

function continuesChain(node) {
  const parent = node.parent;
  return isChainLink(parent) && parent.expression === node;
}

// A member chain `a.b!.c?.d` as pieces ["a", ".b!", ".c", "?.d"]: dropping one piece but the
// first and the last keeps it syntactically valid.
function chainPieces(node, sourceFile) {
  const links = [];
  let current = node;
  while (isChainLink(current)) {
    links.unshift(current);
    current = current.expression;
  }
  const head = current;
  const pieces = [head.getText(sourceFile)];
  let boundary = head.end;
  for (const link of links) {
    const text = sourceFile.text.slice(boundary, link.end);
    if (ts.isPropertyAccessExpression(link)) {
      pieces.push(text);
    } else {
      pieces[pieces.length - 1] += text;
    }
    boundary = link.end;
  }
  return { head, pieces };
}

function collectChains(sourceFile) {
  const chains = [];
  const visit = (node) => {
    if (isChainLink(node) && !continuesChain(node)) {
      const { head, pieces } = chainPieces(node, sourceFile);
      if (pieces.length >= 2 && !isAssignedTypeOnly(node)) {
        const headName =
          head.kind === ts.SyntaxKind.ThisKeyword
            ? "this"
            : ts.isIdentifier(head)
              ? head.text
              : null;
        chains.push({ node, start: node.getStart(sourceFile), end: node.end, pieces, headName });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return chains;
}

function isAssignedTypeOnly(node) {
  for (let n = node.parent; n; n = n.parent) {
    if (ts.isTypeNode(n) || ts.isHeritageClause(n)) {
      return true;
    }
  }
  return false;
}

function functionBoundary(node) {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isArrowFunction(node)
  );
}

function bindingNames(name, out) {
  if (ts.isIdentifier(name)) {
    out.push(name.text);
  } else {
    for (const element of name.elements) {
      if (!ts.isOmittedExpression(element)) {
        bindingNames(element.name, out);
      }
    }
  }
  return out;
}

// The locals a chain at `position` can reach, declared before it: parameters and variables of the
// functions around it (block scoping is approximated by the enclosing blocks), and `this` inside
// a class member. Module-level names are not receivers: swapping one global map for another is
// not the defect this operator models.
function receiversInScope(node, position) {
  const names = new Set();
  let thisReachable = true;
  for (let scope = node.parent; scope; scope = scope.parent) {
    if (ts.isBlock(scope) || ts.isCaseOrDefaultClause(scope)) {
      for (const statement of scope.statements) {
        if (statement.getStart() >= position) {
          break;
        }
        if (ts.isVariableStatement(statement)) {
          for (const decl of statement.declarationList.declarations) {
            bindingNames(decl.name, []).forEach((n) => names.add(n));
          }
        }
      }
    }
    if (
      (ts.isForOfStatement(scope) || ts.isForInStatement(scope) || ts.isForStatement(scope)) &&
      scope.initializer &&
      ts.isVariableDeclarationList(scope.initializer)
    ) {
      for (const decl of scope.initializer.declarations) {
        bindingNames(decl.name, []).forEach((n) => names.add(n));
      }
    }
    if (ts.isCatchClause(scope) && scope.variableDeclaration) {
      bindingNames(scope.variableDeclaration.name, []).forEach((n) => names.add(n));
    }
    if (functionBoundary(scope)) {
      for (const param of scope.parameters) {
        bindingNames(param.name, []).forEach((n) => names.add(n));
      }
      if (ts.isFunctionDeclaration(scope) || ts.isFunctionExpression(scope)) {
        thisReachable = false;
      }
    }
    if (ts.isClassLike(scope) && thisReachable) {
      names.add("this");
      thisReachable = false;
    }
  }
  return names;
}

// `const root = this.root!` makes `root.node` stand for `this.root!.node`: its pieces, so that a
// chain through the alias can lose a segment of the aliased path.
function aliasOf(node, name) {
  for (let scope = node.parent; scope; scope = scope.parent) {
    if (!ts.isBlock(scope) && !ts.isSourceFile(scope)) {
      continue;
    }
    for (const statement of scope.statements) {
      if (statement.getStart() >= node.getStart()) {
        break;
      }
      if (
        !ts.isVariableStatement(statement) ||
        !(statement.declarationList.flags & ts.NodeFlags.Const)
      ) {
        continue;
      }
      for (const decl of statement.declarationList.declarations) {
        if (ts.isIdentifier(decl.name) && decl.name.text === name && decl.initializer) {
          let init = decl.initializer;
          while (ts.isParenthesizedExpression(init)) {
            init = init.expression;
          }
          if (!isChainLink(init)) {
            return null;
          }
          const { pieces } = chainPieces(init, node.getSourceFile());
          return pieces.length >= 2 ? pieces : null;
        }
      }
    }
    if (functionBoundary(scope.parent ?? scope)) {
      break;
    }
  }
  return null;
}
