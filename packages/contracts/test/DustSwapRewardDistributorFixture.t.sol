// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {DustSwapRewardDistributor} from "../src/DustSwapRewardDistributor.sol";

/// @title Cross-check between buildClaimAllocation.ts and the on-chain verifier
/// @notice The root and proofs below were produced by
///         `apps/api/src/scripts/buildClaimAllocation.ts` from a synthetic 13-account list, then
///         pasted here verbatim. Synthetic on purpose: this file lives in a public repository, so
///         it must never carry real wallet addresses or real allocations.
///
///         13 accounts is deliberate too. An odd leaf count forces the promoted-odd-node path at
///         more than one level, which is where a hand-rolled Merkle builder usually diverges from
///         the verifier. If the TypeScript and Solidity constructions ever drift, this fails.
///
///         Regenerate with:
///           ts-node src/scripts/buildClaimAllocation.ts --csv <fixture> --budget 1000 \
///             --basis fees --no-db --out <dir>
contract DustSwapRewardDistributorFixtureTest is Test {
    bytes32 constant FIXTURE_ROOT = 0xd201f04d4cd49e6ce5a337fa89aad7ac07984567a4526bf1fab3903cf64e12fa;
    uint256 constant FIXTURE_TOTAL = 1_000_000_000; // 1,000.000000 USDC
    uint256 constant FIXTURE_LEAVES = 13;

    DustSwapRewardDistributor internal dist;
    uint256 internal verified;
    uint256 internal summed;

    function setUp() public {
        dist = new DustSwapRewardDistributor(
            address(0xDEAD), FIXTURE_ROOT, FIXTURE_TOTAL, uint64(block.timestamp + 90 days), address(this)
        );
    }

    function _expect(uint256 index, address account, uint256 amount, bytes32[] memory proof) internal {
        assertTrue(_verify(index, account, amount, proof), "generated proof rejected on chain");
        verified++;
        summed += amount;
    }

    /// @dev `verify` takes a calldata proof, so bounce through an external call to convert.
    function verifyExternal(uint256 index, address account, uint256 amount, bytes32[] memory proof)
        external
        view
        returns (bool)
    {
        return dist.verify(index, account, amount, proof);
    }

    function _verify(uint256 index, address account, uint256 amount, bytes32[] memory proof)
        internal
        view
        returns (bool)
    {
        return this.verifyExternal(index, account, amount, proof);
    }

    function test_everyGeneratedProofVerifiesOnChain() public {
        {
            bytes32[] memory p = new bytes32[](4);
            p[0] = 0x78bd3768f5d0fb776a04580dcd963c32ffe4f2576a402ca2b32aab9f2b3b3fa2;
            p[1] = 0x6e0547403c5f51324511c65719cb0a97e066ec17842019ddd64527fe3b3b2058;
            p[2] = 0x19337c088c92d914aec1f0d51116f3fb432c8772dd431f06b0d5848bd4d1d5b6;
            p[3] = 0x872b18cb00585bf92209acdced3c3067268a65ec17d8cf19b922cf5ba32edde4;
            _expect(12, 0xc0FFee0000000000000000000000000000000000, 10989011, p);
        }
        {
            bytes32[] memory p = new bytes32[](4);
            p[0] = 0xb247cfbeb021860248c0a7a072ea2655123abcc8dcb2de36d977990f371ee98d;
            p[1] = 0xcc6171f18647653cd90046b6fb4cd4e0b27fa6151ede18aabcaef953d19d72fe;
            p[2] = 0xf75754e0c55a9ba84542269696e31916126dcbc1c01f74db60cb0012f05fa27e;
            p[3] = 0xf9a96b66eae6f1d7beca97b83ce52e2eb9b3b84bf764bbe3e04dd97a371c6ab8;
            _expect(11, 0xC0FFEe0000000000000000000000000000000001, 21978022, p);
        }
        {
            bytes32[] memory p = new bytes32[](4);
            p[0] = 0xcf8be9170f65703b774f8aa6655d4cf9beda49e6a0b16557f5de09f0cfbe0ad2;
            p[1] = 0xcc6171f18647653cd90046b6fb4cd4e0b27fa6151ede18aabcaef953d19d72fe;
            p[2] = 0xf75754e0c55a9ba84542269696e31916126dcbc1c01f74db60cb0012f05fa27e;
            p[3] = 0xf9a96b66eae6f1d7beca97b83ce52e2eb9b3b84bf764bbe3e04dd97a371c6ab8;
            _expect(10, 0xc0Ffee0000000000000000000000000000000002, 32967033, p);
        }
        {
            bytes32[] memory p = new bytes32[](4);
            p[0] = 0x0bd150b54813f8fc30fec6de512ef37a594a3778e49dc60c7acaad185d613e10;
            p[1] = 0x4c5a768de292804712572475f0ce904a75514f2a16df08de085fc133a6f27347;
            p[2] = 0x19337c088c92d914aec1f0d51116f3fb432c8772dd431f06b0d5848bd4d1d5b6;
            p[3] = 0x872b18cb00585bf92209acdced3c3067268a65ec17d8cf19b922cf5ba32edde4;
            _expect(9, 0xc0fFEE0000000000000000000000000000000003, 43956044, p);
        }
        {
            bytes32[] memory p = new bytes32[](4);
            p[0] = 0xee8be962c576c9d0a67d34d7a5ab990e43ce32418ffb0dd0adcf6cc2ec7773b7;
            p[1] = 0x2a2b00404f8e6c38e1f31b633cfe43cce2435420c5afc9e179729d18059ee579;
            p[2] = 0xf75754e0c55a9ba84542269696e31916126dcbc1c01f74db60cb0012f05fa27e;
            p[3] = 0xf9a96b66eae6f1d7beca97b83ce52e2eb9b3b84bf764bbe3e04dd97a371c6ab8;
            _expect(8, 0xc0ffEe0000000000000000000000000000000004, 54945055, p);
        }
        {
            bytes32[] memory p = new bytes32[](4);
            p[0] = 0x8612afe8ab2d31ffcdafd16c56bd3753bb286dd06bd80fb48a4011d77eb11902;
            p[1] = 0x5834c805ac361a9059fb9c310c5d490514473712dcfd9d17aa74cd918daa704b;
            p[2] = 0xd82edaf6ec4c8e5c3c0facfef1c9ba89687a5e428ceae8bbeca543da3a98c42f;
            p[3] = 0x872b18cb00585bf92209acdced3c3067268a65ec17d8cf19b922cf5ba32edde4;
            _expect(7, 0xc0FFEE0000000000000000000000000000000005, 65934066, p);
        }
        {
            bytes32[] memory p = new bytes32[](4);
            p[0] = 0xdffe3ea505927dc2f879fa62a9effdf40b70be97a734246f0255a10f8175f61b;
            p[1] = 0x2a2b00404f8e6c38e1f31b633cfe43cce2435420c5afc9e179729d18059ee579;
            p[2] = 0xf75754e0c55a9ba84542269696e31916126dcbc1c01f74db60cb0012f05fa27e;
            p[3] = 0xf9a96b66eae6f1d7beca97b83ce52e2eb9b3b84bf764bbe3e04dd97a371c6ab8;
            _expect(6, 0xc0fFEe0000000000000000000000000000000006, 76923077, p);
        }
        {
            bytes32[] memory p = new bytes32[](4);
            p[0] = 0x93b10454245728148d97d8e2ce4100e4a7b646edc10d390449fe851bd5fe9368;
            p[1] = 0x5834c805ac361a9059fb9c310c5d490514473712dcfd9d17aa74cd918daa704b;
            p[2] = 0xd82edaf6ec4c8e5c3c0facfef1c9ba89687a5e428ceae8bbeca543da3a98c42f;
            p[3] = 0x872b18cb00585bf92209acdced3c3067268a65ec17d8cf19b922cf5ba32edde4;
            _expect(5, 0xc0ffeE0000000000000000000000000000000007, 87912088, p);
        }
        {
            bytes32[] memory p = new bytes32[](4);
            p[0] = 0x596b58799b6cad891b9610713c39ea22ae26ea5d34d45bbfc949f8c732058180;
            p[1] = 0x6e0547403c5f51324511c65719cb0a97e066ec17842019ddd64527fe3b3b2058;
            p[2] = 0x19337c088c92d914aec1f0d51116f3fb432c8772dd431f06b0d5848bd4d1d5b6;
            p[3] = 0x872b18cb00585bf92209acdced3c3067268a65ec17d8cf19b922cf5ba32edde4;
            _expect(4, 0xC0FfEE0000000000000000000000000000000008, 98901099, p);
        }
        {
            bytes32[] memory p = new bytes32[](4);
            p[0] = 0x1f79b0239eb6e237bac51348e9ef4e3e05246d9064d980d753d84b5c45487b0b;
            p[1] = 0x4c5a768de292804712572475f0ce904a75514f2a16df08de085fc133a6f27347;
            p[2] = 0x19337c088c92d914aec1f0d51116f3fb432c8772dd431f06b0d5848bd4d1d5b6;
            p[3] = 0x872b18cb00585bf92209acdced3c3067268a65ec17d8cf19b922cf5ba32edde4;
            _expect(3, 0xc0fFEE0000000000000000000000000000000009, 109890110, p);
        }
        {
            bytes32[] memory p = new bytes32[](4);
            p[0] = 0xa79929ab96d7cb44157863e25ff20baa9a5412f0eb1e9d9096ad8c6925373c18;
            p[1] = 0x192c08f009012cdb97a46a09ba26aebe9deeedae8aee4f778379c7aeecac1760;
            p[2] = 0xd82edaf6ec4c8e5c3c0facfef1c9ba89687a5e428ceae8bbeca543da3a98c42f;
            p[3] = 0x872b18cb00585bf92209acdced3c3067268a65ec17d8cf19b922cf5ba32edde4;
            _expect(2, 0xc0ffEE000000000000000000000000000000000A, 120879121, p);
        }
        {
            bytes32[] memory p = new bytes32[](4);
            p[0] = 0xa818a8ef348d15c2fb27863908475233b7252067efd7de5ba10782129a51c777;
            p[1] = 0x192c08f009012cdb97a46a09ba26aebe9deeedae8aee4f778379c7aeecac1760;
            p[2] = 0xd82edaf6ec4c8e5c3c0facfef1c9ba89687a5e428ceae8bbeca543da3a98c42f;
            p[3] = 0x872b18cb00585bf92209acdced3c3067268a65ec17d8cf19b922cf5ba32edde4;
            _expect(1, 0xc0Ffee000000000000000000000000000000000b, 131868132, p);
        }
        {
            bytes32[] memory p = new bytes32[](2);
            p[0] = 0xc753adee3118a9a8013c60b611446e7caeec6ad84d4a97a08a77d858100defbd;
            p[1] = 0xf9a96b66eae6f1d7beca97b83ce52e2eb9b3b84bf764bbe3e04dd97a371c6ab8;
            _expect(0, 0xC0FFee000000000000000000000000000000000C, 142857142, p);
        }
        assertEq(verified, FIXTURE_LEAVES, "every fixture leaf must be checked");
        assertEq(summed, FIXTURE_TOTAL, "allocations must sum to the budget exactly");
    }

    function test_tamperedFixtureProofIsRejected() public {
        bytes32[] memory p = new bytes32[](4);
        p[0] = 0x78bd3768f5d0fb776a04580dcd963c32ffe4f2576a402ca2b32aab9f2b3b3fa2;
        p[1] = 0x6e0547403c5f51324511c65719cb0a97e066ec17842019ddd64527fe3b3b2058;
        p[2] = 0x19337c088c92d914aec1f0d51116f3fb432c8772dd431f06b0d5848bd4d1d5b6;
        p[3] = 0x872b18cb00585bf92209acdced3c3067268a65ec17d8cf19b922cf5ba32edde4;

        assertTrue(_verify(12, 0xc0FFee0000000000000000000000000000000000, 10_989_011, p), "control");
        assertFalse(_verify(12, 0xc0FFee0000000000000000000000000000000000, 10_989_012, p), "amount +1");
        assertFalse(_verify(11, 0xc0FFee0000000000000000000000000000000000, 10_989_011, p), "wrong index");
        assertFalse(_verify(12, 0xC0FFEe0000000000000000000000000000000001, 10_989_011, p), "wrong account");
    }
}
