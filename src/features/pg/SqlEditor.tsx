import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { PostgreSQL, type SQLNamespace, sql } from "@codemirror/lang-sql";
import { bracketMatching, HighlightStyle, indentOnInput, syntaxHighlighting } from "@codemirror/language";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { Compartment, EditorState, type Extension, StateEffect, StateField } from "@codemirror/state";
import {
  placeholder as cmPlaceholder,
  Decoration,
  type DecorationSet,
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef } from "react";
import { statementAt } from "../../lib/sql";
import type { CompletionTable } from "../../store/app";

const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.operatorKeyword, t.modifier], color: "var(--iris)", fontWeight: "600" },
  { tag: [t.typeName, t.standard(t.name)], color: "var(--t-time)" },
  { tag: [t.string, t.special(t.string)], color: "var(--t-bool)" },
  { tag: [t.number, t.bool, t.null], color: "var(--t-num)" },
  { tag: [t.comment, t.lineComment, t.blockComment], color: "var(--fg-faint)", fontStyle: "italic" },
  { tag: [t.operator, t.punctuation, t.separator, t.bracket], color: "var(--fg-muted)" },
  { tag: [t.special(t.name), t.special(t.variableName)], color: "var(--t-json)" },
  { tag: t.variableName, color: "var(--fg)" },
]);

const theme = EditorView.theme({
  "&": { color: "var(--fg)" },
  ".cm-content": { padding: "10px 0", caretColor: "var(--iris)" },
  ".cm-line": { padding: "0 14px" },
  ".cm-gutterElement": { padding: "0 10px 0 12px !important", fontSize: "11px" },
  ".cm-placeholder": { color: "var(--fg-faint)" },
  ".cm-matchingBracket": { background: "var(--iris-soft)", outline: "1px solid var(--iris-line)" },
});

const setErrorMark = StateEffect.define<{ from: number; to: number } | null>();
const errorField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(setErrorMark)) {
        deco =
          e.value && e.value.to > e.value.from
            ? Decoration.set([Decoration.mark({ class: "cm-error-mark" }).range(e.value.from, e.value.to)])
            : Decoration.none;
      }
    }
    if (tr.docChanged) deco = Decoration.none;
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

/** Faintly marks the statement that ⌘↵ would run. */
const statementField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    if (!tr.docChanged && !tr.selection) return deco;
    const state = tr.state;
    if (state.doc.length > 200_000) return Decoration.none;
    const sel = state.selection.main;
    if (!sel.empty) return Decoration.none;
    const text = state.doc.toString();
    const stmt = statementAt(text, sel.head);
    if (!stmt || stmt.text.length === text.trim().length) return Decoration.none;
    return Decoration.set([Decoration.mark({ class: "cm-statement-mark" }).range(stmt.from, stmt.to)]);
  },
  provide: (f) => EditorView.decorations.from(f),
});

export interface SqlEditorHandle {
  getValue(): string;
  setValue(v: string): void;
  insert(text: string): void;
  /** Selection if any, else the statement under the cursor. */
  getRunnable(): { text: string; offset: number };
  markError(from: number, to: number): void;
  clearError(): void;
  focus(): void;
}

interface Props {
  initialValue: string;
  onChange?: (v: string) => void;
  onRun?: () => void;
  onRunAll?: () => void;
  onSave?: () => void;
  completion?: CompletionTable[];
  readOnly?: boolean;
  placeholder?: string;
  className?: string;
}

function toNamespace(tables: CompletionTable[] | undefined): SQLNamespace {
  const ns: Record<string, Record<string, string[]>> = {};
  const flat: Record<string, string[]> = {};
  for (const tb of tables ?? []) {
    (ns[tb.schema] ??= {})[tb.table] = tb.columns;
    if (tb.schema === "public" || !(tb.table in flat)) flat[tb.table] = tb.columns;
  }
  return { ...ns, ...flat } as SQLNamespace;
}

export const SqlEditor = forwardRef<SqlEditorHandle, Props>(function SqlEditor(
  { initialValue, onChange, onRun, onRunAll, onSave, completion, readOnly, placeholder, className },
  ref,
) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const langComp = useMemo(() => new Compartment(), []);
  const handlers = useRef({ onChange, onRun, onRunAll, onSave });
  handlers.current = { onChange, onRun, onRunAll, onSave };

  useEffect(() => {
    if (!host.current) return;
    const runKeys = keymap.of([
      { key: "Mod-Enter", run: () => (handlers.current.onRun?.(), true) },
      { key: "Shift-Mod-Enter", run: () => (handlers.current.onRunAll?.(), true) },
      { key: "Mod-s", run: () => (handlers.current.onSave?.(), true) },
    ]);
    const extensions: Extension[] = [
      runKeys,
      lineNumbers(),
      highlightActiveLineGutter(),
      highlightActiveLine(),
      drawSelection(),
      history(),
      indentOnInput(),
      bracketMatching(),
      closeBrackets(),
      search({ top: true }),
      highlightSelectionMatches(),
      autocompletion({ activateOnTyping: true, icons: false }),
      syntaxHighlighting(highlight),
      keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...completionKeymap, indentWithTab]),
      langComp.of(sql({ dialect: PostgreSQL, upperCaseKeywords: true, schema: toNamespace(completion) })),
      theme,
      errorField,
      statementField,
      EditorView.lineWrapping,
      EditorState.readOnly.of(!!readOnly),
      EditorView.updateListener.of((u) => {
        if (u.docChanged) handlers.current.onChange?.(u.state.doc.toString());
      }),
    ];
    if (placeholder) extensions.push(cmPlaceholder(placeholder));
    const v = new EditorView({ parent: host.current, state: EditorState.create({ doc: initialValue, extensions }) });
    view.current = v;
    return () => {
      v.destroy();
      view.current = null;
    };
    // The editor owns its document after mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    view.current?.dispatch({
      effects: langComp.reconfigure(sql({ dialect: PostgreSQL, upperCaseKeywords: true, schema: toNamespace(completion) })),
    });
  }, [completion, langComp]);

  useImperativeHandle(ref, () => ({
    getValue: () => view.current?.state.doc.toString() ?? "",
    setValue: (val: string) => {
      const v = view.current;
      if (!v) return;
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: val }, selection: { anchor: val.length } });
    },
    insert: (text: string) => {
      const v = view.current;
      if (!v) return;
      v.dispatch(v.state.replaceSelection(text));
      v.focus();
    },
    getRunnable: () => {
      const v = view.current;
      if (!v) return { text: "", offset: 0 };
      const sel = v.state.selection.main;
      const doc = v.state.doc.toString();
      if (!sel.empty) return { text: doc.slice(sel.from, sel.to), offset: sel.from };
      const stmt = statementAt(doc, sel.head);
      return stmt ? { text: stmt.text, offset: stmt.from } : { text: doc, offset: 0 };
    },
    markError: (from: number, to: number) => {
      const v = view.current;
      if (!v) return;
      const len = v.state.doc.length;
      const f = Math.max(0, Math.min(from, len));
      const tEnd = Math.max(f, Math.min(to, len));
      v.dispatch({ effects: setErrorMark.of({ from: f, to: tEnd }), selection: { anchor: f }, scrollIntoView: true });
    },
    clearError: () => view.current?.dispatch({ effects: setErrorMark.of(null) }),
    focus: () => view.current?.focus(),
  }));

  return <div ref={host} className={className} />;
});
