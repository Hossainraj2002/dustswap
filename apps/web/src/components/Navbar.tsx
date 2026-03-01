'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  ConnectWallet,
  Wallet,
  WalletDropdown,
  WalletDropdownLink,
  WalletDropdownDisconnect,
} from '@coinbase/onchainkit/wallet';
import { Address, Avatar, Name, Identity } from '@coinbase/onchainkit/identity';

const NAV_LINKS = [
  { href: '/swap',        label: '🔄 Swap'        },
  { href: '/dust-sweep',  label: '🧹 Dust Sweep'  },
  { href: '/dust-bridge', label: '🌉 Bridge'      },
  { href: '/burn',        label: '🔥 Burn'        },
  { href: '/particles',   label: '✨ Particles'   },
];

export function Navbar() {
  const pathname = usePathname();

  return (
    <nav className="sticky top-0 z-50 border-b border-gray-800 bg-gray-950/80 backdrop-blur">
      <div className="max-w-7xl mx-auto px-4 py-3 flex items-center justify-between">
        {/* Logo */}
        <Link href="/" className="flex items-center gap-2">
          <span className="text-2xl">🧹</span>
          <span className="text-xl font-bold text-white">DustSweep</span>
        </Link>

        {/* Links */}
        <div className="flex items-center space-x-4">
          {NAV_LINKS.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className={`px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                pathname === l.href
                  ? 'bg-blue-600 text-white'
                  : 'text-gray-400 hover:text-white hover:bg-gray-800'
              }`}
            >
              {l.label}
            </Link>
          ))}
        </div>

        {/* Wallet */}
        <div>
          <Wallet>
            <ConnectWallet className="bg-blue-600 hover:bg-blue-700 text-white rounded-lg px-4 py-2 text-sm font-medium">
              <Avatar className="h-5 w-5" />
              <Name />
            </ConnectWallet>
            <WalletDropdown>
              <Identity className="px-4 pt-3 pb-2" hasCopyAddressOnClick>
                <Avatar />
                <Name />
                <Address />
              </Identity>
              <WalletDropdownLink icon="wallet" href="https://wallet.coinbase.com">
                Go to Wallet
              </WalletDropdownLink>
              <WalletDropdownDisconnect />
            </WalletDropdown>
          </Wallet>
        </div>
      </div>
    </nav>
  );
}