"use client";
/** A number that eases to its new value (instantly under reduced motion). Decorative: pair it with text. */
import { useEffect, useRef, useState } from "react";

export function AnimatedNumber({ value, duration = 420, className }: { value: number; duration?: number; className?: string }) {
  const [shown, setShown] = useState(value);
  const from = useRef(value);

  useEffect(() => {
    const start = from.current;
    from.current = value;
    const reduced = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (start === value || reduced || typeof requestAnimationFrame !== "function") {
      const id = setTimeout(() => setShown(value), 0);
      return () => clearTimeout(id);
    }
    const t0 = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const k = Math.min(1, (now - t0) / duration);
      const eased = 1 - Math.pow(1 - k, 3);
      setShown(Math.round(start + (value - start) * eased));
      if (k < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value, duration]);

  return <span aria-hidden="true" className={className}>{shown}</span>;
}
