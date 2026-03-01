import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import './globals.css';
import { Providers } from './providers';
import { Navbar } from '@/components/Navbar';

const inter = Inter({ subsets: ['latin'] });

export const metadata: Metadata = {
  title: 'DustSweep — Turn Dust Into Gold',
  description: 'Batch sweep worthless dust tokens into real value on Base. Bridge dust from 7+ chains. Earn $DUST points for every action.',
  openGraph: {
    title: 'DustSweep',
    description: 'Turn your wallet dust into gold on Base.',
    url: 'https://dustsweep.xyz',
    siteName: 'DustSweep',
    images: [{ url: 'https://dustsweep.xyz/og.png', width: 1200, height: 630 }],
    locale: 'en_US',
    type: 'website',
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className={inter.className}>
        <Providers>
          <Navbar />
          {children}
        </Providers>
      </body>
    </html>
  );
}