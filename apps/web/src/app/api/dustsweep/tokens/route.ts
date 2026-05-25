import { proxyDustSweepRequest } from "../proxy";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const query = url.searchParams.toString();
  return proxyDustSweepRequest(
    request,
    `/api/dustsweep/tokens${query ? `?${query}` : ""}`,
  );
}
