"use client";

import { useEffect, useRef } from "react";

type Ripple = {
  x: number;
  y: number;
  bornAt: number;
  strength: number;
};

type Lane = {
  axis: "horizontal" | "vertical";
  offset: number;
  speed: number;
  phase: number;
  length: number;
  glow: number;
};

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function createLanes(width: number, height: number) {
  const horizontalCount = width < 640 ? 5 : 7;
  const verticalCount = width < 640 ? 4 : 6;
  const lanes: Lane[] = [];

  for (let index = 0; index < horizontalCount; index += 1) {
    lanes.push({
      axis: "horizontal",
      offset: height * (0.14 + index * 0.11),
      speed: 34 + index * 7,
      phase: index * 190,
      length: width < 640 ? 110 : 150,
      glow: 12 + index * 2,
    });
  }

  for (let index = 0; index < verticalCount; index += 1) {
    lanes.push({
      axis: "vertical",
      offset: width * (0.12 + index * 0.15),
      speed: 28 + index * 6,
      phase: index * 220,
      length: width < 640 ? 120 : 170,
      glow: 14 + index * 2,
    });
  }

  return lanes;
}

export function PremiumQuestBackground() {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    const canvas = canvasRef.current;
    const grid = gridRef.current;
    if (!host || !canvas || !grid) {
      return;
    }

    const context = canvas.getContext("2d");
    if (!context) {
      return;
    }

    const state = {
      width: 0,
      height: 0,
      pointerX: 0,
      pointerY: 0,
      targetX: 0,
      targetY: 0,
      active: 0,
    };

    let frameId = 0;
    let ripples: Ripple[] = [];
    let lanes: Lane[] = [];

    const resize = () => {
      const bounds = host.getBoundingClientRect();
      const width = Math.max(bounds.width, window.innerWidth);
      const height = Math.max(bounds.height, window.innerHeight);
      const dpr = Math.min(window.devicePixelRatio || 1, 1.75);

      state.width = width;
      state.height = height;

      if (!state.pointerX || !state.pointerY) {
        state.pointerX = width * 0.72;
        state.pointerY = height * 0.28;
        state.targetX = state.pointerX;
        state.targetY = state.pointerY;
      }

      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      context.setTransform(dpr, 0, 0, dpr, 0, 0);

      lanes = createLanes(width, height);
    };

    const spawnRipple = (x: number, y: number, strength = 0.7) => {
      ripples = [...ripples.slice(-6), { x, y, bornAt: performance.now(), strength }];
    };

    const updatePointer = (x: number, y: number, spawnSoftRipple = false) => {
      state.targetX = x;
      state.targetY = y;
      state.active = 1;

      if (spawnSoftRipple) {
        spawnRipple(x, y, 0.52);
      }
    };

    const resetPointer = () => {
      state.targetX = state.width * 0.72;
      state.targetY = state.height * 0.28;
      state.active = 0;
    };

    const handlePointerMove = (event: PointerEvent) => {
      updatePointer(event.clientX, event.clientY);
    };

    const handlePointerDown = (event: PointerEvent) => {
      updatePointer(event.clientX, event.clientY);
      spawnRipple(event.clientX, event.clientY, 1);
    };

    const handleTouchMove = (event: TouchEvent) => {
      const touch = event.touches[0] ?? event.changedTouches[0];
      if (!touch) {
        return;
      }

      updatePointer(touch.clientX, touch.clientY);
    };

    const handleTouchStart = (event: TouchEvent) => {
      const touch = event.touches[0] ?? event.changedTouches[0];
      if (!touch) {
        return;
      }

      updatePointer(touch.clientX, touch.clientY);
      spawnRipple(touch.clientX, touch.clientY, 1.08);
    };

    const drawRipple = (ripple: Ripple, now: number) => {
      const age = now - ripple.bornAt;
      const duration = 1550;
      const progress = clamp(age / duration, 0, 1);
      const radius = 18 + progress * 120 * ripple.strength;
      const alpha = (1 - progress) * 0.36;

      const gradient = context.createRadialGradient(
        ripple.x,
        ripple.y,
        0,
        ripple.x,
        ripple.y,
        radius
      );
      gradient.addColorStop(0, `rgba(255,255,255,${alpha})`);
      gradient.addColorStop(0.28, `rgba(147,197,253,${alpha * 0.9})`);
      gradient.addColorStop(0.7, `rgba(96,165,250,${alpha * 0.42})`);
      gradient.addColorStop(1, "rgba(96,165,250,0)");

      context.fillStyle = gradient;
      context.beginPath();
      context.arc(ripple.x, ripple.y, radius, 0, Math.PI * 2);
      context.fill();
    };

    const drawLane = (lane: Lane, now: number) => {
      const { width, height } = state;
      const driftX = (state.pointerX / width - 0.5) * 12;
      const driftY = (state.pointerY / height - 0.5) * 10;

      if (lane.axis === "horizontal") {
        const yBase = lane.offset + driftY * 0.18;
        const influence = Math.exp(-Math.abs(state.pointerY - yBase) / 180);
        const y = yBase + (state.pointerY - yBase) * 0.035 * influence * state.active;
        const headX = ((now * lane.speed + lane.phase) % (width + lane.length * 2)) - lane.length;

        context.beginPath();
        context.moveTo(0, y);
        context.lineTo(width, y);
        context.strokeStyle = "rgba(148,163,184,0.12)";
        context.lineWidth = 1;
        context.stroke();

        const trail = context.createLinearGradient(headX - lane.length, y, headX + 28, y);
        trail.addColorStop(0, "rgba(59,130,246,0)");
        trail.addColorStop(0.45, "rgba(96,165,250,0.18)");
        trail.addColorStop(0.82, "rgba(125,211,252,0.86)");
        trail.addColorStop(1, "rgba(255,255,255,0.94)");

        context.beginPath();
        context.moveTo(Math.max(headX - lane.length, 0), y);
        context.lineTo(Math.min(headX + 28, width), y);
        context.strokeStyle = trail;
        context.lineWidth = 2;
        context.shadowColor = "rgba(96,165,250,0.42)";
        context.shadowBlur = lane.glow;
        context.stroke();
        context.shadowBlur = 0;

        const glow = context.createRadialGradient(headX, y, 0, headX, y, 34);
        glow.addColorStop(0, "rgba(255,255,255,0.95)");
        glow.addColorStop(0.28, "rgba(191,219,254,0.8)");
        glow.addColorStop(0.6, "rgba(96,165,250,0.36)");
        glow.addColorStop(1, "rgba(96,165,250,0)");
        context.fillStyle = glow;
        context.beginPath();
        context.arc(headX, y, 34, 0, Math.PI * 2);
        context.fill();
        return;
      }

      const xBase = lane.offset + driftX * 0.18;
      const influence = Math.exp(-Math.abs(state.pointerX - xBase) / 180);
      const x = xBase + (state.pointerX - xBase) * 0.035 * influence * state.active;
      const headY = ((now * lane.speed + lane.phase) % (height + lane.length * 2)) - lane.length;

      context.beginPath();
      context.moveTo(x, 0);
      context.lineTo(x, height);
      context.strokeStyle = "rgba(148,163,184,0.1)";
      context.lineWidth = 1;
      context.stroke();

      const trail = context.createLinearGradient(x, headY - lane.length, x, headY + 30);
      trail.addColorStop(0, "rgba(59,130,246,0)");
      trail.addColorStop(0.45, "rgba(96,165,250,0.16)");
      trail.addColorStop(0.82, "rgba(125,211,252,0.84)");
      trail.addColorStop(1, "rgba(255,255,255,0.94)");

      context.beginPath();
      context.moveTo(x, Math.max(headY - lane.length, 0));
      context.lineTo(x, Math.min(headY + 30, height));
      context.strokeStyle = trail;
      context.lineWidth = 2;
      context.shadowColor = "rgba(96,165,250,0.4)";
      context.shadowBlur = lane.glow;
      context.stroke();
      context.shadowBlur = 0;

      const glow = context.createRadialGradient(x, headY, 0, x, headY, 36);
      glow.addColorStop(0, "rgba(255,255,255,0.92)");
      glow.addColorStop(0.28, "rgba(191,219,254,0.82)");
      glow.addColorStop(0.62, "rgba(96,165,250,0.34)");
      glow.addColorStop(1, "rgba(96,165,250,0)");
      context.fillStyle = glow;
      context.beginPath();
      context.arc(x, headY, 36, 0, Math.PI * 2);
      context.fill();
    };

    const animate = (timestamp: number) => {
      const now = timestamp * 0.001;
      const { width, height } = state;

      state.pointerX += (state.targetX - state.pointerX) * 0.08;
      state.pointerY += (state.targetY - state.pointerY) * 0.08;
      state.active += ((state.active > 0 ? 1 : 0) - state.active) * 0.08;

      context.clearRect(0, 0, width, height);

      const glowTop = context.createRadialGradient(
        width * 0.74,
        height * 0.18,
        0,
        width * 0.74,
        height * 0.18,
        Math.max(width, height) * 0.45
      );
      glowTop.addColorStop(0, "rgba(125,211,252,0.18)");
      glowTop.addColorStop(0.32, "rgba(191,219,254,0.12)");
      glowTop.addColorStop(1, "rgba(255,255,255,0)");
      context.fillStyle = glowTop;
      context.fillRect(0, 0, width, height);

      const glowBottom = context.createRadialGradient(
        width * 0.24,
        height * 0.82,
        0,
        width * 0.24,
        height * 0.82,
        Math.max(width, height) * 0.42
      );
      glowBottom.addColorStop(0, "rgba(147,197,253,0.12)");
      glowBottom.addColorStop(0.35, "rgba(219,234,254,0.07)");
      glowBottom.addColorStop(1, "rgba(255,255,255,0)");
      context.fillStyle = glowBottom;
      context.fillRect(0, 0, width, height);

      lanes.forEach((lane) => drawLane(lane, now));

      ripples = ripples.filter((ripple) => timestamp - ripple.bornAt < 1550);
      ripples.forEach((ripple) => drawRipple(ripple, timestamp));

      if (state.active > 0.04) {
        const hoverGlow = context.createRadialGradient(
          state.pointerX,
          state.pointerY,
          0,
          state.pointerX,
          state.pointerY,
          88
        );
        hoverGlow.addColorStop(0, "rgba(255,255,255,0.52)");
        hoverGlow.addColorStop(0.24, "rgba(191,219,254,0.28)");
        hoverGlow.addColorStop(0.62, "rgba(96,165,250,0.1)");
        hoverGlow.addColorStop(1, "rgba(96,165,250,0)");
        context.fillStyle = hoverGlow;
        context.beginPath();
        context.arc(state.pointerX, state.pointerY, 88, 0, Math.PI * 2);
        context.fill();
      }

      const driftX = (state.pointerX / width - 0.5) * 16;
      const driftY = (state.pointerY / height - 0.5) * 12;
      grid.style.transform = `perspective(1800px) rotateX(66deg) rotateZ(${driftX * 0.03}deg) translate3d(${driftX}px, ${driftY}px, 0) scale(1.08)`;

      frameId = window.requestAnimationFrame(animate);
    };

    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(host);

    frameId = window.requestAnimationFrame(animate);
    window.addEventListener("resize", resize);
    window.addEventListener("pointermove", handlePointerMove, { passive: true });
    window.addEventListener("pointerdown", handlePointerDown, { passive: true });
    window.addEventListener("pointerleave", resetPointer);
    window.addEventListener("touchmove", handleTouchMove, { passive: true });
    window.addEventListener("touchstart", handleTouchStart, { passive: true });
    window.addEventListener("touchend", resetPointer, { passive: true });

    return () => {
      observer.disconnect();
      window.cancelAnimationFrame(frameId);
      window.removeEventListener("resize", resize);
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("pointerleave", resetPointer);
      window.removeEventListener("touchmove", handleTouchMove);
      window.removeEventListener("touchstart", handleTouchStart);
      window.removeEventListener("touchend", resetPointer);
    };
  }, []);

  return (
    <div ref={hostRef} className="pointer-events-none absolute inset-0 overflow-hidden">
      <div className="absolute inset-0 bg-[linear-gradient(180deg,#ffffff_0%,#f7fbff_46%,#edf4fb_100%)]" />
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_18%_10%,rgba(255,255,255,0.96),transparent_34%),radial-gradient(circle_at_84%_14%,rgba(186,230,253,0.34),transparent_28%),radial-gradient(circle_at_50%_100%,rgba(191,219,254,0.22),transparent_34%)]" />
      <div
        ref={gridRef}
        className="absolute inset-x-[-10%] inset-y-[-8%] opacity-85"
        style={{
          backgroundImage:
            "linear-gradient(to right, rgba(148,163,184,0.12) 1px, transparent 1px), linear-gradient(to bottom, rgba(148,163,184,0.12) 1px, transparent 1px)",
          backgroundSize: "52px 52px",
          maskImage:
            "radial-gradient(circle at center, rgba(255,255,255,0.98) 0%, rgba(255,255,255,0.9) 58%, transparent 100%)",
          WebkitMaskImage:
            "radial-gradient(circle at center, rgba(255,255,255,0.98) 0%, rgba(255,255,255,0.9) 58%, transparent 100%)",
          transform: "perspective(1800px) rotateX(66deg) scale(1.08)",
          transformOrigin: "center center",
        }}
      />
      <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(255,255,255,0.74)_0%,rgba(255,255,255,0.08)_34%,rgba(255,255,255,0.28)_100%)]" />
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />
    </div>
  );
}
