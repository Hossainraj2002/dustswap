import { proxyDustSweepRequest } from "../../proxy";

export async function GET(
  request: Request,
  context: { params: Promise<{ address: string }> },
) {
  const { address } = await context.params;
  return proxyDustSweepRequest(request, `/api/dustsweep/tokens/${address}`);
}
