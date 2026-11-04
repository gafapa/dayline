import { useEditor, EditorContent } from "@tiptap/react";
import { documentExtensions } from "../shared/editor-schema";
import "katex/dist/katex.min.css";
import Placeholder from "@tiptap/extension-placeholder";
import {
  Bold,
  Italic,
  Heading2,
  List,
  ListOrdered,
  Code2,
  Quote,
  Undo,
  Redo,
  Table2,
  ListChecks,
  Link2,
} from "lucide-react";
import { useEffect, useRef } from "react";

export default function Editor(props: {
  content: any;
  onChange: (content: any) => void;
  editable?: boolean;
}) {
  return <CompatibleEditor {...props} />;
}

function CompatibleEditor({
  content,
  onChange,
  editable = true,
}: {
  content: any;
  onChange: (content: any) => void;
  editable?: boolean;
}) {
  const change = useRef(onChange);
  change.current = onChange;
  const editor = useEditor(
    {
      extensions: [
        ...documentExtensions(),
        Placeholder.configure({
          placeholder: "Escribe una idea, una decisión o el siguiente paso…",
        }),
      ],
      content: content || { type: "doc", content: [{ type: "paragraph" }] },
      editable,
      shouldRerenderOnTransaction: false,
      onUpdate: ({ editor }) => change.current(editor.getJSON()),
    },
    [],
  );
  useEffect(() => {
    editor?.setEditable(editable);
  }, [editable, editor]);
  if (!editor) return <p role="status">Preparando el documento…</p>;
  const actions = [
    {
      label: "Tabla",
      icon: Table2,
      run: () =>
        editor
          .chain()
          .focus()
          .insertTable({ rows: 3, cols: 3, withHeaderRow: true })
          .run(),
    },
    {
      label: "Lista de tareas",
      icon: ListChecks,
      run: () => editor.chain().focus().toggleTaskList().run(),
    },
    {
      label: "Enlace",
      icon: Link2,
      run: () => {
        const href = prompt(
          "Dirección del enlace (https:// o enlace interno de plantilla)",
        );
        if (
          href &&
          (/^(https?:\/\/|mailto:|#)/i.test(href) ||
            (href.startsWith("/") && !href.startsWith("//")))
        )
          editor.chain().focus().setLink({ href }).run();
      },
    },
    {
      label: "Negrita",
      icon: Bold,
      run: () => editor.chain().focus().toggleBold().run(),
    },
    {
      label: "Cursiva",
      icon: Italic,
      run: () => editor.chain().focus().toggleItalic().run(),
    },
    {
      label: "Título",
      icon: Heading2,
      run: () => editor.chain().focus().toggleHeading({ level: 2 }).run(),
    },
    {
      label: "Lista",
      icon: List,
      run: () => editor.chain().focus().toggleBulletList().run(),
    },
    {
      label: "Lista numerada",
      icon: ListOrdered,
      run: () => editor.chain().focus().toggleOrderedList().run(),
    },
    {
      label: "Código",
      icon: Code2,
      run: () => editor.chain().focus().toggleCodeBlock().run(),
    },
    {
      label: "Cita",
      icon: Quote,
      run: () => editor.chain().focus().toggleBlockquote().run(),
    },
    {
      label: "Deshacer",
      icon: Undo,
      run: () => editor.chain().focus().undo().run(),
    },
    {
      label: "Rehacer",
      icon: Redo,
      run: () => editor.chain().focus().redo().run(),
    },
  ];
  return (
    <div className="document-editor">
      {editable && (
        <div
          className="editor-toolbar"
          role="toolbar"
          aria-label="Formato del documento"
        >
          {actions.map((a) => (
            <button
              key={a.label}
              type="button"
              title={a.label}
              aria-label={a.label}
              onClick={a.run}
            >
              <a.icon size={16} />
            </button>
          ))}
        </div>
      )}
      <EditorContent editor={editor} />
    </div>
  );
}
