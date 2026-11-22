/**
 * Minimal, deliberately strict XML reader for imported bot files.
 *
 * This is not a general-purpose XML library. It exists so that an uploaded
 * file is turned into a plain tree under our own rules, with none of the
 * features that make XML dangerous:
 *
 *   - A DOCTYPE is rejected outright, which removes custom entity
 *     declarations and therefore both external-entity (XXE) and
 *     entity-expansion ("billion laughs") attacks.
 *   - Only the five predefined entities and numeric character references are
 *     decoded. Any other `&name;` is a hard error, so nothing is silently
 *     dropped or expanded.
 *   - Input size, nesting depth and node count are capped.
 *   - Nothing is ever evaluated. The output is data only.
 *
 * The element stack is iterative, so deeply nested input cannot blow the
 * JavaScript call stack before the depth cap is reached.
 */

export interface XmlElement {
  type: 'element';
  /** Tag name exactly as written (case preserved). */
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
}

export interface XmlText {
  type: 'text';
  text: string;
}

export type XmlNode = XmlElement | XmlText;

export type XmlErrorCode =
  | 'empty'
  | 'too_large'
  | 'doctype_forbidden'
  | 'processing_instruction_forbidden'
  | 'unknown_entity'
  | 'malformed'
  | 'too_deep'
  | 'too_many_nodes'
  | 'no_root'
  | 'multiple_roots'
  | 'text_outside_root';

export class XmlError extends Error {
  readonly code: XmlErrorCode;
  constructor(code: XmlErrorCode, message: string) {
    super(message);
    this.name = 'XmlError';
    this.code = code;
  }
}

export interface XmlLimits {
  maxBytes: number;
  maxDepth: number;
  maxNodes: number;
}

export const DEFAULT_XML_LIMITS: XmlLimits = {
  // A DBot strategy is a few kilobytes; large real exports stay well under
  // a megabyte.
  maxBytes: 2 * 1024 * 1024,
  maxDepth: 100,
  maxNodes: 20_000
};

const PREDEFINED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'"
};

const NAME_START = /[A-Za-z_:]/;
const NAME_CHAR = /[A-Za-z0-9_:.\-]/;

function isWhitespace(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';
}

/** Decodes character/entity references, rejecting anything not predefined. */
function decodeEntities(raw: string): string {
  if (raw.indexOf('&') === -1) return raw;
  let out = '';
  let i = 0;
  while (i < raw.length) {
    const ch = raw[i];
    if (ch !== '&') {
      out += ch;
      i += 1;
      continue;
    }
    const semi = raw.indexOf(';', i + 1);
    if (semi === -1) throw new XmlError('malformed', 'Unterminated entity reference');
    const body = raw.slice(i + 1, semi);
    if (body.length === 0) throw new XmlError('malformed', 'Empty entity reference');
    if (body[0] === '#') {
      const isHex = body[1] === 'x' || body[1] === 'X';
      const digits = isHex ? body.slice(2) : body.slice(1);
      if (!/^[0-9a-fA-F]+$/.test(digits)) {
        throw new XmlError('malformed', `Invalid character reference &${body};`);
      }
      const code = parseInt(digits, isHex ? 16 : 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) {
        throw new XmlError('malformed', `Character reference out of range &${body};`);
      }
      out += String.fromCodePoint(code);
      i = semi + 1;
      continue;
    }
    const resolved = PREDEFINED_ENTITIES[body];
    if (resolved === undefined) {
      // Custom entities require a DTD, which we reject, so an unknown entity
      // is always hostile or broken input.
      throw new XmlError('unknown_entity', `Unknown entity &${body};`);
    }
    out += resolved;
    i = semi + 1;
  }
  return out;
}

function readName(src: string, start: number): { name: string; next: number } {
  if (start >= src.length || !NAME_START.test(src[start])) {
    throw new XmlError('malformed', `Expected a tag name at offset ${start}`);
  }
  let i = start + 1;
  while (i < src.length && NAME_CHAR.test(src[i])) i += 1;
  return { name: src.slice(start, i), next: i };
}

function skipWhitespace(src: string, start: number): number {
  let i = start;
  while (i < src.length && isWhitespace(src[i])) i += 1;
  return i;
}

/**
 * Parses a document and returns its single root element.
 *
 * Throws `XmlError` with a stable code for every rejection path, so callers
 * can map failures onto user-facing messages without matching on text.
 */
export function parseXml(input: string, limits: XmlLimits = DEFAULT_XML_LIMITS): XmlElement {
  if (typeof input !== 'string') throw new XmlError('malformed', 'Input is not text');
  if (input.length === 0) throw new XmlError('empty', 'Document is empty');
  if (input.length > limits.maxBytes) {
    throw new XmlError('too_large', `Document exceeds ${limits.maxBytes} characters`);
  }
  // A byte-order mark is legal and harmless; strip it before scanning.
  const src = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;

  const stack: XmlElement[] = [];
  let root: XmlElement | null = null;
  let nodeCount = 0;
  let i = 0;

  const addNode = (node: XmlNode) => {
    nodeCount += 1;
    if (nodeCount > limits.maxNodes) {
      throw new XmlError('too_many_nodes', `Document exceeds ${limits.maxNodes} nodes`);
    }
    const parent = stack[stack.length - 1];
    if (parent) {
      parent.children.push(node);
      return;
    }
    if (node.type === 'element') {
      if (root) throw new XmlError('multiple_roots', 'Document has more than one root element');
      root = node;
      return;
    }
    if (node.text.trim().length > 0) {
      throw new XmlError('text_outside_root', 'Text found outside the root element');
    }
  };

  while (i < src.length) {
    const ch = src[i];

    if (ch === '<') {
      if (src.startsWith('<!--', i)) {
        const end = src.indexOf('-->', i + 4);
        if (end === -1) throw new XmlError('malformed', 'Unterminated comment');
        i = end + 3;
        continue;
      }

      if (src.startsWith('<!DOCTYPE', i) || src.startsWith('<!doctype', i)) {
        throw new XmlError(
          'doctype_forbidden',
          'DOCTYPE declarations are not accepted in imported bot files'
        );
      }
      if (src.startsWith('<!', i)) {
        // CDATA is not used by DBot exports; treat it as unsupported rather
        // than silently unwrapping it.
        throw new XmlError('malformed', 'Unsupported markup declaration');
      }

      if (src.startsWith('<?', i)) {
        const end = src.indexOf('?>', i + 2);
        if (end === -1) throw new XmlError('malformed', 'Unterminated processing instruction');
        const target = src.slice(i + 2, end).trim();
        // Only the XML declaration is tolerated, and only before the root.
        const isDecl = /^xml(\s|$)/i.test(target);
        if (!isDecl || root !== null || stack.length > 0) {
          throw new XmlError(
            'processing_instruction_forbidden',
            'Processing instructions are not accepted in imported bot files'
          );
        }
        i = end + 2;
        continue;
      }

      if (src.startsWith('</', i)) {
        const { name, next } = readName(src, i + 2);
        const closeAt = skipWhitespace(src, next);
        if (src[closeAt] !== '>') throw new XmlError('malformed', `Malformed closing tag </${name}>`);
        const open = stack.pop();
        if (!open) throw new XmlError('malformed', `Unexpected closing tag </${name}>`);
        if (open.name !== name) {
          throw new XmlError('malformed', `Closing tag </${name}> does not match <${open.name}>`);
        }
        i = closeAt + 1;
        continue;
      }

      const { name, next } = readName(src, i + 1);
      const attrs: Record<string, string> = {};
      let p = next;
      let selfClosing = false;
      for (;;) {
        p = skipWhitespace(src, p);
        if (p >= src.length) throw new XmlError('malformed', `Unterminated tag <${name}>`);
        if (src[p] === '>') {
          p += 1;
          break;
        }
        if (src[p] === '/') {
          if (src[p + 1] !== '>') {
            throw new XmlError('malformed', `Malformed self-closing tag <${name}/>`);
          }
          p += 2;
          selfClosing = true;
          break;
        }
        const attr = readName(src, p);
        const eqAt = skipWhitespace(src, attr.next);
        if (src[eqAt] !== '=') throw new XmlError('malformed', `Attribute ${attr.name} has no value`);
        const quoteAt = skipWhitespace(src, eqAt + 1);
        const quote = src[quoteAt];
        if (quote !== '"' && quote !== "'") {
          throw new XmlError('malformed', `Attribute ${attr.name} is not quoted`);
        }
        const valueEnd = src.indexOf(quote, quoteAt + 1);
        if (valueEnd === -1) {
          throw new XmlError('malformed', `Attribute ${attr.name} is not terminated`);
        }
        const rawValue = src.slice(quoteAt + 1, valueEnd);
        if (rawValue.indexOf('<') !== -1) {
          throw new XmlError('malformed', `Attribute ${attr.name} contains a raw '<'`);
        }
        if (Object.prototype.hasOwnProperty.call(attrs, attr.name)) {
          throw new XmlError('malformed', `Duplicate attribute ${attr.name}`);
        }
        attrs[attr.name] = decodeEntities(rawValue);
        p = valueEnd + 1;
      }

      if (stack.length + 1 > limits.maxDepth) {
        throw new XmlError('too_deep', `Document nesting exceeds ${limits.maxDepth} levels`);
      }
      const element: XmlElement = { type: 'element', name, attrs, children: [] };
      addNode(element);
      if (!selfClosing) stack.push(element);
      i = p;
      continue;
    }

    const nextTag = src.indexOf('<', i);
    const end = nextTag === -1 ? src.length : nextTag;
    const raw = src.slice(i, end);
    if (stack.length > 0) {
      const decoded = decodeEntities(raw);
      if (decoded.length > 0) addNode({ type: 'text', text: decoded });
    } else if (raw.trim().length > 0) {
      throw new XmlError('text_outside_root', 'Text found outside the root element');
    }
    i = end;
  }

  if (stack.length > 0) {
    throw new XmlError('malformed', `Unclosed element <${stack[stack.length - 1].name}>`);
  }
  if (!root) throw new XmlError('no_root', 'Document has no root element');
  return root;
}

/* ------------------------------ query helpers ------------------------------ */

/** Direct children with the given tag name. */
export function childElements(node: XmlElement, name: string): XmlElement[] {
  return node.children.filter((c): c is XmlElement => c.type === 'element' && c.name === name);
}

/** First direct child with the given tag name, or null. */
export function firstChild(node: XmlElement, name: string): XmlElement | null {
  return childElements(node, name)[0] ?? null;
}

/** Every descendant element with the given tag name, in document order. */
export function descendants(node: XmlElement, name: string): XmlElement[] {
  const out: XmlElement[] = [];
  const stack: XmlElement[] = [node];
  while (stack.length > 0) {
    const current = stack.pop()!;
    for (let k = current.children.length - 1; k >= 0; k -= 1) {
      const child = current.children[k];
      if (child.type !== 'element') continue;
      if (child.name === name) out.push(child);
      stack.push(child);
    }
  }
  return out;
}

/** Concatenated text content of an element's direct text children. */
export function textContent(node: XmlElement): string {
  return node.children
    .filter((c): c is XmlText => c.type === 'text')
    .map((c) => c.text)
    .join('');
}
