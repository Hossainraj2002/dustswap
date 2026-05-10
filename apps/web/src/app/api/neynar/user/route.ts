import { NextResponse } from 'next/server';
import { maintenanceBypassHeadersFromRequest } from '@/lib/maintenanceForward';

const DEFAULT_API_URL = "http://localhost:3001";

function getPointsApiUrl(path = "") {
  const baseUrl = (process.env.NEXT_PUBLIC_API_URL || DEFAULT_API_URL)
    .replace(/\/+$/, "")
    .replace(/\/api(?:\/.*)?$/, "");

  return `${baseUrl}/api/points${path}`;
}

export async function GET(request: Request) {
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
