"use client";

import { useEffect, useRef, useState } from "react";

type Pulse = {
  x: number;
  y: number;
  bornAt: number;
  strength: number;
};

const GRID_SIZE = 38;
const LINE_COUNT = 4;
const MOBILE_BREAKPOINT_PX = 768;

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function getLineY({
  x,
  baseY,
  height,
  now,
  index,
  pointerX,
  pointerY,
  active,
}: {
  x: number;
  baseY: number;
  height: number;
  now: number;
  index: number;
  pointerX: number;
  pointerY: number;
  active: number;
}) {
  const pointerRange = height * 0.22;
  const distance = x - pointerX;
  const influence = Math.exp(-(distance * distance) / (2 * pointerRange * pointerRange));
  const waveOffset =
    Math.sin(x * 0.009 + now * (0.85 + index * 0.12) + index * 1.35) * (16 + index * 4) +
    Math.cos(x * 0.0042 - now * 0.7 + index * 0.8) * 8 +
    Math.sin(distance * 0.031 - now * 4.6) * influence * active * 22 +
    (pointerY - baseY) * 0.11 * influence * active;

  return baseY + waveOffset;
}

export function InteractiveLeaderboardBackground() {
  const [isMobile, setIsMobile] = useState<boolean | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const planeRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const updateViewportMode = () => {
      setIsMobile(window.innerWidth < MOBILE_BREAKPOINT_PX);
    };

    updateViewportMode();
    window.addEventListener("resize", updateViewportMode);

    return () => {
      window.removeEventListener("resize", updateViewportMode);
    };
  }, []);

  useEffect(() => {
    if (isMobile !== false) {
      return;
    }

    const canvas = canvasRef.current;
    const plane = planeRef.current;
    if (!canvas || !plane) return;

    const context = canvas.getContext("2d");
    if (!context) return;

    const state = {
      width: 0,
      height: 0,
      pointerX: window.innerWidth * 0.7,
      pointerY: window.innerHeight * 0.42,
      targetX: window.innerWidth * 0.7,
      targetY: window.innerHeight * 0.42,
      active: 0,
      lastPulseAt: 0,
    };

    let frameId = 0;
    let pulses: Pulse[] = [];

    const resize = () => {
      const bounds = canvas.getBoundingClientRect();
      const width = bounds.width || window.innerWidth;
      const height = bounds.height || window.innerHeight;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);

      state.width = width;
      state.height = height;

      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    const spawnPulse = (x: number, y: number, strength = 0.75) => {
      pulses = [...pulses.slice(-7), { x, y, bornAt: performance.now(), strength }];
      state.lastPulseAt = performance.now();
    };

    const updatePointer = (x: number, y: number, spawnSoftPulse = false) => {
      state.targetX = x;
      state.targetY = y;
      state.active = 1;

      if (spawnSoftPulse && performance.now() - state.lastPulseAt > 220) {
        spawnPulse(x, y, 0.52);
      }
    };

    const resetPointer = () => {
      state.active = 0;
      state.targetX = state.width * 0.72;
      state.targetY = state.height * 0.42;
    };

    const handlePointerMove = (event: PointerEvent) => {
      updatePointer(event.clientX, event.clientY, true);
    };

    const handlePointerDown = (event: PointerEvent) => {
      updatePointer(event.clientX, event.clientY);
      spawnPulse(event.clientX, event.clientY, 1.08);
    };

    const handleTouchMove = (event: TouchEvent) => {
      const touch = event.touches[0] ?? event.changedTouches[0];
      if (!touch) return;
      updatePointer(touch.clientX, touch.clientY, true);
    };

    const handleTouchStart = (event: TouchEvent) => {
      const touch = event.touches[0] ?? event.changedTouches[0];
      if (!touch) return;
      updatePointer(touch.clientX, touch.clientY);
      spawnPulse(touch.clientX, touch.clientY, 1.14);
    };

    const drawLineHighlight = (now: number, width: number, height: number, index: number) => {
      const baseY = height * (0.24 + index * 0.12);
      const headX = ((now * (88 + index * 20)) % (width + 280)) - 140;
      const headY = getLineY({
        x: headX,
        baseY,
        height,
        now,
        index,
        pointerX: state.pointerX,
        pointerY: state.pointerY,
        active: state.active,
      });

      const trail = context.createLinearGradient(headX - 88, headY, headX + 12, headY);
      trail.addColorStop(0, "rgba(96, 165, 250, 0)");
      trail.addColorStop(0.45, "rgba(96, 165, 250, 0.18)");
      trail.addColorStop(0.8, "rgba(147, 197, 253, 0.85)");
      trail.addColorStop(1, "rgba(255, 255, 255, 0.96)");

      context.beginPath();
      for (let x = headX - 86; x <= headX + 10; x += 6) {
        const y = getLineY({
          x,
          baseY,
          height,
          now,
          index,
          pointerX: state.pointerX,
          pointerY: state.pointerY,
          active: state.active,
        });

        if (x === headX - 86) {
          context.moveTo(x, y);
        } else {
          context.lineTo(x, y);
        }
      }

      context.strokeStyle = trail;
      context.lineWidth = 3;
      context.shadowColor = "rgba(96, 165, 250, 0.7)";
      context.shadowBlur = 18;
      context.stroke();

      const glow = context.createRadialGradient(headX, headY, 0, headX, headY, 32);
      glow.addColorStop(0, "rgba(255, 255, 255, 0.98)");
      glow.addColorStop(0.18, "rgba(191, 219, 254, 0.95)");
      glow.addColorStop(0.42, "rgba(96, 165, 250, 0.7)");
      glow.addColorStop(1, "rgba(96, 165, 250, 0)");

      context.fillStyle = glow;
      context.beginPath();
      context.arc(headX, headY, 32, 0, Math.PI * 2);
      context.fill();
      context.shadowBlur = 0;
    };

    const drawPulse = (pulse: Pulse, nowMs: number) => {
      const age = nowMs - pulse.bornAt;
      const lifespan = 1450;
      const progress = clamp(age / lifespan, 0, 1);
      const radius = 18 + progress * 120 * pulse.strength;
      const alpha = (1 - progress) * 0.55;

      const ring = context.createRadialGradient(pulse.x, pulse.y, 0, pulse.x, pulse.y, radius);
      ring.addColorStop(0, `rgba(191, 219, 254, ${alpha * 0.9})`);
      ring.addColorStop(0.3, `rgba(96, 165, 250, ${alpha * 0.45})`);
      ring.addColorStop(1, "rgba(96, 165, 250, 0)");

      context.fillStyle = ring;
      context.beginPath();
      context.arc(pulse.x, pulse.y, radius, 0, Math.PI * 2);
      context.fill();
    };

    const animate = (timestamp: number) => {
      const now = timestamp * 0.001;
      const nowMs = timestamp;
      const { width, height } = state;

      state.pointerX += (state.targetX - state.pointerX) * 0.085;
      state.pointerY += (state.targetY - state.pointerY) * 0.085;
      state.active += ((state.active > 0 ? 1 : 0) - state.active) * 0.08;

      context.clearRect(0, 0, width, height);

      const parallaxX = (state.pointerX / width - 0.5) * 28;
      const parallaxY = (state.pointerY / height - 0.5) * 16;
      plane.style.transform = `perspective(2200px) rotateX(74deg) rotateZ(${parallaxX * 0.08}deg) translate3d(${parallaxX}px, ${parallaxY}px, 0) scale(1.12)`;

      const sky = context.createRadialGradient(width * 0.72, height * 0.18, 0, width * 0.72, height * 0.18, height * 0.72);
      sky.addColorStop(0, "rgba(147, 197, 253, 0.22)");
      sky.addColorStop(0.4, "rgba(219, 234, 254, 0.08)");
      sky.addColorStop(1, "rgba(255, 255, 255, 0)");
      context.fillStyle = sky;
      context.fillRect(0, 0, width, height);

      for (let index = 0; index < LINE_COUNT; index += 1) {
        const baseY = height * (0.24 + index * 0.12);

        context.beginPath();
        for (let x = -50; x <= width + 50; x += 18) {
          const y = getLineY({
            x,
            baseY,
            height,
            now,
            index,
            pointerX: state.pointerX,
            pointerY: state.pointerY,
            active: state.active,
          });

          if (x === -50) {
            context.moveTo(x, y);
          } else {
            context.lineTo(x, y);
          }
        }

        context.strokeStyle = "rgba(59, 130, 246, 0.14)";
        context.lineWidth = 1.35;
        context.stroke();

        context.strokeStyle = "rgba(125, 211, 252, 0.08)";
        context.lineWidth = 2.4;
        context.shadowColor = "rgba(96, 165, 250, 0.25)";
        context.shadowBlur = 14;
        context.stroke();
        context.shadowBlur = 0;

        drawLineHighlight(now, width, height, index);
      }

      pulses = pulses.filter((pulse) => nowMs - pulse.bornAt < 1450);
      pulses.forEach((pulse) => drawPulse(pulse, nowMs));

      if (state.active > 0.02) {
        const attractor = context.createRadialGradient(
          state.pointerX,
          state.pointerY,
          0,
          state.pointerX,
          state.pointerY,
          82
        );
        attractor.addColorStop(0, "rgba(255, 255, 255, 0.55)");
        attractor.addColorStop(0.18, "rgba(191, 219, 254, 0.36)");
        attractor.addColorStop(0.55, "rgba(96, 165, 250, 0.14)");
        attractor.addColorStop(1, "rgba(96, 165, 250, 0)");

        context.fillStyle = attractor;
        context.beginPath();
        context.arc(state.pointerX, state.pointerY, 82, 0, Math.PI * 2);
        context.fill();
      }

      frameId = window.requestAnimationFrame(animate);
    };

    resize();
    frameId = window.requestAnimationFrame(animate);

    window.addEventListener("resize", resize);
    window.addEventListener("pointermove", handlePointerMove, { passive: true });
    window.addEventListener("pointerdown", handlePointerDown, { passive: true });
    window.addEventListener("pointerleave", resetPointer);
    window.addEventListener("touchmove", handleTouchMove, { passive: true });
    window.addEventListener("touchstart", handleTouchStart, { passive: true });
    window.addEventListener("touchend", resetPointer, { passive: true });

    return () => {
      window.cancelAnimationFrame(frameId);
      window.removeEventListener("resize", resize);
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("pointerleave", resetPointer);
      window.removeEventListener("touchmove", handleTouchMove);
      window.removeEventListener("touchstart", handleTouchStart);
      window.removeEventListener("touchend", resetPointer);
    };
  }, [isMobile]);

  const useStaticMobileBackground = isMobile !== false;

  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden rounded-[32px]">
      <div className="absolute inset-0 bg-[linear-gradient(180deg,#ffffff_0%,#f7faff_44%,#eef4fb_100%)]" />
      <div
        className={`absolute inset-0 ${
          useStaticMobileBackground
            ? "bg-[radial-gradient(circle_at_top_left,rgba(255,255,255,0.97),transparent_42%),radial-gradient(circle_at_80%_12%,rgba(186,230,253,0.22),transparent_24%),radial-gradient(circle_at_50%_90%,rgba(148,163,184,0.08),transparent_32%)]"
            : "bg-[radial-gradient(circle_at_top_left,rgba(255,255,255,0.95),transparent_40%),radial-gradient(circle_at_80%_12%,rgba(186,230,253,0.3),transparent_28%),radial-gradient(circle_at_50%_90%,rgba(148,163,184,0.12),transparent_36%)]"
        }`}
      />
      {useStaticMobileBackground ? (
        <>
          <div
            className="absolute inset-x-[-8%] bottom-[-18%] h-[66%] opacity-70"
            style={{
              backgroundImage:
                "linear-gradient(to right, rgba(148,163,184,0.14) 1px, transparent 1px), linear-gradient(to bottom, rgba(148,163,184,0.14) 1px, transparent 1px)",
              backgroundSize: `${GRID_SIZE}px ${GRID_SIZE}px`,
              maskImage:
                "linear-gradient(180deg, transparent 0%, rgba(255,255,255,0.8) 24%, rgba(255,255,255,0.96) 100%)",
              WebkitMaskImage:
                "linear-gradient(180deg, transparent 0%, rgba(255,255,255,0.8) 24%, rgba(255,255,255,0.96) 100%)",
              transform: "perspective(1800px) rotateX(74deg) scale(1.04)",
              transformOrigin: "center bottom",
            }}
          />
          <div className="absolute inset-x-[10%] top-[19%] h-px bg-gradient-to-r from-transparent via-sky-200/75 to-transparent" />
          <div className="absolute inset-x-[18%] top-[31%] h-px bg-gradient-to-r from-transparent via-slate-200/70 to-transparent" />
        </>
      ) : (
        <>
          <div
            ref={planeRef}
            className="absolute inset-x-[-8%] bottom-[-24%] h-[72%] opacity-95"
            style={{
              backgroundImage:
                "linear-gradient(to right, rgba(148,163,184,0.18) 1px, transparent 1px), linear-gradient(to bottom, rgba(148,163,184,0.18) 1px, transparent 1px)",
              backgroundSize: `${GRID_SIZE}px ${GRID_SIZE}px`,
              maskImage: "linear-gradient(180deg, transparent 0%, rgba(255,255,255,0.88) 20%, #ffffff 100%)",
              WebkitMaskImage:
                "linear-gradient(180deg, transparent 0%, rgba(255,255,255,0.88) 20%, #ffffff 100%)",
              transform: "perspective(2200px) rotateX(74deg) scale(1.12)",
              transformOrigin: "center bottom",
            }}
          />
          <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />
        </>
      )}
      <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(255,255,255,0.76)_0%,rgba(255,255,255,0)_34%,rgba(255,255,255,0.14)_100%)]" />
    </div>
  );
}
