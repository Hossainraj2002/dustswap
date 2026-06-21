import { NextResponse } from 'next/server';
import { maintenanceBypassHeadersFromRequest } from '@/lib/maintenanceForward';

const DEFAULT_API_URL = "http://localhost:3001";

// Lightweight per-IP throttle to stop enumeration of Farcaster profiles and
// abuse of the (rate-limited, billable) Neynar API key via this proxy.
const NEYNAR_RATE_LIMIT = 60;
const NEYNAR_RATE_WINDOW_MS = 60_000;
const neynarRateCounters = new Map<string, { count: number; expiresAt: number }>();

function getClientIp(request: Request) {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim();
    if (first) return first;
  }
  return request.headers.get('cf-connecting-ip') || request.headers.get('x-real-ip') || 'unknown';
}

function isRateLimited(ip: string) {
  const now = Date.now();
  const existing = neynarRateCounters.get(ip);
  if (!existing || existing.expiresAt <= now) {
    neynarRateCounters.set(ip, { count: 1, expiresAt: now + NEYNAR_RATE_WINDOW_MS });
    return false;
  }
  if (existing.count >= NEYNAR_RATE_LIMIT) {
    return true;
  }
  existing.count += 1;
  return false;
}

// Reject cross-origin browser callers. Same-origin GET fetches omit the Origin
// header, so a present-but-mismatched Origin is the abuse signal.
function isCrossOrigin(request: Request) {
  const origin = request.headers.get('origin');
  if (!origin) return false;
  try {
    return new URL(origin).host !== request.headers.get('host');
  } catch {
    return true;
  }
}

function getPointsApiUrl(path = "") {
  const baseUrl = (process.env.NEXT_PUBLIC_API_URL || DEFAULT_API_URL)
    .replace(/\/+$/, "")
    .replace(/\/api(?:\/.*)?$/, "");

  return `${baseUrl}/api/points${path}`;
}

export async function GET(request: Request) {
  if (isCrossOrigin(request)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  if (isRateLimited(getClientIp(request))) {
    return NextResponse.json({ error: 'Too many requests' }, { status: 429 });
  }

  const { searchParams } = new URL(request.url);
  const address = searchParams.get('address');

  if (!address) {
    return NextResponse.json({ error: 'Address is required' }, { status: 400 });
  }

  const apiKey = process.env.NEYNAR_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: 'Neynar API key not configured' }, { status: 500 });
  }

  try {
    const response = await fetch(
      `https://api.neynar.com/v2/farcaster/user/bulk-by-address?addresses=${address}`,
      {
        headers: {
          accept: 'application/json',
          api_key: apiKey,
        },
      }
    );

    const data = await response.json();
    
    // Make sure we have a valid profile
    const profile = data[address.toLowerCase()]?.[0] || data[address]?.[0];
    
    if (!profile) {
       return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    const maintHeaders = await maintenanceBypassHeadersFromRequest(request);
    await fetch(getPointsApiUrl("/profile-cache"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...maintHeaders,
      },
      body: JSON.stringify({
        address,
        fid: String(profile.fid ?? ""),
        username: profile.username ?? null,
        displayName: profile.display_name ?? null,
        pfpUrl: profile.pfp_url ?? null,
      }),
      cache: "no-store",
    }).catch((cacheError) => {
      console.error("Failed to cache Neynar profile:", cacheError);
      return null;
    });

    return NextResponse.json(profile);
  } catch (error) {
    console.error('Neynar API error:', error);
    return NextResponse.json({ error: 'Failed to fetch user profile' }, { status: 500 });
  }
}
