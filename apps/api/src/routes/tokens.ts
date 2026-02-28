import { Router, Request, Response } from 'express';
import { getTokenBalances, scanForDust, scanAllChains } from '../services/tokenDiscovery';

const router = Router();
const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

// GET /api/tokens/balances/:chainId/:address
router.get('/balances/:chainId/:address', async (req: Request, res: Response) => {
  const { chainId, address } = req.params;
  if (!ADDRESS_RE.test(address)) return res.status(400).json({ error: 'Invalid address' });
  try {
    const tokens = await getTokenBalances(address, chainId);
    res.json({ success: true, chainId, address, tokenCount: tokens.length, tokens });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    res.status(500).json({ success: false, error: msg });
  }
});

// GET /api/tokens/dust/:address  — all chains
router.get('/dust/:address', async (req: Request, res: Response) => {
  const { address } = req.params;
  if (!ADDRESS_RE.test(address)) return res.status(400).json({ error: 'Invalid address' });
  try {
    const chains        = await scanAllChains(address);
    const totalValue    = chains.reduce((s, c) => s + c.totalDustValueUsd, 0);
    const totalCount    = chains.reduce((s, c) => s + c.dustTokens.length, 0);
    res.json({ success: true, address, totalDustValueUsd: totalValue, totalDustTokenCount: totalCount, chains });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    res.status(500).json({ success: false, error: msg });
  }
});

// GET /api/tokens/dust/:chainId/:address  — single chain
router.get('/dust/:chainId/:address', async (req: Request, res: Response) => {
  const { chainId, address } = req.params;
  if (!ADDRESS_RE.test(address)) return res.status(400).json({ error: 'Invalid address' });
  try {
    const result = await scanForDust(address, chainId);
    res.json({ success: true, ...result });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    res.status(500).json({ success: false, error: msg });
  }
});

export { router as tokenRoutes };
