import { type Address, type Hex, type PublicClient } from "viem";
import { type PrivateKeyAccount, privateKeyToAccount } from "viem/accounts";
import { HttpError } from "../../api/http";
import { AUTHOR_VERIFICATION_TYPES, TWEET_LAUNCH_TYPES } from "../../shared/core/tweet";
import { feeVaultAbi, memeFunConfigAbi } from "../../shared/abis";
import type { Deployment } from "../deployment";

export const tweetLaunchTypes = TWEET_LAUNCH_TYPES;
export const authorVerificationTypes = AUTHOR_VERIFICATION_TYPES;

export const tweetConfigAbi = memeFunConfigAbi;
export const tweetVaultReadAbi = feeVaultAbi;

/** Both EIP-712 signatures use the one explicitly configured, on-chain authorized attestor. */
export function createTweetAttestor(key: string | undefined, client: PublicClient, deployment: Deployment) {
  let account: PrivateKeyAccount | null = null;
  if (key && /^0x[0-9a-fA-F]{64}$/.test(key)) {
    try { account = privateKeyToAccount(key as Hex); } catch { /* Misconfigured signing is unavailable, never a fake signature. */ }
  }
  const factoryDomain = { name: "MemeFunFactory", version: "1", chainId: deployment.chainId, verifyingContract: deployment.factory } as const;
  const vaultDomain = { name: "MemeFunFeeVault", version: "1", chainId: deployment.chainId, verifyingContract: deployment.feeVault } as const;
  let support: { value: boolean; until: number } | null = null;
  const configured = async (fresh = false) => {
    if (!account) return false;
    if (!fresh && support && support.until > Date.now()) return support.value;
    const authorized = await client.readContract({ address: deployment.config, abi: tweetConfigAbi, functionName: "tweetAttestor" }).catch(() => null);
    const value = authorized?.toLowerCase() === account.address.toLowerCase();
    support = { value, until: Date.now() + 20_000 };
    return value;
  };
  const required = async () => {
    if (!account || !await configured(true)) throw new HttpError(503, "tweet_attestor_unavailable", "Verified author fees are not configured for this deployment yet.");
    return account;
  };
  return {
    supported: configured,
    async launch(input: { launcher: Address; salt: Hex; postId: string; authorXUserId: string; authorShareBps: number }) {
      const signer = await required();
      const deadline = (await client.getBlock()).timestamp + 300n;
      const signature = await signer.signTypedData({ domain: factoryDomain, types: tweetLaunchTypes, primaryType: "TweetLaunch",
        message: { ...input, postId: BigInt(input.postId), authorXUserId: BigInt(input.authorXUserId), deadline } });
      return { deadline: deadline.toString(), signature };
    },
    async verification(input: { coin: Address; authorXUserId: string; wallet: Address; verifyBy: bigint; verifiedWallet: Address }) {
      const signer = await required();
      const now = (await client.getBlock()).timestamp;
      if (input.verifiedWallet !== "0x0000000000000000000000000000000000000000") throw new HttpError(409, "author_already_verified", "This coin's author wallet is already permanently verified.");
      const deadline = now + 300n;
      const signature = await signer.signTypedData({ domain: vaultDomain, types: authorVerificationTypes, primaryType: "AuthorVerification",
        message: { coin: input.coin, authorXUserId: BigInt(input.authorXUserId), wallet: input.wallet, deadline } });
      return { deadline: deadline.toString(), signature };
    },
    async attribution(coin: Address) {
      try {
        const [postId, authorXUserId, authorShareBps, verifyBy, verifiedWallet] = await client.readContract({
          address: deployment.feeVault, abi: tweetVaultReadAbi, functionName: "tweetAttribution", args: [coin],
        });
        if (postId === 0n) throw new HttpError(404, "tweet_coin_not_found", "This coin has no tweet author fee attribution.");
        return { postId: postId.toString(), authorXUserId: authorXUserId.toString(), authorShareBps, verifyBy: BigInt(verifyBy),
          treasuryUnlockAt: BigInt(verifyBy), verifiedWallet };
      } catch (error) {
        if (error instanceof HttpError) throw error;
        throw new HttpError(503, "author_chain_unavailable", "Author attribution could not be read from this deployment.");
      }
    },
    async pending(coin: Address, quote: Address) {
      try { return await client.readContract({ address: deployment.feeVault, abi: tweetVaultReadAbi, functionName: "authorPendingFor", args: [coin, quote] }); }
      catch { throw new HttpError(503, "author_chain_unavailable", "Author balances could not be read from this deployment."); }
    },
    async now() { return (await client.getBlock()).timestamp; },
  };
}
export type TweetAttestor = ReturnType<typeof createTweetAttestor>;
