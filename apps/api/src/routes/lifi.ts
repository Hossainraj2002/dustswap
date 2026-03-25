/**
 * Uniswap Quote API Route
 * ========================
 * 
 * Backend proxy for Uniswap Trading API.
 * Handles fee extraction and secure API key management.
 * 
 * Fee Structure:
 * - 0.2% fee is configured via the Uniswap API's routing parameters
 * - Fee is extracted from the output amount before user receives tokens
 * - No custom contracts needed - Uniswap Universal Router handles everything
 * 
 * Security:
 * - API keys stored server-side only
 * - No direct user fund handling
 * - All swaps go through official Uniswap contracts
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { parseUnits, formatUnits, encodeFunctionData, type Address } from 'viem';

const app = new Hono();

// ─── Constants ────────────────────────────────────────────────────────────────

const BASE_CHAIN_ID = 8453;

// Uniswap Trading API endpoint
const UNISWAP_TRADE_API = 'https://trade-api.gateway.uniswap.org/v2/quote';

// Token addresses on Base
const WETH_ADDRESS: Address = '0x4200000000000000000000000000000000000006';
const USDC_ADDRESS: Address = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const NATIVE_ETH: Address = '0x0000000000000000000000000000000000000000';

// Uniswap Universal Router on Base
const UNIVERSAL_ROUTER: Address = '0x198EF79F1F515F2d04ad51765e8DD4d30938C81a';

// Permit2 address
const PERMIT2_ADDRESS: Address = '0x000000000022D473030F116dDEE9F6B43aC78BA3';

// ─── Helper Functions ──────────────────────────────────────────────────────────

/**
 * Get the API key for Uniswap Trading API
 * In production, this should be stored securely
 */
function getUniswapApiKey(): string {
  return process.env.UNISWAP_API_KEY || process.env.NEXT_PUBLIC_UNISWAP_API_KEY || '';
}

/**
 * Normalize token address (handle native ETH)
 */
function normalizeTokenAddress(token: string): string {
  if (token.toLowerCase() === NATIVE_ETH.toLowerCase()) {
    return WETH_ADDRESS.toLowerCase();
  }
  return token.toLowerCase();
}

/**
 * Build the Uniswap API request body with fee configuration
 * 
 * The fee is implemented via the "fee" parameter in the API request.
 * Uniswap routes the swap to extract the fee from the output.
 */
interface QuoteRequest {
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  swapper: string;
  slippageBps: number;
  feeBps: number;
  feeRecipient: string;
}

async function getUniswapQuote(params: QuoteRequest) {
  const apiKey = getUniswapApiKey();
  
  if (!apiKey) {
    throw new Error('UNISWAP_API_KEY not configured');
  }

  // Normalize addresses
  const tokenIn = normalizeTokenAddress(params.tokenIn);
  const tokenOut = normalizeTokenAddress(params.tokenOut);

  // Build the request for Uniswap Trading API v2
  // Reference: https://docs.uniswap.org/api/trading/trade-api
  const requestBody = {
    tokenInChainId: BASE_CHAIN_ID,
    tokenOutChainId: BASE_CHAIN_ID,
    tokenIn,
    tokenOut,
    amount: params.amountIn,
    type: 'EXACT_INPUT',
    swapper: params.swapper,
    
    // Slippage configuration
    slippage: {
      slippagePercent: params.slippageBps / 100, // Convert bps to percent
    },
    
    // Fee configuration - this is how we collect the 0.2%
    // The fee is taken from the output amount
    fee: {
      feeBps: params.feeBps,
      recipient: params.feeRecipient,
    },
    
    // Routing preferences
    routing: {
      useUniswapX: false, // Use Universal Router for now
      protocols: ['V3', 'V4', 'MIXED'],
    },
    
    // Intent type for gasless swaps
    // Set to 'PRIVATE' for UniswapX, or omit for standard routing
    // useUniswapX: true,
  };

  console.log('[Swap API] Requesting quote from Uniswap:', {
    tokenIn,
    tokenOut,
    amount: params.amountIn,
    swapper: params.swapper,
  });

  const response = await fetch(UNISWAP_TRADE_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'Accept': 'application/json',
    },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error('[Swap API] Uniswap API error:', response.status, errorText);
    throw new Error(`Uniswap API error: ${response.status} - ${errorText.slice(0, 200)}`);
  }

  const data = await response.json();
  return data;
}

/**
 * Alternative: Use 0x API for routing
 * Good fallback if Uniswap API is unavailable
 */
async function get0xQuote(params: QuoteRequest) {
  const apiKey = process.env.ZEROX_API_KEY || '';
  
  if (!apiKey) {
    throw new Error('ZEROX_API_KEY not configured');
  }

  const tokenIn = normalizeTokenAddress(params.tokenIn);
  const tokenOut = normalizeTokenAddress(params.tokenOut);

  // Calculate output with fee
  // For 0x, we need to handle the fee differently
  const url = new URL('https://api.0x.org/swap/v1/quote');
  url.searchParams.set('chainId', BASE_CHAIN_ID.toString());
  url.searchParams.set('sellToken', tokenIn);
  url.searchParams.set('buyToken', tokenOut);
  url.searchParams.set('sellAmount', params.amountIn);
  url.searchParams.set('slippagePercentage', (params.slippageBps / 10000).toString());
  url.searchParams.set('takerAddress', params.swapper);

  const response = await fetch(url.toString(), {
    headers: {
      '0x-api-key': apiKey,
      'Accept': 'application/json',
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`0x API error: ${response.status}`);
  }

  return await response.json();
}

// ─── API Routes ────────────────────────────────────────────────────────────────

/**
 * POST /api/swap/quote
 * Get a swap quote from Uniswap Trading API
 */
app.post('/quote', async (c) => {
  try {
    const body = await c.req.json<QuoteRequest>();
    
    // Validate request
    if (!body.tokenIn || !body.tokenOut || !body.amountIn || !body.swapper) {
      return c.json({
        success: false,
        error: 'Missing required parameters: tokenIn, tokenOut, amountIn, swapper',
      }, 400);
    }

    // Validate addresses
    if (!body.tokenIn.match(/^0x[a-fA-F0-9]{40}$/) || 
        !body.tokenOut.match(/^0x[a-fA-F0-9]{40}$/) ||
        !body.swapper.match(/^0x[a-fA-F0-9]{40}$/)) {
      return c.json({
        success: false,
        error: 'Invalid address format',
      }, 400);
    }

    // Get quote from Uniswap
    const quoteData = await getUniswapQuote(body);

    // Extract relevant data
    const quote = quoteData.quote || {};
    const gas = quoteData.gas || {};
    const methodParameters = quoteData.methodParameters || {};

    // Calculate fee amount
    const amountOut = BigInt(quote.amountOut || quote.buyAmount || '0');
    const feeBps = BigInt(body.feeBps || 20);
    const feeAmount = (amountOut * feeBps) / BigInt(10000);
    const userAmount = amountOut - feeAmount;

    // Determine output token decimals
    const isUSDCOut = body.tokenOut.toLowerCase() === USDC_ADDRESS.toLowerCase();
    const decimals = isUSDCOut ? 6 : 18;

    // Build response
    const response = {
      success: true,
      quoteId: quoteData.quoteId || Date.now().toString(),
      amountIn: body.amountIn,
      amountOut: amountOut.toString(),
      amountOutMin: (userAmount * BigInt(10000 - body.slippageBps) / BigInt(10000)).toString(),
      userAmountOut: userAmount.toString(),
      gasEstimate: gas.estimatedGasUsed || '300000',
      priceImpact: quote.priceImpact || '0',
      route: quote.route || [],
      fee: {
        amount: feeAmount.toString(),
        bps: body.feeBps,
        recipient: body.feeRecipient,
      },
      expiresAt: Date.now() + 60000, // 1 minute

      // Transaction data for Universal Router
      tx: methodParameters.to ? {
        to: methodParameters.to as Address,
        data: methodParameters.data as `0x${string}`,
        value: methodParameters.value || '0',
        gas: gas.estimatedGasUsed || '300000',
      } : null,

      // Permit2 signature data (if using UniswapX)
      permit2: quoteData.permit2 || null,
    };

    return c.json(response);
  } catch (err: any) {
    console.error('[Swap API] Quote error:', err);
    return c.json({
      success: false,
      error: err.message || 'Failed to get quote',
    }, 500);
  }
});

/**
 * POST /api/swap/sign-order
 * Prepare an EIP-712 typed data for UniswapX order signing
 */
app.post('/sign-order', async (c) => {
  try {
    const body = await c.req.json<{
      quoteId: string;
      swapper: string;
      inputToken: string;
      outputToken: string;
      amountIn: string;
      amountOut: string;
      feeBps: number;
      feeRecipient: string;
    }>();

    // In production, this would construct a proper UniswapX DutchOrder
    // For now, we return a placeholder that the frontend can sign
    // Reference: https://docs.uniswap.org/contracts/uniswapx/overview

    const nonce = BigInt(Date.now());
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600); // 1 hour

    // Calculate fee
    const amountOut = BigInt(body.amountOut);
    const feeAmount = (amountOut * BigInt(body.feeBps)) / BigInt(10000);
    const userAmount = amountOut - feeAmount;

    // UniswapX DutchOrder Reactor on Base
    const REACTOR = '0x00000000A13Bbd79E4C93F16fA0f7601BB058A85';

    // EIP-712 Domain for Permit2
    const domain = {
      name: 'Permit2',
      chainId: BASE_CHAIN_ID,
      verifyingContract: PERMIT2_ADDRESS,
    };

    // EIP-712 Types for Permit2
    const types = {
      PermitTransferFrom: [
        { name: 'permitted', type: 'TokenPermissions' },
        { name: 'spender', type: 'address' },
        { name: 'nonce', type: 'uint256' },
        { name: 'deadline', type: 'uint256' },
      ],
      TokenPermissions: [
        { name: 'token', type: 'address' },
        { name: 'amount', type: 'uint256' },
      ],
    };

    // Message to sign
    const message = {
      permitted: {
        token: normalizeTokenAddress(body.inputToken),
        amount: body.amountIn,
      },
      spender: REACTOR,
      nonce: nonce.toString(),
      deadline: deadline.toString(),
    };

    // Calculate order hash (simplified)
    const orderHash = `0x${Date.now().toString(16).padStart(64, '0')}`;

    return c.json({
      success: true,
      domain,
      types,
      primaryType: 'PermitTransferFrom',
      message,
      orderHash,
      encodedOrder: '', // Would contain actual encoded DutchOrder
    });
  } catch (err: any) {
    console.error('[Swap API] Sign order error:', err);
    return c.json({
      success: false,
      error: err.message || 'Failed to prepare order',
    }, 500);
  }
});

/**
 * POST /api/swap/submit-order
 * Submit a signed UniswapX order to the Uniswap API
 */
app.post('/submit-order', async (c) => {
  try {
    const body = await c.req.json<{
      orderHash: string;
      signature: string;
      encodedOrder: string;
      chainId: number;
    }>();

    const apiKey = getUniswapApiKey();

    // Submit to UniswapX API
    const response = await fetch('https://api.uniswap.org/v2/orders', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
      },
      body: JSON.stringify({
        orderHash: body.orderHash,
        signature: body.signature,
        encodedOrder: body.encodedOrder,
        chainId: body.chainId,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to submit order: ${errorText}`);
    }

    const data = await response.json();

    return c.json({
      success: true,
      orderHash: body.orderHash,
      ...data,
    });
  } catch (err: any) {
    console.error('[Swap API] Submit order error:', err);
    return c.json({
      success: false,
      error: err.message || 'Failed to submit order',
    }, 500);
  }
});

/**
 * GET /api/swap/status/:orderId
 * Check the status of a UniswapX order
 */
app.get('/status/:orderId', async (c) => {
  try {
    const orderId = c.req.param('orderId');
    const apiKey = getUniswapApiKey();

    const response = await fetch(`https://api.uniswap.org/v2/orders/${orderId}`, {
      headers: {
        'x-api-key': apiKey,
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to get order status`);
    }

    const data = await response.json();

    return c.json({
      success: true,
      ...data,
    });
  } catch (err: any) {
    console.error('[Swap API] Status error:', err);
    return c.json({
      success: false,
      error: err.message || 'Failed to get order status',
    }, 500);
  }
});

export default app;
