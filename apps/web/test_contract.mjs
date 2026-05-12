import { createPublicClient, http } from 'viem';
import { base } from 'viem/chains';

const client = createPublicClient({
  chain: base,
  transport: http('https://mainnet.base.org')
});

async function main() {
  const address = '0x72Bd4b89fFb1e1f48253b7a7a65739ff1E696442';
  
  // Check if it has code
  const code = await client.getBytecode({ address });
  console.log('Has code:', code && code !== '0x' ? true : false);
  
  if (code && code !== '0x') {
    // Attempt to simulate a transaction with calldata to see if it reverts
    // The DATA_SUFFIX is usually appended by the frontend.
    // In builderCode.ts: export const DATA_SUFFIX = "0x..."
    
    // Using a random data suffix
    const dataSuffix = "0x12345678";
    
    try {
      const gas = await client.estimateGas({
        account: '0x0000000000000000000000000000000000000001',
        to: address,
        value: 1n,
        data: dataSuffix
      });
      console.log('Accepts ETH with calldata: YES');
    } catch (e) {
      console.log('Accepts ETH with calldata: NO');
      console.log(e.shortMessage || e.message);
    }
    
    try {
      const gas2 = await client.estimateGas({
        account: '0x0000000000000000000000000000000000000001',
        to: address,
        value: 1n,
        data: "0x"
      });
      console.log('Accepts ETH without calldata: YES');
    } catch (e) {
      console.log('Accepts ETH without calldata: NO');
      console.log(e.shortMessage || e.message);
    }
  }
}

main().catch(console.error);
