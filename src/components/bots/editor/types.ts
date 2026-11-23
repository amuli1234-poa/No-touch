/** Shapes shared between the editor view and the lazily-loaded Blockly runtime. */

/** An unknown block type, so a placeholder definition exists before load. */
export interface UnknownBlockSeed {
  type: string;
  shape: 'stack' | 'value';
  fields: { name: string }[];
  inputs: { name: string; kind: 'statement' | 'value' }[];
}
