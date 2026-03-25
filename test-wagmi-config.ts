
import { createConfig, http } from '@wagmi/core';
import { base } from '@wagmi/core/chains';

const config = createConfig({
  chains: [base],
  transports: { [base.id]: http() },
  dataSuffix: '0x12345678',
});

console.log('Config dataSuffix:', (config as any).dataSuffix);
console.log('Config keys:', Object.keys(config));
