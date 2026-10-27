import { AlertTriangle, CheckCircle2, Info, X } from "lucide-react";
import { useApp } from "../../store/app";
import { Button, cx, Modal } from "./index";

export function Toasts() {
  const toasts = useApp((s) => s.toasts);
  const dismiss = useApp((s) => s.dismissToast);
  return (
    <div className="pointer-events-none fixed right-4 bottom-4 z-[60] flex w-[360px] flex-col gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          role="status"
          className="pointer-events-auto flex animate-slide-up items-start gap-2.5 rounded-lg bg-raised px-3 py-2.5 text-sm shadow-[var(--shadow-pop)]"
        >
          {t.kind === "ok" ? (
            <CheckCircle2 className="mt-px size-4 shrink-0 text-ok" />
          ) : t.kind === "error" ? (
            <AlertTriangle className="mt-px size-4 shrink-0 text-danger" />
          ) : (
            <Info className="mt-px size-4 shrink-0 text-iris" />
          )}
          <span className={cx("selectable flex-1 break-words", t.kind === "error" && "text-fg")}>{t.message}</span>
          <button type="button" className="text-faint hover:text-fg" onClick={() => dismiss(t.id)} aria-label="Dismiss">
            <X className="size-3.5" />
          </button>
        </div>
      ))}
    </div>
  );
}

export function ConfirmDialog() {
  const req = useApp((s) => s.confirmRequest);
  const resolve = useApp((s) => s.resolveConfirm);
  return (
    <Modal
      open={!!req}
      onClose={() => resolve(false)}
      title={req?.title}
      width={420}
      footer={
        <>
          <Button onClick={() => resolve(false)}>Cancel</Button>
          <Button autoFocus variant={req?.danger ? "danger" : "primary"} onClick={() => resolve(true)}>
            {req?.confirmLabel}
          </Button>
        </>
      }
    >
      <div className="selectable text-sm whitespace-pre-wrap text-muted">{req?.body}</div>
    </Modal>
  );
}
