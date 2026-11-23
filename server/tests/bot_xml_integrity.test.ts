/**
 * XML integrity: a strategy must survive import → edit → save → reopen → export
 * without losing meaning.
 *
 * Block *counts* are a weak check — a save can drop a `<mutation><arg>` and keep
 * the count identical while destroying a procedure signature. So these tests
 * compare two trees semantically: every block's type, id, attributes, fields
 * (name, value and variable id), mutation attributes and children, input names
 * and kinds, shadows, and the `<next>` order. A difference anywhere is reported
 * with the path that differs.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { treeToXml, xmlToTree, type BlockTree, type TreeNode } from '../bots/tree.js';

const FIXTURE = fs.readFileSync(
  path.join(import.meta.dirname, '..', '..', 'Digit_Differs_AI.xml'),
  'utf8'
);

/* ------------------------- semantic comparison -------------------------- */

interface SemanticNode {
  type: string;
  id?: string;
  attrs: Record<string, string>;
  fields: string[];
  mutation?: Record<string, string>;
  mutationChildren: string[];
  comment: string | null;
  shadows: string[];
  inputs: { name: string; kind: string; block: SemanticNode | null; shadow: string | null }[];
  next: SemanticNode | null;
}

function semantic(node: TreeNode): SemanticNode {
  return {
    type: node.type,
    ...(node.id ? { id: node.id } : {}),
    attrs: { ...(node.attrs ?? {}) },
    // Sort fields by name so a reordering that Blockly itself performs is not
    // treated as a change; the values and ids must still match.
    fields: [...node.fields]
      .map((f) => `${f.name}=${f.value}${f.id ? `#${f.id}` : ''}`)
      .sort(),
    ...(node.mutation ? { mutation: { ...node.mutation } } : {}),
    // Order is significant for procedure parameters, so this list is NOT sorted.
    mutationChildren: (node.mutationChildren ?? []).map(
      (c) => `${c.name}${JSON.stringify(c.attrs)}${c.text ?? ''}`
    ),
    comment: node.comment ? `${JSON.stringify(node.comment.attrs)}:${node.comment.text}` : null,
    shadows: node.shadows.map((s) => `${s.name}:${s.type}:${s.fields.map((f) => `${f.name}=${f.value}`).join(',')}`),
    // Input order is significant for Blockly's connection layout. An input with
    // nothing connected is dropped on save, which cannot change behaviour — a
    // connection that does not exist is the same as one that is absent — so
    // empty inputs are omitted here rather than reported as a difference.
    inputs: node.inputs.filter((i) => i.block !== null).map((i) => ({
      name: i.name,
      kind: i.kind,
      block: i.block ? semantic(i.block) : null,
      shadow: i.shadow ? `${i.shadow.type}:${i.shadow.fields.map((f) => `${f.name}=${f.value}`).join(',')}` : null
    })),
    next: node.next ? semantic(node.next) : null
  };
}

function semanticTree(tree: BlockTree) {
  return {
    attrs: { ...tree.attrs },
    variables: tree.variables.map((v) => `${v.id}:${v.name}${v.type ? `:${v.type}` : ''}`).sort(),
    blocks: tree.blocks.map(semantic)
  };
}

function assertRoundTrips(label: string, xml: string): BlockTree {
  const first = xmlToTree(xml);
  const once = treeToXml(first);
  const second = xmlToTree(once);

  assert.deepEqual(
    semanticTree(second),
    semanticTree(first),
    `${label}: the tree changed meaning after one save/reopen cycle`
  );

  // A second cycle must be a fixed point, not merely equivalent.
  assert.equal(treeToXml(second), once, `${label}: serialisation is not stable across cycles`);
  return first;
}

/* ------------------------------- fixtures ------------------------------- */

/** A procedure with a signature, an argument, a return and a mutation. */
const PROCEDURE_BOT = `<xml xmlns="http://www.w3.org/1999/xhtml" is_dbot="true">
  <variables>
    <variable id="v1">total</variable>
    <variable id="id_n">n</variable>
  </variables>
  <block type="trade_definition" id="def1" deletable="false" x="0" y="0">
    <statement name="TRADE_OPTIONS">
      <block type="trade_definition_market" id="m1">
        <field name="MARKET_LIST">synthetic_index</field>
        <field name="SUBMARKET_LIST">random_index</field>
        <field name="SYMBOL_LIST">R_100</field>
      </block>
    </statement>
  </block>
  <block type="before_purchase" id="bp1">
    <statement name="BEFOREPURCHASE_STACK">
      <block type="procedures_callnoreturn" id="c1">
        <mutation name="double"></mutation>
        <value name="ARG0"><shadow type="math_number"><field name="NUM">2</field></shadow></value>
        <next><block type="purchase" id="p1"><field name="PURCHASE_LIST">CALL</field></block></next>
      </block>
    </statement>
  </block>
  <block type="procedures_defreturn" id="d1" collapsed="false">
    <mutation><arg name="n" varid="id_n"></arg></mutation>
    <field name="NAME">double</field>
    <statement name="STACK">
      <block type="math_change" id="mc1">
        <field name="VAR" id="v1">total</field>
        <value name="DELTA"><block type="variables_get" id="vg1"><field name="VAR" id="id_n">n</field></block></value>
      </block>
    </statement>
    <value name="RETURN">
      <block type="math_arithmetic" id="ma1">
        <field name="OP">MULTIPLY</field>
        <value name="A"><block type="variables_get" id="vg2"><field name="VAR" id="id_n">n</field></block></value>
        <value name="B"><shadow type="math_number"><field name="NUM">2</field></shadow></value>
      </block>
    </value>
  </block>
  <block type="during_purchase" id="dp1">
    <statement name="DURING_PURCHASE_STACK"></statement>
  </block>
  <block type="after_purchase" id="ap1">
    <statement name="AFTERPURCHASE_STACK"><block type="trade_again" id="ta1"></block></statement>
  </block>
</xml>`;

/* -------------------------------- tests --------------------------------- */

test('xml: the real exported fixture survives a save/reopen cycle unchanged', () => {
  const tree = assertRoundTrips('Digit_Differs_AI.xml', FIXTURE);
  // Sanity: it is a real strategy, not an empty shell.
  assert.ok(tree.blocks.length > 0);
});

test('xml: a procedure signature, mutation and return survive round-trip', () => {
  const tree = assertRoundTrips('procedure bot', PROCEDURE_BOT);

  const def = tree.blocks.find((b) => b.type === 'procedures_defreturn')!;
  assert.ok(def, 'the definition block must survive');
  assert.equal(def.mutationChildren?.length, 1, 'the <arg> child must survive');
  assert.equal(def.mutationChildren![0].attrs.name, 'n');
  assert.equal(def.mutationChildren![0].attrs.varid, 'id_n');
  assert.ok(
    def.inputs.some((i) => i.name === 'RETURN' && i.block?.type === 'math_arithmetic'),
    'the RETURN value input must survive'
  );
});

test('xml: block ids, non-structural attributes and coordinates survive', () => {
  const tree = assertRoundTrips('attributes', PROCEDURE_BOT);
  const def = tree.blocks.find((b) => b.type === 'trade_definition')!;
  assert.equal(def.id, 'def1');
  assert.equal(def.attrs?.deletable, 'false', 'deletable="false" must not be stripped');
  assert.equal(def.attrs?.x, '0');
  assert.equal(def.attrs?.y, '0');
});

test('xml: variable ids are preserved, not rewritten to names', () => {
  const tree = assertRoundTrips('variables', PROCEDURE_BOT);
  const get = tree.blocks
    .find((b) => b.type === 'procedures_defreturn')!
    .inputs.find((i) => i.name === 'STACK')!
    .block!.inputs.find((i) => i.name === 'DELTA')!
    .block!;
  assert.equal(get.fields.find((f) => f.name === 'VAR')?.id, 'id_n');
});

test('xml: nested statements and <next> ordering survive', () => {
  const tree = assertRoundTrips('ordering', PROCEDURE_BOT);
  const before = tree.blocks.find((b) => b.type === 'before_purchase')!;
  const head = before.inputs.find((i) => i.name === 'BEFOREPURCHASE_STACK')!.block!;
  assert.equal(head.type, 'procedures_callnoreturn');
  assert.equal(head.next?.type, 'purchase', 'the block after the call must stay after it');
});

test('xml: shadows inside value inputs are preserved alongside the real block', () => {
  const tree = assertRoundTrips('shadows', PROCEDURE_BOT);
  const ret = tree.blocks
    .find((b) => b.type === 'procedures_defreturn')!
    .inputs.find((i) => i.name === 'RETURN')!.block!;
  const b = ret.inputs.find((i) => i.name === 'B')!;
  // B holds a shadow-only default, surfaced as the block.
  assert.equal(b.block?.shadow, true);
});

test('xml: editing a field and saving preserves everything else', () => {
  const tree = xmlToTree(PROCEDURE_BOT);
  const def = tree.blocks.find((b) => b.type === 'procedures_defreturn')!;
  const op = def.inputs.find((i) => i.name === 'RETURN')!.block!;
  const field = op.fields.find((f) => f.name === 'OP')!;
  field.value = 'ADD';

  const saved = treeToXml(tree);
  const reopened = xmlToTree(saved);
  const def2 = reopened.blocks.find((b) => b.type === 'procedures_defreturn')!;
  const op2 = def2.inputs.find((i) => i.name === 'RETURN')!.block!;

  assert.equal(op2.fields.find((f) => f.name === 'OP')?.value, 'ADD', 'the edit persisted');
  // And the untouched parts are still intact.
  assert.equal(def2.mutationChildren?.[0].attrs.varid, 'id_n');
  assert.equal(reopened.variables.length, tree.variables.length);
});

test('xml: an unknown block is preserved with its raw shape rather than dropped', () => {
  const xml = `<xml is_dbot="true">
    <variables><variable id="v1">x</variable></variables>
    <block type="before_purchase">
      <statement name="BEFOREPURCHASE_STACK">
        <block type="some_vendor_block" custom="keepme">
          <field name="ODD">value</field>
          <value name="IN"><block type="math_number"><field name="NUM">7</field></block></value>
          <next><block type="purchase"><field name="PURCHASE_LIST">CALL</field></block></next>
        </block>
      </statement>
    </block>
  </xml>`;

  const tree = assertRoundTrips('unknown block', xml);
  const stack = tree.blocks[0].inputs.find((i) => i.name === 'BEFOREPURCHASE_STACK')!.block!;
  assert.equal(stack.type, 'some_vendor_block');
  assert.equal(stack.attrs?.custom, 'keepme');
  assert.equal(stack.fields.find((f) => f.name === 'ODD')?.value, 'value');
  assert.equal(stack.next?.type, 'purchase');
});

test('xml: several <block> siblings in one <statement> are all kept, in order', () => {
  // Blockly writes one block per statement, but hand-edited exports put several
  // siblings in one. Dropping the extras would delete part of the strategy.
  const xml = `<xml is_dbot="true">
    <block type="before_purchase">
      <statement name="BEFOREPURCHASE_STACK">
        <block type="variables_set"><field name="VAR">a</field></block>
        <block type="variables_set"><field name="VAR">b</field></block>
        <block type="purchase"><field name="PURCHASE_LIST">CALL</field></block>
      </statement>
    </block>
  </xml>`;

  const tree = xmlToTree(xml);
  const head = tree.blocks[0].inputs[0].block!;
  assert.equal(head.next?.type, 'variables_set');
  assert.equal(head.next?.next?.type, 'purchase');
  assertRoundTrips('sibling blocks', xml);
});

test('xml: an empty statement input is not silently turned into a different strategy', () => {
  const tree = assertRoundTrips('empty statement', PROCEDURE_BOT);
  const during = tree.blocks.find((b) => b.type === 'during_purchase')!;
  const stack = during.inputs.find((i) => i.name === 'DURING_PURCHASE_STACK')!;
  // Either the empty input is kept as empty or dropped; what matters is that it
  // never acquires a block, which would invent behaviour.
  assert.equal(stack.block, null);
});

test('xml: a block comment keeps its text and its display attributes', () => {
  // Comments are user-authored. Losing them on save would quietly delete notes
  // from someone's strategy, so both the text and Blockly's display attributes
  // must survive.
  const xml = `<xml is_dbot="true">
    <block type="before_purchase" id="b1">
      <comment pinned="true" h="80" w="160">sell when &amp; only when</comment>
      <statement name="BEFOREPURCHASE_STACK">
        <block type="purchase" id="p1"><field name="PURCHASE_LIST">CALL</field></block>
      </statement>
    </block>
  </xml>`;

  const tree = assertRoundTrips('comment', xml);
  const comment = tree.blocks[0].comment;
  assert.ok(comment, 'the comment must be kept');
  assert.equal(comment.text, 'sell when & only when', 'the text must be unescaped exactly once');
  assert.equal(comment.attrs.pinned, 'true');
  assert.equal(comment.attrs.h, '80');
  assert.equal(comment.attrs.w, '160');
});

test('xml: a comment survives an edit-and-save of a neighbouring field', () => {
  const tree = xmlToTree(PROCEDURE_BOT);
  tree.blocks.find((b) => b.type === 'before_purchase')!.comment = {
    text: 'entry point',
    attrs: { pinned: 'false' }
  };
  const reopened = xmlToTree(treeToXml(tree));
  assert.equal(reopened.blocks.find((b) => b.type === 'before_purchase')!.comment?.text, 'entry point');
});

test('xml: the fixture keeps every block type it started with', () => {
  const before = new Map<string, number>();
  const count = (n: TreeNode) => {
    before.set(n.type, (before.get(n.type) ?? 0) + 1);
    for (const input of n.inputs) if (input.block) count(input.block);
    if (n.next) count(n.next);
  };
  const original = xmlToTree(FIXTURE);
  for (const b of original.blocks) count(b);

  const saved = xmlToTree(treeToXml(xmlToTree(FIXTURE)));
  const after = new Map<string, number>();
  const count2 = (n: TreeNode) => {
    after.set(n.type, (after.get(n.type) ?? 0) + 1);
    for (const input of n.inputs) if (input.block) count2(input.block);
    if (n.next) count2(n.next);
  };
  for (const b of saved.blocks) count2(b);

  assert.deepEqual(Object.fromEntries([...after].sort()), Object.fromEntries([...before].sort()));
});
