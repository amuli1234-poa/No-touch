/**
 * DBot XML <-> editable block tree.
 *
 * A DBot export is Blockly XML. `NormalizedBot` (types.ts) summarises what a
 * strategy *means*; this module keeps the structure instead — every block, its
 * fields, its nested value/statement inputs, its `<next>` chain and its
 * `<mutation>` — so the browser can render the strategy as blocks and hand the
 * user back the exact same strategy after an edit.
 *
 * The tree is deliberately lossless for anything it does not understand:
 *
 *   * `unknown` blocks keep their original attributes, children and raw inner
 *     XML, so a block No-touch cannot interpret survives a load/save cycle
 *     untouched rather than being silently deleted.
 *   * `<shadow>` inputs are kept as their own node kind, because DBot wraps
 *     literal numbers and dropdown defaults in shadows and dropping one changes
 *     the strategy.
 *   * Text that is not a block (comments, stray whitespace) is not modelled;
 *     it carries no behaviour and DBot rewrites it on every save.
 *
 * Everything here is pure and DOM-free so it can run in the server and under
 * the test runner, which has no DOM. The browser never parses XML itself: it
 * receives a tree and renders it with Blockly.
 */

import {
  DEFAULT_XML_LIMITS,
  childElements,
  firstChild,
  parseXml,
  textContent,
  type XmlElement,
  type XmlLimits
} from './xml.js';

/** A `<field name="X">value</field>`. */
export interface TreeField {
  name: string;
  value: string;
}

/** A `<value>` or `<statement>` input holding one connected block. */
export interface TreeInput {
  name: string;
  /** `value` inputs hold expressions; `statement` inputs hold block stacks. */
  kind: 'value' | 'statement';
  block: TreeNode | null;
  /**
   * The default shadow Blockly keeps alongside a connected block, e.g.
   * `<value name="AMOUNT"><shadow type="math_number_positive"/><block .../></value>`.
   * Preserved so re-serialising does not lose the field's default.
   */
  shadow?: { type: string; fields: TreeField[] };
}

export interface TreeNode {
  /** Blockly block type, e.g. `controls_if`. */
  type: string;
  /** Present when the block carries a stable id in the source file. */
  id?: string;
  /** True for a `<shadow>` literal rather than a real strategy block. */
  shadow?: boolean;
  /** True when the block type is absent from the registry. */
  unknown?: boolean;
  /** Non-`field`/`value`/`statement`/`next` attributes, preserved verbatim. */
  attrs?: Record<string, string>;
  fields: TreeField[];
  inputs: TreeInput[];
  /**
   * `<shadow>` children written directly under the block rather than inside an
   * input, e.g. a statement-level default. Kept in source order.
   */
  shadows: TreeShadow[];
  /** Raw `<mutation>` attributes, e.g. `elseif`/`else` counts, variable ids. */
  mutation?: Record<string, string>;
  /** The block connected after this one in the same stack. */
  next: TreeNode | null;
}

/** A `<shadow>` block written directly under its parent block. */
export interface TreeShadow {
  name: string;
  type: string;
  fields: TreeField[];
}

export interface BlockTree {
  /** `<xml>` attributes, notably `is_dbot="true"` and `collection`. */
  attrs: Record<string, string>;
  /** Declared variables, as `<variables>` writes them. */
  variables: { id: string; name: string; type?: string }[];
  /** Top-level blocks, in source order. */
  blocks: TreeNode[];
}

export class TreeError extends Error {
  readonly code: 'malformed' | 'too_large' | 'empty';
  constructor(code: 'malformed' | 'too_large' | 'empty', message: string) {
    super(message);
    this.name = 'TreeError';
    this.code = code;
  }
}

/**
 * Attributes that are modelled as fields rather than copied into `attrs`.
 *
 * Everything else — `deletable`, `movable`, `editable`, `x`/`y`, `disabled`,
 * `collapsed` and any vendor attribute — is preserved verbatim, because DBot
 * treats several of them as meaningful (its trade-definition blocks are
 * `deletable="false"` and must stay that way).
 */
const STRUCTURAL_ATTRS = new Set(['type', 'id']);

function attrsExcept(node: XmlElement, skip: Set<string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(node.attrs)) {
    if (!skip.has(key)) out[key] = value;
  }
  return out;
}

function readFields(node: XmlElement): TreeField[] {
  const out: TreeField[] = [];
  for (const field of childElements(node, 'field')) {
    const name = field.attrs.name;
    if (typeof name !== 'string') continue;
    out.push({ name, value: textContent(field) });
  }
  return out;
}

/**
 * Reads one `<block>` (or `<shadow>`) into a node, recursing through inputs and
 * the `<next>` chain.
 */
function readBlock(node: XmlElement, shadow: boolean, depth: number): TreeNode {
  if (depth > DEFAULT_XML_LIMITS.maxDepth) {
    throw new TreeError('too_large', 'The strategy nests too deeply to open in the editor.');
  }
  const type = node.attrs.type ?? '';
  const treeNode: TreeNode = {
    type,
    fields: readFields(node),
    inputs: [],
    shadows: [],
    next: null
  };
  if (node.attrs.id) treeNode.id = node.attrs.id;
  if (shadow) treeNode.shadow = true;
  const attrs = attrsExcept(node, STRUCTURAL_ATTRS);
  if (Object.keys(attrs).length > 0) treeNode.attrs = attrs;

  const mutation = firstChild(node, 'mutation');
  if (mutation) {
    const mutationAttrs = attrsExcept(mutation, new Set());
    if (Object.keys(mutationAttrs).length > 0) treeNode.mutation = mutationAttrs;
  }

  for (const child of node.children) {
    if (child.type !== 'element') continue;
    if (child.name === 'value' || child.name === 'statement') {
      const name = child.attrs.name;
      if (typeof name !== 'string') continue;
      const blockEls = childElements(child, 'block');
      const shadowEl = childElements(child, 'shadow')[0] ?? null;
      const input: TreeInput = {
        name,
        kind: child.name === 'value' ? 'value' : 'statement',
        // A shadow-only input is a literal default; surface it as the block so
        // the editor shows the value the strategy actually uses.
        block: blockEls.length > 0 ? readStack(blockEls, depth + 1) : shadowEl ? readBlock(shadowEl, true, depth + 1) : null
      };
      if (blockEls.length > 0 && shadowEl) {
        input.shadow = { type: shadowEl.attrs.type ?? '', fields: readFields(shadowEl) };
      }
      treeNode.inputs.push(input);
      continue;
    }
    if (child.name === 'next') {
      const nextBlocks = childElements(child, 'block');
      if (nextBlocks.length > 0) treeNode.next = readStack(nextBlocks, depth + 1);
      continue;
    }
    if (child.name === 'shadow') {
      // A shadow directly under the block (not inside a value) is a default.
      const name = child.attrs.name;
      if (typeof name === 'string') {
        treeNode.shadows.push({
          name,
          type: child.attrs.type ?? '',
          fields: readFields(child)
        });
      }
    }
  }
  return treeNode;
}

/**
 * Reads a run of sibling `<block>` elements as one stack.
 *
 * Blockly writes a stack as a chain of `<next>` links, but hand-edited and
 * third-party exports sometimes put several `<block>` siblings inside one
 * `<statement>`. Taking only the first would silently delete the rest of the
 * strategy, so siblings are chained the same way `<next>` is.
 */
function readStack(blocks: XmlElement[], depth: number): TreeNode {
  const head = readBlock(blocks[0], false, depth);
  let tail = head;
  for (let i = 1; i < blocks.length; i += 1) {
    const node = readBlock(blocks[i], false, depth);
    tail.next = node;
    tail = node;
  }
  return head;
}

function readVariables(root: XmlElement): BlockTree['variables'] {
  const out: BlockTree['variables'] = [];
  for (const container of childElements(root, 'variables')) {
    for (const variable of childElements(container, 'variable')) {
      const id = variable.attrs.id;
      if (typeof id !== 'string') continue;
      const entry: { id: string; name: string; type?: string } = {
        id,
        name: textContent(variable)
      };
      if (typeof variable.attrs.type === 'string') entry.type = variable.attrs.type;
      out.push(entry);
    }
  }
  return out;
}

/**
 * Parses a DBot XML document into a `BlockTree`.
 *
 * Throws `TreeError` for input the editor cannot represent; the caller decides
 * whether that is a rejected import or a read-only preview.
 */
export function xmlToTree(xml: string, limits: XmlLimits = DEFAULT_XML_LIMITS): BlockTree {
  let root: XmlElement;
  try {
    root = parseXml(xml, limits);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'The file is not valid XML.';
    throw new TreeError('malformed', message);
  }
  if (root.name !== 'xml') {
    throw new TreeError('malformed', 'The file is not a DBot strategy: its root element is not <xml>.');
  }

  const tree: BlockTree = {
    attrs: attrsExcept(root, new Set()),
    variables: readVariables(root),
    blocks: []
  };

  for (const child of root.children) {
    if (child.type !== 'element') continue;
    if (child.name === 'block') tree.blocks.push(readBlock(child, false, 0));
  }

  if (tree.blocks.length === 0) {
    throw new TreeError('empty', 'The strategy contains no blocks.');
  }
  return tree;
}

/* -------------------------------------------------------------------------- */
/*  Serialisation                                                              */
/* -------------------------------------------------------------------------- */

function escapeXmlText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeXmlAttr(value: string): string {
  return escapeXmlText(value).replace(/"/g, '&quot;');
}

function writeAttrs(attrs: Record<string, string>): string {
  return Object.entries(attrs)
    .map(([key, value]) => ` ${key}="${escapeXmlAttr(value)}"`)
    .join('');
}

function writeBlock(node: TreeNode, indent: string): string {
  const tag = node.shadow ? 'shadow' : 'block';
  const head: Record<string, string> = { type: node.type };
  if (node.id) head.id = node.id;
  if (node.attrs) Object.assign(head, node.attrs);

  const lines: string[] = [`${indent}<${tag}${writeAttrs(head)}>`];
  const inner = `${indent}  `;

  if (node.mutation && Object.keys(node.mutation).length > 0) {
    lines.push(`${inner}<mutation${writeAttrs(node.mutation)}></mutation>`);
  }
  for (const field of node.fields) {
    lines.push(`${inner}<field name="${escapeXmlAttr(field.name)}">${escapeXmlText(field.value)}</field>`);
  }
  for (const shadow of node.shadows) {
    lines.push(
      `${inner}<shadow${writeAttrs({ name: shadow.name, type: shadow.type })}>`
    );
    for (const field of shadow.fields) {
      lines.push(
        `${inner}  <field name="${escapeXmlAttr(field.name)}">${escapeXmlText(field.value)}</field>`
      );
    }
    lines.push(`${inner}</shadow>`);
  }
  for (const input of node.inputs) {
    const inputTag = input.kind === 'value' ? 'value' : 'statement';
    if (!input.block) continue;
    lines.push(`${inner}<${inputTag} name="${escapeXmlAttr(input.name)}">`);
    if (input.shadow) {
      lines.push(`${inner}  <shadow${writeAttrs({ type: input.shadow.type })}>`);
      for (const field of input.shadow.fields) {
        lines.push(
          `${inner}    <field name="${escapeXmlAttr(field.name)}">${escapeXmlText(field.value)}</field>`
        );
      }
      lines.push(`${inner}  </shadow>`);
    }
    lines.push(writeBlock(input.block, `${inner}  `));
    lines.push(`${inner}</${inputTag}>`);
  }
  if (node.next) {
    lines.push(`${inner}<next>`);
    lines.push(writeBlock(node.next, `${inner}  `));
    lines.push(`${inner}</next>`);
  }

  lines.push(`${indent}</${tag}>`);
  return lines.join('\n');
}

/**
 * Writes a `BlockTree` back to DBot XML.
 *
 * The output is deterministic: the same tree always produces byte-identical
 * XML, which is what makes round-trip tests meaningful and what lets the store
 * detect a no-op save.
 */
export function treeToXml(tree: BlockTree): string {
  const lines: string[] = [`<xml${writeAttrs(tree.attrs)}>`];
  if (tree.variables.length > 0) {
    lines.push('  <variables>');
    for (const variable of tree.variables) {
      const attrs: Record<string, string> = { id: variable.id };
      if (variable.type) attrs.type = variable.type;
      lines.push(`    <variable${writeAttrs(attrs)}>${escapeXmlText(variable.name)}</variable>`);
    }
    lines.push('  </variables>');
  }
  for (const block of tree.blocks) {
    lines.push(writeBlock(block, '  '));
  }
  lines.push('</xml>');
  return `${lines.join('\n')}\n`;
}

/* -------------------------------------------------------------------------- */
/*  Traversal helpers                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Marks every node whose type the registry does not know.
 *
 * The editor renders these as read-only placeholder blocks rather than dropping
 * them, and the validator refuses to run a strategy that contains one — so an
 * unknown block is visible, preserved, and blocking, never silently ignored.
 */
export function annotateUnknown(tree: BlockTree, isKnown: (type: string) => boolean): BlockTree {
  for (const node of walkTree(tree)) {
    if (node.type && !isKnown(node.type)) node.unknown = true;
  }
  return tree;
}

/**
 * The distinct unknown block types in a tree, with their field and input
 * names, so the editor can build a placeholder definition for each before
 * Blockly loads the XML.
 */
export function collectUnknownBlocks(
  tree: BlockTree
): { type: string; fields: { name: string }[]; inputs: { name: string; kind: 'value' | 'statement' }[] }[] {
  const byType = new Map<
    string,
    { type: string; fields: { name: string }[]; inputs: { name: string; kind: 'value' | 'statement' }[] }
  >();
  for (const node of walkTree(tree)) {
    if (!node.unknown) continue;
    const existing = byType.get(node.type);
    const fields = node.fields.map((f) => ({ name: f.name }));
    const inputs = node.inputs.map((i) => ({ name: i.name, kind: i.kind }));
    if (!existing) {
      byType.set(node.type, { type: node.type, fields, inputs });
      continue;
    }
    // The same type can appear with different fields across a file; union them
    // so one definition can render every occurrence.
    for (const field of fields) {
      if (!existing.fields.some((f) => f.name === field.name)) existing.fields.push(field);
    }
    for (const input of inputs) {
      if (!existing.inputs.some((i) => i.name === input.name)) existing.inputs.push(input);
    }
  }
  return [...byType.values()];
}

/** Every node in the tree, depth-first, including `<next>` chains. */
export function walkTree(tree: BlockTree): TreeNode[] {
  const out: TreeNode[] = [];
  const stack: TreeNode[] = [...tree.blocks].reverse();
  while (stack.length > 0) {
    const node = stack.pop()!;
    out.push(node);
    if (node.next) stack.push(node.next);
    for (let i = node.inputs.length - 1; i >= 0; i -= 1) {
      const child = node.inputs[i].block;
      if (child) stack.push(child);
    }
  }
  return out;
}

/** Counts blocks by type, including shadows, for the editor's status bar. */
export function countBlocks(tree: BlockTree): { total: number; byType: Record<string, number> } {
  const byType: Record<string, number> = {};
  let total = 0;
  for (const node of walkTree(tree)) {
    byType[node.type] = (byType[node.type] ?? 0) + 1;
    total += 1;
  }
  return { total, byType };
}

/** The first top-level block of a given type, or null. */
export function findTopLevel(tree: BlockTree, type: string): TreeNode | null {
  return tree.blocks.find((block) => block.type === type) ?? null;
}

/** Reads a field value from a node, or null when absent. */
export function fieldValue(node: TreeNode | null | undefined, name: string): string | null {
  if (!node) return null;
  const field = node.fields.find((f) => f.name === name);
  return field ? field.value : null;
}
