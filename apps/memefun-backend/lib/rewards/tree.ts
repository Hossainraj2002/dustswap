import { StandardMerkleTree } from "@openzeppelin/merkle-tree";
import { type Address, type Hex, encodeAbiParameters, getAddress, keccak256 } from "viem";

/**
 * One Merkle root per epoch. Legacy roots use double-hashed (epoch, coin, index, account, amount).
 * New roots bind payouts to a pool with (uint8(1), epoch, poolId, index, account, amount), matching
 * HolderRewardDistributor.leafFor. Every root uses exactly one of these two encodings.
 */
export const LEAF_ENCODING = ["uint64", "address", "uint256", "address", "uint256"] as const;
export const POOL_LEAF_ENCODING = ["uint8", "uint64", "bytes32", "uint256", "address", "uint256"] as const;

export interface RewardLeaf {
  epoch: bigint;
  coin: Address;
  poolId?: Hex;
  /** Position in the coin's claimed-bitmap for this epoch, from 0. */
  index: bigint;
  account: Address;
  amount: bigint;
}

export function leafHash(leaf: RewardLeaf): Hex {
  if (leaf.poolId) {
    return keccak256(keccak256(encodeAbiParameters(POOL_LEAF_ENCODING.map((type) => ({ type })),
      [1, leaf.epoch, leaf.poolId, leaf.index, leaf.account, leaf.amount])));
  }
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
  const poolFormat = Boolean(leaves[0]!.poolId);
  if (leaves.some((l) => Boolean(l.poolId) !== poolFormat)) throw new Error("an epoch cannot mix legacy and pool-bound leaves");
  const values = leaves.map((l) => poolFormat
    ? ["1", l.epoch.toString(), l.poolId!, l.index.toString(), getAddress(l.account), l.amount.toString()]
    : [l.epoch.toString(), getAddress(l.coin), l.index.toString(), getAddress(l.account), l.amount.toString()]);
  const tree = StandardMerkleTree.of(values, [...(poolFormat ? POOL_LEAF_ENCODING : LEAF_ENCODING)]);
  return {
    root: tree.root as Hex,
    proofs: leaves.map((_, i) => tree.getProof(i) as Hex[]),
    /** Full dump: the leaf set anyone can use to recompute and check the root. */
    dump: tree.dump(),
  };
}
