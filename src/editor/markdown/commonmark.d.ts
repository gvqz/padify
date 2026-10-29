/**
 * The cmark reference implementation's npm port ships no type declarations
 * of its own — the two members the co-oracle uses (render.testkit.ts) are
 * declared here. The library is a devDependency; this ambient declaration
 * never reaches the app bundle.
 */
declare module 'commonmark' {
  export class Parser {
    parse(input: string): Node;
  }

  export class HtmlRenderer {
    render(node: Node): string;
  }

  // The node type is opaque to the co-oracle — it parses and renders in
  // one breath, and the declaration exists only to keep tsc quiet.
  type Node = object;
}
