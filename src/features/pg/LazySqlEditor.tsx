import { forwardRef, lazy, Suspense, type ComponentProps } from "react";
import type { SqlEditor as SqlEditorT, SqlEditorHandle } from "./SqlEditor";

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
