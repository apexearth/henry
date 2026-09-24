// The peek's editor: CodeMirror 6 over the file's text, for the odd spec you would rather
// write here than open an editor for. Grammars load on demand, like the read view's, and are
// painted with the read view's hljs-* classes, so both views share one palette and the light
// shade for free. Undo, multiple cursors, bracket pairs, fold, find/replace and Tab-to-indent
// come with it; what does not is anything that knows the project (no completion, no lint).
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, foldGutter, foldKeymap, HighlightStyle, indentOnInput, LanguageDescription, syntaxHighlighting } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { closeSearchPanel, highlightSelectionMatches, openSearchPanel, searchKeymap, searchPanelOpen } from "@codemirror/search";
import { Compartment, EditorState } from "@codemirror/state";
import { drawSelection, dropCursor, EditorView, highlightActiveLine, highlightActiveLineGutter, highlightSpecialChars, keymap, lineNumbers, rectangularSelection } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import { languageFor } from "./highlight";
import { baseName } from "./platform";

// Lezer tags onto highlight.js class names (styles.css colours them under .peek-body).
const palette = HighlightStyle.define([
  { tag: [t.keyword, t.modifier, t.operatorKeyword, t.controlKeyword, t.definitionKeyword, t.moduleKeyword, t.typeName], class: "hljs-keyword" },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.className, t.definition(t.variableName), t.namespace], class: "hljs-title" },
  { tag: [t.number, t.bool, t.null, t.atom, t.attributeName, t.propertyName, t.variableName, t.literal, t.meta, t.annotation, t.operator, t.labelName], class: "hljs-attr" },
  { tag: [t.string, t.regexp, t.special(t.string), t.escape, t.attributeValue, t.url, t.link], class: "hljs-string" },
  { tag: [t.standard(t.variableName), t.self], class: "hljs-built_in" },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], class: "hljs-comment" },
  { tag: [t.tagName, t.angleBracket, t.quote, t.processingInstruction], class: "hljs-name" },
  { tag: t.heading, class: "hljs-section" },
  { tag: t.list, class: "hljs-bullet" },
  { tag: t.monospace, class: "hljs-code" },
  { tag: t.emphasis, class: "hljs-emphasis" },
  { tag: t.strong, class: "hljs-strong" },
  { tag: t.strikethrough, class: "hljs-deletion" },
  { tag: t.inserted, class: "hljs-addition" },
  { tag: t.deleted, class: "hljs-deletion" },
]);

// The app's variables, so the editor follows the theme without a theme of its own.
const look = EditorView.theme({
  "&": { height: "100%", fontSize: "12px", backgroundColor: "var(--bg)", color: "var(--fg)" },
  ".cm-scroller": { fontFamily: "var(--mono)", lineHeight: "1.5", overflow: "auto" },
  ".cm-content": { caretColor: "var(--fg)", padding: "0" },
  ".cm-line": { padding: "0 1ch 0 0" },
  ".cm-gutters": { backgroundColor: "var(--bg)", color: "var(--fg-faint)", borderRight: "1px solid var(--border)" },
  ".cm-lineNumbers .cm-gutterElement": { minWidth: "5ch", padding: "0 1ch 0 0" },
  ".cm-activeLineGutter": { backgroundColor: "var(--bg-2)", color: "var(--fg-dim)" },
  ".cm-activeLine": { backgroundColor: "var(--bg-2)" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--fg)" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": { backgroundColor: "var(--sel)" },
  ".cm-selectionMatch": { backgroundColor: "var(--accent-soft)" },
  ".cm-matchingBracket, &.cm-focused .cm-matchingBracket": { backgroundColor: "var(--accent-soft)", outline: "none" },
  ".cm-searchMatch": { backgroundColor: "var(--accent-soft)", outline: "none" },
  ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "var(--accent)", color: "var(--bg)" },
  ".cm-panels": { backgroundColor: "var(--bg-2)", color: "var(--fg)", fontSize: "12px" },
  ".cm-panels.cm-panels-top": { borderBottom: "1px solid var(--border)" },
  ".cm-panel.cm-search": { padding: "4px 10px" },
  ".cm-panel.cm-search label": { color: "var(--fg-dim)", fontSize: "11px" },
  ".cm-textfield": { backgroundColor: "var(--bg)", color: "var(--fg)", border: "1px solid var(--border)", borderRadius: "4px", fontFamily: "var(--mono)", fontSize: "12px" },
  ".cm-button": { backgroundImage: "none", backgroundColor: "var(--bg-3)", color: "var(--fg)", border: "1px solid var(--border)", borderRadius: "4px", fontFamily: "var(--mono)", fontSize: "11px" },
  ".cm-foldGutter .cm-gutterElement": { color: "var(--fg-faint)" },
  ".cm-foldPlaceholder": { backgroundColor: "var(--bg-3)", color: "var(--fg-dim)", border: "none" },
  ".cm-tooltip": { backgroundColor: "var(--bg-2)", color: "var(--fg)", border: "1px solid var(--border)" },
});

export interface EditorHandle {
  text(): string;
  focus(): void;
  /** Open, or close, the editor's own find/replace panel; `isFinding` says whether it is up. */
  find(action: "open" | "close"): void;
  isFinding(): boolean;
}

interface Props {
  path: string;
  /** The text on mount; later edits live in the editor, reported through `onChange`. */
  doc: string;
  onChange: (text: string) => void;
  onSave: () => void;
}

export const Editor = forwardRef<EditorHandle, Props>(function Editor({ path, doc, onChange, onSave }, ref) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView>();
  const cb = useRef({ onChange, onSave });
  cb.current = { onChange, onSave };

  useImperativeHandle(ref, () => ({
    text: () => view.current?.state.doc.toString() ?? doc,
    focus: () => view.current?.focus(),
    find: (action) => {
      if (!view.current) return;
      if (action === "open") openSearchPanel(view.current);
      else closeSearchPanel(view.current);
    },
    isFinding: () => !!view.current && searchPanelOpen(view.current.state),
  }), [doc]);

  useEffect(() => {
    if (!host.current) return;
    const lang = new Compartment();
    // Prose wraps; code scrolls sideways like the read view.
    const prose = languageFor(path) === "markdown" || languageFor(path) === undefined;
    const v = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc,
        extensions: [
          lineNumbers(), highlightActiveLineGutter(), highlightSpecialChars(), history(), foldGutter(), drawSelection(), dropCursor(),
          EditorState.allowMultipleSelections.of(true), indentOnInput(), bracketMatching(), closeBrackets(), rectangularSelection(),
          highlightActiveLine(), highlightSelectionMatches(), syntaxHighlighting(palette), look, lang.of([]),
          prose ? EditorView.lineWrapping : [],
          keymap.of([
            { key: "Mod-s", run: () => (cb.current.onSave(), true) },
            ...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...foldKeymap, indentWithTab,
          ]),
          EditorView.updateListener.of((u) => u.docChanged && cb.current.onChange(u.state.doc.toString())),
        ],
      }),
    });
    view.current = v;
    v.focus();
    let on = true;
    LanguageDescription.matchFilename(languages, baseName(path))?.load().then((support) => on && v.dispatch({ effects: lang.reconfigure(support) }), () => {});
    return () => {
      on = false;
      v.destroy();
      view.current = undefined;
    };
    // The editor owns the text after mount; a new `doc` means a new file, which is a new panel.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  return <div className="peek-editor" ref={host} />;
});
