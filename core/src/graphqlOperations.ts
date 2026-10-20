// The operations a GraphQL document defines, found with a small scanner rather than the
// graphql parser so the engine and the CLI don't carry that package. Isomorphic.

export interface GraphQlOperation {
  type: "query" | "mutation" | "subscription";
  /** Absent for an anonymous operation. */
  name?: string;
}

/** Top-level operations in document order; fragments are skipped. */
export function graphqlOperations(doc: string): GraphQlOperation[] {
  const ops: GraphQlOperation[] = [];
  let depth = 0;
  let i = 0;
  while (i < doc.length) {
    const ch = doc[i];
    if (ch === "#") {
      while (i < doc.length && doc[i] !== "\n") i++;
      continue;
    }
    if (ch === '"') {
      if (doc.startsWith('"""', i)) {
        const end = doc.indexOf('"""', i + 3);
        i = end < 0 ? doc.length : end + 3;
      } else {
        i++;
        while (i < doc.length && doc[i] !== '"' && doc[i] !== "\n") i += doc[i] === "\\" ? 2 : 1;
        i++;
      }
      continue;
    }
    if (doc.startsWith("{{", i)) {
      const end = doc.indexOf("}}", i + 2);
      if (end >= 0 && !doc.slice(i + 2, end).includes("{")) {
        i = end + 2;
        continue;
      }
    }
    if (ch === "{") {
      if (depth === 0 && !pendingKeyword(doc, i)) ops.push({ type: "query" });
      depth++;
      i++;
      continue;
    }
    if (ch === "}") {
      depth = Math.max(0, depth - 1);
      i++;
      continue;
    }
    if (ch === "$" || ch === "@") {
      i += 1 + (/^[A-Za-z_]\w*/.exec(doc.slice(i + 1))?.[0].length ?? 0);
      continue;
    }
    if (depth === 0 && /[A-Za-z_]/.test(ch)) {
      const word = /^[A-Za-z_]\w*/.exec(doc.slice(i))![0];
      if (word === "query" || word === "mutation" || word === "subscription") {
        const name = /^\s*([A-Za-z_]\w*)/.exec(doc.slice(i + word.length))?.[1];
        ops.push(name ? { type: word, name } : { type: word });
      }
      i += word.length;
      continue;
    }
    i++;
  }
  return ops;
}

/** Whether the `{` at `at` opens an operation or fragment already counted by its keyword. */
function pendingKeyword(doc: string, at: number): boolean {
  // Walk back over the operation's head (name, variables, directives) to the previous
  // top-level `}` or the start; a keyword in between means this brace belongs to it.
  let i = at - 1;
  let parens = 0;
  while (i >= 0) {
    const ch = doc[i];
    if (ch === ")") parens++;
    else if (ch === "(") parens--;
    else if (ch === "}" && parens === 0) break;
    i--;
  }
  const head = doc.slice(i + 1, at).replace(/#[^\n]*/g, "");
  return /(^|[^\w$])(query|mutation|subscription|fragment)\b/.test(head);
}

/**
 * The operationName to send: the chosen one when the document defines it, else the first
 * named operation when there are several (servers refuse a multi-operation document
 * without one), else none.
 */
export function operationNameToSend(doc: string, chosen: string | undefined): string | undefined {
  const all = graphqlOperations(doc);
  const named = all.filter((o) => o.name);
  if (chosen && named.some((o) => o.name === chosen)) return chosen;
  return all.length > 1 ? named[0]?.name : undefined;
}
