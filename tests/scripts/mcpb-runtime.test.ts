/** @fileoverview Keep runtime skill modules in cleaned MCPB bundles. */
import { describe, expect, it } from 'vitest';
import { filterAgentDocEntries } from '../../scripts/clean-mcpb.js';

describe('MCPB agent documentation exclusions', () => {
  it('removes package-root guides while retaining SDK runtime skill modules', () => {
    const docs = [
      'node_modules/@cyanheads/mcp-ts-core/framework-skills/add-tool/SKILL.md',
      'node_modules/example/skills/example/SKILL.md',
      'node_modules/example/node_modules/nested/.agents/guide.md',
    ];
    const runtime = [
      'node_modules/@modelcontextprotocol/server/dist/ext/skills/index.mjs',
      'node_modules/@modelcontextprotocol/server/dist/ext/skills/node.mjs',
      'node_modules/@modelcontextprotocol/core/dist/ext/skills/index.mjs',
      'skills/wsdot-guide/SKILL.md',
    ];
    expect(filterAgentDocEntries([...docs, ...runtime])).toEqual(docs);
  });
});
