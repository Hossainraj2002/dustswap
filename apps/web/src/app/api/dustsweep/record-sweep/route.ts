import { proxyDustSweepRequest } from "../proxy";

export async function POST(request: Request) {
  return proxyDustSweepRequest(request, "/api/dustsweep/record-sweep");
}
