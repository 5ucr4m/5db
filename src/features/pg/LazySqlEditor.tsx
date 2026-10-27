import { type ComponentProps, forwardRef, lazy, Suspense } from "react";
import type { SqlEditorHandle, SqlEditor as SqlEditorT } from "./SqlEditor";

// CodeMirror is the largest dependency; load it the first time an editor shows.
const Impl = lazy(() => import("./SqlEditor").then((m) => ({ default: m.SqlEditor })));

export const SqlEditor = forwardRef<SqlEditorHandle, ComponentProps<typeof SqlEditorT>>(function LazySqlEditor(props, ref) {
  return (
    <Suspense fallback={<div className={props.className} />}>
      <Impl ref={ref} {...props} />
    </Suspense>
  );
});

export type { SqlEditorHandle };
