# DustSweep EIP-7702 Registry

Last updated: 2026-06-10

Live registry source:

- `apps/web/src/lib/eip7702.ts`

Runtime behavior:

- DustSweep reads Base `eth_getCode` for the connected address.
- A delegated EOA returns `0xef0100 || delegateAddress`.
- `KNOWN_DELEGATES` maps that delegate address to a wallet or service label.
- `ONE_CLICK_SWEEP_WALLETS` is only for wallet surfaces we can reasonably ask the user to connect.
- Service/infra delegates are saved as `wallet: "unknown"` with a real label, so the UI can name them but does not offer a wallet switch.

Important limit:

There is no canonical public wallet-to-EIP-7702-delegate registry. New wallet versions, app-specific delegates, malicious delegates, or private enterprise delegates can appear at any time. Unknown/unregistered delegates must remain possible as a safety state, but the registry below covers every verifiable public wallet/service delegate found in this pass.

## One-Click Wallet Delegates

| Wallet | Delegate address(es) saved | Source / verification |
| --- | --- | --- |
| OKX Wallet | `0xe40ccb2d94975c51bff0c004efdfd9b3a5796fa4`, `0x80296ff8d1ed46f8e3c7992664d13b833504c2bb` | Live Base delegated account check, OKX SmartWalletEntry repo signal, BundleBear registry |
| TokenPocket Wallet | `0xcc0c946eecf01a4bc76bc333ea74ceb04756f17b` | User Base delegated account check, Etherscan label/source, BundleBear registry |
| MetaMask | `0x63c0c19a282a1b52b07dd5a65b58948a07dae32b` | Ethereum.org known implementations, MetaMask delegation-framework docs, BundleBear registry |
| Base Account / Coinbase Wallet | `0x7702cb554e6bfb442cb743a7df23154544a7176c` | Base EIP7702Proxy release/deployment addresses, Coinbase EIP-7702 docs, Base RPC code check, BundleBear registry |
| Trust Wallet | `0xd2e28229f6f2c235e57de2ebc727025a1d0530fb` | BundleBear registry, Base RPC code check |
| Uniswap Wallet | `0x000000009b1d0af20d8c6d0a44e162d11f9b8f00`, `0x0c338ca25585035142a9a0a1eeeba267256f281f`, `0x458f5a9f47a01bea5d7a32662660559d9ed3312c` | Ethereum.org known implementations, Uniswap delegation docs, BundleBear registry, Base RPC code check |
| Ambire Wallet | `0x5a7fc11397e9a8ad41bf10bf13f22b0a63f96f6d` | Ethereum.org known implementations, BundleBear registry, Base RPC code check |
| Bitget Wallet | `0xa845c74344fc9405b1fcf712f04668979573c1bf`, `0x4428a93b478fa76a5bd9c7641f54ec6373855433` | Bitget EIP-7702 support docs/news, BundleBear registry, Base RPC code check. Bitget's public docs describe manual wallet binding, not a dApp-triggered `wallet_sendCalls` setup flow, so DustSweep does not advertise Bitget as one-click until public batch support is verified. |
| Rainbow | `0x612373d7003d694220f7800eeaf8e3924c0951d3` | BundleBear registry, Base RPC code check |

## Labeled Service / Infra Delegates

These are saved to avoid a vague "unknown contract" message, but DustSweep will not recommend switching wallets to them.

| Label | Delegate address(es) saved |
| --- | --- |
| Ethereum Foundation AA Delegator | `0x4cd241e8d1510e30b2076397afc7508ae59c66c9` |
| Luganodes Batch Contract | `0x17c11fddadac2b341f2455afe988fec4c3ba26e3` |
| Otim Delegator | `0x23e5f9c457a69ce776d20a8fe812a6701d66fce8` |
| Gelato | `0x5af42746a8af42d8a4708df238c53f1f71abf0e0` |
| WhiteBit Account | `0xcda3577ca7ef65f6b7201e9bd80375f5628d15f7`, `0x79cf9e04ad9aeb210768c22c228673aed6cd24c4`, `0x4b3a543dc60a09974007d6937cd952e3a0188929` |
| Alchemy Modular Account v2 | `0x69007702764179f14f51cdce752f4f775d74e139` |
| Biconomy Nexus | `0x000000001964d23c59962fc7a912872ee8fb3b6a`, `0x0000000020fe2f30453074ad916edeb653ec7e9d`, `0x00000000383e8cbe298514674ea60ee1d1de50ac`, `0x000000004f43c49e93c970e84001853a70923b03`, `0x000000ac74357bfea72bbd0781833631f732cf19` |
| Thirdweb | `0xbac7e770af15d130cd72838ff386f14fbf3e9a3d`, `0xd6999651fc0964b9c6b444307a0ab20534a66560`, `0x4670d851672cb6e3ab4faea0a18dc08edea01d5e`, `0x3e515544f8d8293b0a353e10ff3b7ca03b52f35b` |
| ZeroDev | `0xd6cedde84be40893d153be9d467cd6ad37875b28` |
| Porto | `0x664ab8c20b629422f5398e58ff8989e68b26a4e6`, `0x8c0466a6c046395c8999227b288883cf7dc9f5de`, `0xb292da8879c26ecd558bbea87f581cdd608ffc3c`, `0x5874f358359ee96d2b3520409018f1a6f59a2cdc` |
| Fireblocks | `0x0000fb7702036ff9f76044a501ac1aa74cbab16b` |
| Cordial | `0x7785a22facd31db653ba4928f1d5b81d093f0b2f` |
| Dfns | `0xcea43594f38316f0e01c161d8dabde0a07a1f512` |
| Pimlico Simple 7702 Account | `0xe6cae83bde06e4c305530e199d7217f42808555b` |

## No Exact Public Delegate Found

These wallets appeared in DustSweep connection code or public wallet-support discussions, but this pass did not find a reliable exact EIP-7702 delegate address to save:

- Rabby: found public support for revoking EIP-7702 delegation, but no exact Rabby-owned delegate address.
- Phantom: no exact public EIP-7702 delegate address found.
- Zerion: no exact public EIP-7702 delegate address found.
- imToken: no exact public EIP-7702 delegate address found.
- Crypto.com Wallet: no exact public EIP-7702 delegate address found.
- Safe: public discussions mention EIP-7702 patterns, but no single Safe wallet delegate address suitable for DustSweep switching was found.

## Research Sources

- Ethereum.org Pectra 7702 guidelines and known implementations: https://ethereum.org/roadmap/pectra/7702/
- EIP-7702 specification: https://eips.ethereum.org/EIPS/eip-7702
- MetaMask delegation framework docs: https://github.com/MetaMask/delegation-framework/blob/main/documents/EIP7702DeleGator.md
- Base EIP7702Proxy blog: https://blog.base.dev/securing-eip-7702-upgrades
- Base EIP7702Proxy release/deployment addresses: https://github.com/base/eip-7702-proxy/releases/tag/v1.0.0
- Coinbase EIP-7702 docs: https://docs.cdp.coinbase.com/wallets/using-wallets/eip-7702
- TokenPocket EIP-7702 docs: https://help.tokenpocket.pro/en/wallet-operation/what-is-profit-and-loss/eip7702
- TokenPocket upgrade/reset docs: https://help.tokenpocket.pro/en/wallet-operation/what-is-profit-and-loss/eip7702-upgrade
- Bitget EIP-7702 docs/news: https://web3.bitget.com/en/blog/articles/bind-eip7702
- Uniswap delegation docs: https://developers.uniswap.org/docs/protocols/smart-wallet/concepts/delegation
- BundleBear open operator registry: https://raw.githubusercontent.com/Jam516/BundleBear/main/models/eip7702/labels/eip7702_labels_authorized_contracts.sql
- BundleBear Base authorized-contract dashboard: https://www.bundlebear.com/eip7702-authorized-contracts/base
