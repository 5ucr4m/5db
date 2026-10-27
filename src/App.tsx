import { useEffect } from "react";
import { ConfirmDialog, Toasts } from "./components/ui/Overlays";
import { Home } from "./features/connections/Home";
import { CommandPalette } from "./features/palette/CommandPalette";
import { Rail } from "./features/workspace/Rail";
import { Workspace } from "./features/workspace/Workspace";
import { useApp } from "./store/app";

export default function App() {
  const loadConnections = useApp((s) => s.loadConnections);
  const restoreWorkspace = useApp((s) => s.restoreWorkspace);
  const sessions = useApp((s) => s.sessions);
  const activeId = useApp((s) => s.activeSessionId);

  // The workspace is restored after the connections, which it refers to by id.
  useEffect(() => {
    void loadConnections().then(restoreWorkspace);
  }, [loadConnections, restoreWorkspace]);

  // Block the webview's own reload/find shortcuts; the app gives them meaning.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && ["r", "f", "p"].includes(e.key.toLowerCase()) && !e.defaultPrevented) e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    const noMenu = (e: MouseEvent) => {
      const el = e.target as HTMLElement;
      if (!el.closest("input, textarea, .cm-editor, .selectable")) e.preventDefault();
    };
    window.addEventListener("contextmenu", noMenu);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("contextmenu", noMenu);
    };
  }, []);

  return (
    <div className="flex h-full overflow-hidden">
      <Rail />
      <div className={activeId === null ? "flex min-w-0 flex-1 flex-col" : "hidden"}>
        <Home />
      </div>
      {sessions.map((s) => (
        <Workspace key={s.id} session={s} visible={s.id === activeId} />
      ))}
      <CommandPalette />
      <ConfirmDialog />
      <Toasts />
    </div>
  );
}
