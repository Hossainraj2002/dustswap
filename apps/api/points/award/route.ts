import { NextRequest, NextResponse } from 'next/server';

// ─── In-Memory Points Store (replace with database in production) ────────────

const pointsStore = new Map<string, number>();

// ─── Route Handler ───────────────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { address, action, particles, metadata } = body as {
      address: string;
      action: string;
      particles: number;
      metadata?: Record<string, unknown>;
    };

    if (!address || !action || !particles) {
      return NextResponse.json(
        { error: 'address, action, and particles are required' },
        { status: 400 }
      );
    }

    // Validate particles amount
    if (particles < 0 || particles > 1000) {
      return NextResponse.json(
        { error: 'Invalid particles amount' },
        { status: 400 }
      );
    }

    const addrLower = address.toLowerCase();
    const currentPoints = pointsStore.get(addrLower) || 0;
    const newTotal = currentPoints + particles;
    pointsStore.set(addrLower, newTotal);

    console.log(`[Points] Awarded ${particles} to ${address} for ${action}`, metadata);

    return NextResponse.json({
      success: true,
      awarded: particles,
      total: newTotal,
      action,
    });
  } catch (err) {
    console.error('Points award error:', err);
    return NextResponse.json(
      { error: 'Failed to award points', message: String(err) },
      { status: 500 }
    );
  }
}

// GET endpoint to check points balance
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const address = searchParams.get('address');

  if (!address) {
    return NextResponse.json(
      { error: 'address parameter required' },
      { status: 400 }
    );
  }

  const points = pointsStore.get(address.toLowerCase()) || 0;

  return NextResponse.json({
    address,
    particles: points,
  });
}