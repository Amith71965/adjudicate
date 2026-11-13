"use client";
/**
 * Toasts: quiet confirmations (role=status) and refusals (role=alert), bottom-right, gone after
 * a few seconds. One small provider; no library.
 */
import { CircleAlert, CircleCheck, X } from "lucide-react";
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";

type Tone = "ok" | "error";
interface Toast { id: number; tone: Tone; text: string }
interface Api { ok(text: string): void; error(text: string): void }

const ToastContext = createContext<Api | null>(null);

export function useToast(): Api {
  const api = useContext(ToastContext);
  if (!api) throw new Error("useToast needs a <ToastProvider>");
  return api;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seq = useRef(0);
  const dismiss = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  const push = useCallback((tone: Tone, text: string) => {
    const id = ++seq.current;
    setToasts((t) => [...t.slice(-2), { id, tone, text }]);
    setTimeout(() => dismiss(id), tone === "error" ? 7000 : 3500);
  }, [dismiss]);
  const api = useMemo<Api>(() => ({ ok: (t) => push("ok", t), error: (t) => push("error", t) }), [push]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="pointer-events-none fixed right-4 bottom-4 z-[60] flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-2">
        {toasts.map((t) => {
          const Icon = t.tone === "ok" ? CircleCheck : CircleAlert;
          return (
            <div
              key={t.id}
              role={t.tone === "ok" ? "status" : "alert"}
              className="toast-in pointer-events-auto flex items-start gap-3 rounded-xl border border-[var(--line)] bg-[var(--raised)] px-4 py-3 text-sm shadow-[var(--shadow-2)]"
            >
              <Icon aria-hidden="true" width={18} height={18} className={t.tone === "ok" ? "mt-0.5 shrink-0 text-[var(--green)]" : "mt-0.5 shrink-0 text-[var(--red)]"} />
              <p className="flex-1 leading-snug">{t.text}</p>
              <button type="button" onClick={() => dismiss(t.id)} aria-label="Dismiss notification" className="text-[var(--muted)] hover:text-[var(--ink)]">
                <X aria-hidden="true" width={16} height={16} />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}
