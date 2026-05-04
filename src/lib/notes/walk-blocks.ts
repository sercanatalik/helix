/* eslint-disable @typescript-eslint/no-explicit-any */
//
// Generic post-order map over a BlockNote block tree. Every block in the
// tree is visited bottom-up: children are mapped first, then the transform
// is applied to the (potentially new) parent. This matches what the math
// and vega bridges need — they rewrite leaf-shaped blocks into custom
// schemas and expect the parent's `children` array to already be processed.

type BlockLike = { children?: BlockLike[] } & Record<string, unknown>;

export type BlockTransform = (block: any) => any;

export function mapBlocks(blocks: any[], transform: BlockTransform): any[] {
  return blocks.map(walk);

  function walk(block: any): any {
    const next = Array.isArray((block as BlockLike)?.children)
      ? { ...block, children: (block as BlockLike).children!.map(walk) }
      : block;
    return transform(next);
  }
}
