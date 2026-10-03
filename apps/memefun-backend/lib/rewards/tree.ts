import { StandardMerkleTree } from "@openzeppelin/merkle-tree";
import { type Address, type Hex, encodeAbiParameters, getAddress, keccak256 } from "viem";

/**
 * One Merkle root per epoch covering every holder-mode coin. Leaves are OpenZeppelin's standard
 * double-hashed `abi.encode(epoch, coin, index, account, amount)`, exactly
 * HolderRewardDistributor.leaf, so a proof from this tree verifies on chain.
 */
export const LEAF_ENCODING = ["uint64", "address", "uint256", "address", "uint256"] as const;

export interface RewardLeaf {
  epoch: bigint;
  coin: Address;
  /** Position in the coin's claimed-bitmap for this epoch, from 0. */
  index: bigint;
  account: Address;
  amount: bigint;
}

export function leafHash(leaf: RewardLeaf): Hex {
  const inner = keccak256(
    encodeAbiParameters(
      LEAF_ENCODING.map((type) => ({ type })),
      [leaf.epoch, leaf.coin, leaf.index, leaf.account, leaf.amount],
    ),
  );
  return keccak256(inner);
}

export function buildRewardTree(leaves: readonly RewardLeaf[]) {
  if (leaves.length === 0) throw new Error("an epoch needs at least one leaf");
  const values = leaves.map((l) => [l.epoch.toString(), getAddress(l.coin), l.index.toString(), getAddress(l.account), l.amount.toString()]);
  const tree = StandardMerkleTree.of(values, [...LEAF_ENCODING]);
  return {
    root: tree.root as Hex,
    proofs: leaves.map((_, i) => tree.getProof(i) as Hex[]),
    /** Full dump: the leaf set anyone can use to recompute and check the root. */
    dump: tree.dump(),
  };
}
