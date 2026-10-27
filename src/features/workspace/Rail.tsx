import { Command, Home, Moon, Sun, SunMoon, X } from "lucide-react";
import { cx } from "../../components/ui";
import { ENV_META, monogram } from "../../lib/connections";
import { useApp } from "../../store/app";

export function Rail() {
  const sessions = useApp((s) => s.sessions);
  const connections = useApp((s) => s.connections);
  const activeId = useApp((s) => s.activeSessionId);
  const setActive = useApp((s) => s.setActiveSession);
  const closeSession = useApp((s) => s.closeSession);
  const theme = useApp((s) => s.theme);
  const setTheme = useApp((s) => s.setTheme);
  const setPaletteOpen = useApp((s) => s.setPaletteOpen);

  const nextTheme = theme === "system" ? "dark" : theme === "dark" ? "light" : "system";
  const ThemeIcon = theme === "system" ? SunMoon : theme === "dark" ? Moon : Sun;

  return (
    <nav aria-label="Connections" className="flex w-[56px] shrink-0 flex-col items-center gap-2 border-r border-line bg-sunken py-3">
      <button
        type="button"
        onClick={() => setActive(null)}
        title="All connections"
        className={cx(
          "flex size-9 items-center justify-center rounded-xl transition-colors",
          activeId === null ? "bg-iris text-on-iris shadow-[0_4px_14px_-4px_var(--iris)]" : "text-muted hover:bg-raised hover:text-fg",
        )}
      >
        {activeId === null ? <span className="font-display text-[13px] font-bold">5db</span> : <Home className="size-4" />}
      </button>
      <div className="my-1 h-px w-6 bg-line" />
      <div className="flex min-h-0 w-full flex-1 flex-col items-center gap-2.5 overflow-x-hidden overflow-y-auto py-1.5 [scrollbar-width:none]">
        {sessions.map((s) => {
          const c = connections.find((x) => x.id === s.connectionId);
          if (!c) return null;
          const active = s.id === activeId;
          const env = ENV_META[c.env] ?? ENV_META.local;
          return (
            <div key={s.id} className="group relative">
              <span
                className={cx(
                  "absolute top-1/2 -left-[10px] w-[3px] -translate-y-1/2 rounded-r-full bg-iris transition-all",
                  active ? "h-6" : "h-0 group-hover:h-2.5",
                )}
              />
              <button
                type="button"
                onClick={() => setActive(s.id)}
                title={`${c.name} · ${env.label}${s.status === "error" ? " · connection failed" : ""}`}
                className={cx(
                  "relative flex size-9 items-center justify-center rounded-[10px] font-display text-[12px] font-bold text-white transition-opacity",
                  active ? "opacity-100" : "opacity-70 hover:opacity-100",
                )}
                style={{ background: c.color, outline: active ? `2px solid ${env.color}` : undefined, outlineOffset: 2 }}
              >
                {monogram(c.name)}
                <span
                  className={cx(
                    "absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full border-2 border-sunken",
                    s.status === "ready" ? "bg-ok" : s.status === "connecting" ? "animate-pulse bg-warn" : "bg-danger",
                  )}
                />
              </button>
              <button
                type="button"
                onClick={() => closeSession(s.id)}
                aria-label={`Disconnect ${c.name}`}
                title="Disconnect"
                className="absolute -top-1 -right-1 hidden size-4 items-center justify-center rounded-full border border-line bg-raised text-muted group-hover:flex hover:text-fg"
              >
                <X className="size-2.5" />
              </button>
            </div>
          );
        })}
      </div>
      <button
        type="button"
        onClick={() => setPaletteOpen(true)}
        title="Command palette (⌘K)"
        className="flex size-8 items-center justify-center rounded-lg text-muted hover:bg-raised hover:text-fg"
      >
        <Command className="size-4" />
      </button>
      <button
        type="button"
        onClick={() => setTheme(nextTheme)}
        title={`Theme: ${theme}. Switch to ${nextTheme}.`}
        className="flex size-8 items-center justify-center rounded-lg text-muted hover:bg-raised hover:text-fg"
      >
        <ThemeIcon className="size-4" />
      </button>
    </nav>
  );
}
