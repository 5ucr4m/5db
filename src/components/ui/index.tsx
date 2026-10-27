import { Loader2, X } from "lucide-react";
import {
  type ButtonHTMLAttributes,
  forwardRef,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { twMerge } from "tailwind-merge";

export const cx = (...c: (string | false | null | undefined)[]) => twMerge(c.filter(Boolean).join(" "));

// ---------------------------------------------------------------------------
// Buttons
// ---------------------------------------------------------------------------

type Variant = "primary" | "secondary" | "ghost" | "danger" | "subtle";

const variants: Record<Variant, string> = {
  primary:
    "bg-iris text-on-iris hover:bg-iris-strong shadow-[inset_0_1px_0_rgb(255_255_255/0.18),0_1px_2px_rgb(0_0_0/0.2)] disabled:opacity-50",
  secondary: "bg-raised text-fg border border-line hover:border-line-strong hover:bg-sunken disabled:opacity-50",
  ghost: "text-muted hover:text-fg hover:bg-raised disabled:opacity-40",
  subtle: "text-iris hover:bg-iris-soft disabled:opacity-40",
  danger: "bg-danger/90 text-white hover:bg-danger disabled:opacity-50",
};

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: "sm" | "md";
  icon?: ReactNode;
  loading?: boolean;
  kbd?: string;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", icon, loading, kbd, className, children, disabled, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      disabled={disabled || loading}
      className={cx(
        "inline-flex items-center justify-center gap-1.5 rounded-md font-medium whitespace-nowrap transition-colors select-none",
        size === "sm" ? "h-7 px-2.5 text-xs" : "h-8 px-3 text-sm",
        variants[variant],
        className,
      )}
      {...rest}
    >
      {loading ? <Loader2 className="size-3.5 animate-spin" /> : icon}
      {children}
      {kbd && <Kbd className={cx("ml-1", variant === "primary" && "border-white/25 bg-white/10 text-white/80")}>{kbd}</Kbd>}
    </button>
  );
});

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  active?: boolean;
  size?: "sm" | "md";
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, active, size = "md", className, children, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      title={label}
      className={cx(
        "inline-flex items-center justify-center rounded-md transition-colors disabled:opacity-35",
        size === "sm" ? "size-6" : "size-7",
        active ? "bg-iris-soft text-iris" : "text-muted hover:text-fg hover:bg-raised",
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
});

export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd
      className={cx(
        "inline-flex h-[18px] min-w-[18px] items-center justify-center rounded border border-line bg-sunken px-1 font-mono text-[10px] font-medium text-faint",
        className,
      )}
    >
      {children}
    </kbd>
  );
}

// ---------------------------------------------------------------------------
// Form controls
// ---------------------------------------------------------------------------

const field =
  "h-8 w-full rounded-md border border-line bg-sunken px-2.5 text-sm text-fg placeholder:text-faint outline-none transition-colors hover:border-line-strong focus:border-iris focus:ring-2 focus:ring-iris-soft";

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { mono?: boolean }>(function Input(
  { className, mono, ...rest },
  ref,
) {
  return <input ref={ref} spellCheck={false} autoComplete="off" className={cx(field, mono && "font-mono text-xs", className)} {...rest} />;
});

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select(
  { className, children, ...rest },
  ref,
) {
  return (
    <select
      ref={ref}
      className={cx(
        field,
        "appearance-none bg-[url('data:image/svg+xml;utf8,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%2210%22 height=%2210%22 viewBox=%220 0 10 10%22><path d=%22M2 4l3 3 3-3%22 fill=%22none%22 stroke=%22%23888%22 stroke-width=%221.4%22/></svg>')] bg-[length:10px] bg-[right_8px_center] bg-no-repeat pr-6",
        className,
      )}
      {...rest}
    >
      {children}
    </select>
  );
});

export function Field({ label, hint, children, className }: { label: string; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <label className={cx("flex flex-col gap-1.5", className)}>
      <span className="text-xs font-medium text-muted">{label}</span>
      {children}
      {hint && <span className="text-2xs text-faint">{hint}</span>}
    </label>
  );
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="group flex items-center gap-2 text-sm text-fg"
    >
      <span
        className={cx(
          "flex h-[18px] w-8 shrink-0 items-center rounded-full border px-[2px] transition-colors",
          checked ? "justify-end border-iris bg-iris" : "justify-start border-line-strong bg-sunken",
        )}
      >
        <span className="size-3 rounded-full bg-white shadow" />
      </span>
      {label}
    </button>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  size = "md",
}: {
  value: T;
  options: { value: T; label: ReactNode; title?: string }[];
  onChange: (v: T) => void;
  size?: "sm" | "md";
}) {
  return (
    <div className="inline-flex rounded-md border border-line bg-sunken p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          title={o.title}
          onClick={() => onChange(o.value)}
          className={cx(
            "rounded-[5px] px-2.5 font-medium transition-colors",
            size === "sm" ? "h-6 text-xs" : "h-7 text-sm",
            value === o.value ? "bg-raised text-fg shadow-sm ring-1 ring-line" : "text-muted hover:text-fg",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cx("size-4 animate-spin text-iris", className)} />;
}

export function Badge({
  children,
  className,
  tone = "neutral",
}: {
  children: ReactNode;
  className?: string;
  tone?: "neutral" | "iris" | "ok" | "warn" | "danger";
}) {
  const tones = {
    neutral: "bg-raised text-muted border-line",
    iris: "bg-iris-soft text-iris border-iris-line",
    ok: "bg-ok/10 text-ok border-ok/30",
    warn: "bg-warn/10 text-warn border-warn/30",
    danger: "bg-danger/10 text-danger border-danger/30",
  };
  return (
    <span
      className={cx(
        "inline-flex h-[18px] items-center gap-1 rounded border px-1.5 text-2xs font-semibold uppercase tracking-wide",
        tones[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Popover / menu
// ---------------------------------------------------------------------------

export function Popover({
  anchor,
  open,
  onClose,
  children,
  align = "start",
  className,
  matchWidth,
}: {
  anchor: HTMLElement | null;
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  align?: "start" | "end";
  className?: string;
  matchWidth?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null);

  useLayoutEffect(() => {
    if (!open || !anchor) return;
    const place = () => {
      const r = anchor.getBoundingClientRect();
      const el = ref.current;
      const w = el?.offsetWidth ?? 220;
      const h = el?.offsetHeight ?? 200;
      let left = align === "end" ? r.right - w : r.left;
      left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
      let top = r.bottom + 4;
      if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 4);
      setPos({ top, left, width: r.width });
    };
    place();
    const ro = new ResizeObserver(place);
    if (ref.current) ro.observe(ref.current);
    window.addEventListener("resize", place);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", place);
    };
  }, [open, anchor, align]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current?.contains(e.target as Node) || anchor?.contains(e.target as Node)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open, anchor, onClose]);

  if (!open) return null;
  return createPortal(
    <div
      ref={ref}
      style={{ top: pos?.top ?? -9999, left: pos?.left ?? -9999, minWidth: matchWidth ? pos?.width : undefined }}
      className={cx("fixed z-50 animate-pop-in rounded-lg bg-raised p-1 shadow-[var(--shadow-pop)]", className)}
    >
      {children}
    </div>,
    document.body,
  );
}

export function MenuItem({
  icon,
  children,
  onClick,
  danger,
  kbd,
  disabled,
  active,
}: {
  icon?: ReactNode;
  children: ReactNode;
  onClick?: () => void;
  danger?: boolean;
  kbd?: string;
  disabled?: boolean;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cx(
        "flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-sm transition-colors disabled:opacity-40",
        danger ? "text-danger hover:bg-danger/10" : "text-fg hover:bg-iris-soft",
        active && "bg-iris-soft text-iris",
      )}
    >
      {icon && <span className="flex size-4 shrink-0 items-center justify-center text-muted">{icon}</span>}
      <span className="flex-1 truncate">{children}</span>
      {kbd && <Kbd>{kbd}</Kbd>}
    </button>
  );
}

export const MenuSeparator = () => <div className="my-1 h-px bg-line" />;
export const MenuLabel = ({ children }: { children: ReactNode }) => (
  <div className="px-2 pt-1.5 pb-1 text-2xs font-semibold uppercase tracking-wider text-faint">{children}</div>
);

// ---------------------------------------------------------------------------
// Modal
// ---------------------------------------------------------------------------

export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  width = 480,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [open, onClose]);
  if (!open) return null;
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-[12vh] animate-fade-in backdrop-blur-[2px]"
      onMouseDown={onClose}
    >
      <div
        role="dialog"
        aria-modal
        style={{ width }}
        className="max-w-[calc(100vw-32px)] animate-slide-up overflow-hidden rounded-xl bg-panel shadow-[var(--shadow-pop)]"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <h2 className="font-display text-[15px] font-semibold">{title}</h2>
          <IconButton label="Close" size="sm" onClick={onClose}>
            <X className="size-4" />
          </IconButton>
        </div>
        <div className="max-h-[65vh] overflow-auto p-4">{children}</div>
        {footer && <div className="flex items-center justify-end gap-2 border-t border-line bg-ink/40 px-4 py-3">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

// ---------------------------------------------------------------------------
// Resizable split
// ---------------------------------------------------------------------------

export function useResizable(key: string, initial: number, min: number, max: number) {
  const [size, setSize] = useState<number>(() => {
    try {
      const v = Number(localStorage.getItem(`5db.size.${key}`));
      return v >= min && v <= max ? v : initial;
    } catch {
      return initial;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(`5db.size.${key}`, String(Math.round(size)));
    } catch {
      /* ignore */
    }
  }, [key, size]);
  return [size, setSize, min, max] as const;
}

export function Resizer({
  direction,
  onResize,
  className,
}: {
  direction: "x" | "y";
  /** Receives the pointer delta since drag start. */
  onResize: (delta: number, phase: "start" | "move") => void;
  className?: string;
}) {
  const onPointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    const start = direction === "x" ? e.clientX : e.clientY;
    onResize(0, "start");
    const move = (ev: PointerEvent) => onResize((direction === "x" ? ev.clientX : ev.clientY) - start, "move");
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.style.cursor = "";
    };
    document.body.style.cursor = direction === "x" ? "col-resize" : "row-resize";
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  return (
    <div
      onPointerDown={onPointerDown}
      className={cx(
        "group relative z-10 shrink-0",
        direction === "x" ? "w-px cursor-col-resize bg-line" : "h-px cursor-row-resize bg-line",
        className,
      )}
    >
      <div
        className={cx(
          "absolute transition-colors group-hover:bg-iris/60",
          direction === "x" ? "inset-y-0 -left-[2px] w-[5px]" : "inset-x-0 -top-[2px] h-[5px]",
        )}
      />
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  children,
  action,
}: {
  icon?: ReactNode;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
      {icon && <div className="flex size-11 items-center justify-center rounded-xl border border-line bg-raised text-iris">{icon}</div>}
      <div className="font-display text-base font-semibold">{title}</div>
      {children && <div className="max-w-sm text-sm text-muted">{children}</div>}
      {action}
    </div>
  );
}
