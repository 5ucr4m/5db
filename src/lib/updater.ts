import { useApp } from "../store/app";
import { errorMessage, isTauri } from "./rpc";

/**
 * Looks for a newer release and, if the user agrees, installs it and restarts.
 * `silent` keeps quiet when there is nothing to install, which is what the
 * check on launch wants; the command palette entry reports either way.
 */
export async function checkForUpdate({ silent }: { silent: boolean }) {
  if (!isTauri) {
    if (!silent) useApp.getState().toast("info", "Updates only apply to the installed app.");
    return;
  }
  const { toast, confirm } = useApp.getState();
  try {
    const { check } = await import("@tauri-apps/plugin-updater");
    const update = await check();
    if (!update) {
      if (!silent) toast("ok", "5db is up to date.");
      return;
    }
    const ok = await confirm({
      title: `Version ${update.version} is available`,
      body: update.body?.trim() || "Download it now and restart to finish?",
      confirmLabel: "Download and restart",
    });
    if (!ok) return;
    toast("info", `Downloading ${update.version}…`);
    await update.downloadAndInstall();
    const { relaunch } = await import("@tauri-apps/plugin-process");
    await relaunch();
  } catch (e) {
    // A failed check on launch is not worth interrupting anyone over.
    if (!silent) toast("error", errorMessage(e));
  }
}
