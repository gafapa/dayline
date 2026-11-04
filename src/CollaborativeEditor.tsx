import { requestResourceLink } from "./navigation";
import { assertDocumentContent } from "../shared/document-content";
import { useEffect, useState, useRef, lazy, Suspense } from "react";
import { useEditor, EditorContent, type Editor as TiptapEditor } from "@tiptap/react";
import DragHandle from "@tiptap/extension-drag-handle-react";
import FileHandler from "@tiptap/extension-file-handler";
import { documentExtensions } from "../shared/editor-schema";
import { documentDurabilityPayload } from "../shared/durability";
import { documentHeadings, type DocumentNode } from "../shared/documents";
import "katex/dist/katex.min.css";
import Collaboration from "@tiptap/extension-collaboration";
import Placeholder from "@tiptap/extension-placeholder";
import { HocuspocusProvider } from "@hocuspocus/provider";
import { IndexeddbPersistence, storeState } from "y-indexeddb";
import { initialDocument } from "../shared/document-seed";
import * as Y from "yjs";
import { Bold, Italic, Heading2, List, ListOrdered, Code2, Quote, Check, WifiOff, Table2, ListChecks, Link2, Sigma, GitBranch, Plus, GripVertical } from "lucide-react";
import { api, send } from "./api";
import { documentDatabaseChanged } from "./local-database";
import { useLocalGuard } from "./useLocalGuard";
import type { User } from "../shared/model";
import { flushOutbox, pendingOperations } from "./storage";
import { uploadAttachment } from "./Attachments";

interface Bundle {
  doc: Y.Doc;
  provider: HocuspocusProvider;
  persistence: IndexeddbPersistence;
}
import DiagramPreview from "./DiagramPreview";
export default function CollaborativeEditor({
  documentId,
  workspaceId,
  user,
  editable,
  onContent,
  restore,
  hasServerContent,
}: {
  documentId: string;
  workspaceId: string;
  user: User;
  editable: boolean;
  onContent?: (content: DocumentNode) => void;
  restore?: { revision: string; content: DocumentNode };
  hasServerContent?: boolean;
}) {
  const [bundle, setBundle] = useState<Bundle | null>(null),
    [compatibilityError, setCompatibilityError] = useState(""),
    [unavailable, setUnavailable] = useState(false),
    [accessDenied, setAccessDenied] = useState(false),
    [serverReadOnly, setServerReadOnly] = useState(false),
    [status, setStatus] = useState("Abriendo copia local…"),
    [people, setPeople] = useState<string[]>([]);
  useLocalGuard(
    editable && status !== "Guardado en el servidor"
      ? "Hay un documento abierto cuyo guardado no está confirmado. Espera a su sincronización antes de cerrar sesión."
      : "",
  );
  useEffect(() => {
    setAccessDenied(false);
    setServerReadOnly(false);
    setCompatibilityError("");
    setBundle(null);
    const doc = new Y.Doc();
    let persistence: IndexeddbPersistence | undefined;
    let provider: HocuspocusProvider | undefined,
      disposed = false,
      revision = 0,
      connected = false,
      accessBlocked = false,
      durableDigest = "";
    let confirmationTimer: ReturnType<typeof setTimeout>;
    doc.on("update", () => {
      revision++;
    });
    const confirmDurability = (digest: string) => {
      clearTimeout(confirmationTimer);
      confirmationTimer = setTimeout(() => {
        void checkDurability(digest).catch(() => {});
      }, 150);
    };
    const checkDurability = async (digest: string) => {
      const currentRevision = revision;
      const hash = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(documentDurabilityPayload(doc)),
      );
      const current = Array.from(new Uint8Array(hash), (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join("");
      if (
        !disposed &&
        connected &&
        currentRevision === revision &&
        digest === current
      ) {
        await persistence?.set("unsynced", 0);
        if (disposed || currentRevision !== revision) {
          if (currentRevision !== revision)
            await persistence?.set("unsynced", 1);
          return;
        }
        setStatus("Guardado en el servidor");
      }
    };
    void (async () => {
      const localPersistence = new IndexeddbPersistence(
        `kelvin-${user.id}-document-${documentId}`,
        doc,
      );
      persistence = localPersistence;
      await localPersistence.whenSynced;
      if (disposed) return;
      const databaseName = `kelvin-${user.id}-document-${documentId}`;
      if (localPersistence.db)
        localPersistence.db.onversionchange = (event) => {
          accessBlocked = true;
          provider?.disconnect();
          void localPersistence.destroy();
          if (event.newVersion !== null) documentDatabaseChanged(databaseName);
          setCompatibilityError(
            "Otra pestaña ha actualizado el almacenamiento. Conserva los cambios y actualiza esta pestaña.",
          );
        };
      doc.on("update", () => {
        void localPersistence.set("unsynced", 1).catch(() => {
          if (!disposed)
            setStatus(
              "No se pudo confirmar la copia local. Conserva y exporta los cambios antes de salir.",
            );
        });
      });
      if (doc.getXmlFragment("default").length === 0) {
        const creation = (await pendingOperations(user.id, workspaceId)).find(
          (item) =>
            item.mutation.id === documentId &&
            item.mutation.kind === "document" &&
            item.mutation.expectedVersion === 0 &&
            item.mutation.data.documentSeedVersion === 1,
        );
        if (disposed) return;
        if (creation) {
          const seed = initialDocument(
            creation.mutation.data.content || {
              type: "doc",
              content: [{ type: "paragraph" }],
            },
            documentId,
          );
          try {
            Y.applyUpdate(doc, Y.encodeStateAsUpdate(seed));
            await storeState(localPersistence, true);
          } finally {
            seed.destroy();
          }
          if (disposed) return;
        }
      }
      if (
        !navigator.onLine &&
        hasServerContent &&
        doc.getXmlFragment("default").length === 0
      ) {
        setUnavailable(true);
        return;
      }
      provider = new HocuspocusProvider({
        url: `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/collaboration`,
        name: documentId,
        document: doc,
        token: async () => {
          await flushOutbox(user.id, workspaceId, () => {});
          return (await api("/collaboration/ticket", send({}))).ticket;
        },
        onStatus: ({ status }) => {
          if (disposed || accessBlocked) return;
          connected = status === "connected";
          setStatus(
            status === "connected"
              ? "Conectado; comprobando guardado…"
              : "Guardado local; esperando conexión",
          );
          if (status === "connected" && durableDigest)
            void confirmDurability(durableDigest);
        },
        onSynced: ({ state }) => {
          if (state) provider?.sendStateless('{"type":"durability-check"}');
        },
        onUnsyncedChanges: ({ number }) => {
          if (number > 0 && !accessBlocked) setStatus("Guardando cambios…");
        },
        onStateless: ({ payload }) => {
          try {
            const event = JSON.parse(payload);
            if (
              event.type === "access-mode" &&
              typeof event.readOnly === "boolean"
            )
              setServerReadOnly(event.readOnly);
            if (event.type === "durable" && typeof event.digest === "string") {
              durableDigest = event.digest;
              void confirmDurability(durableDigest);
            }
          } catch {}
        },
        onAuthenticated: ({ scope }) => {
          accessBlocked = false;
          setAccessDenied(false);
          setServerReadOnly(scope === "readonly");
        },
        onClose: ({ event }) => {
          connected = false;
          if (event.reason !== "Access revoked" || disposed) return;
          accessBlocked = true;
          clearTimeout(confirmationTimer);
          setAccessDenied(true);
          setPeople([]);
          setStatus(
            "El acceso ha cambiado. Tu copia local se conserva; vuelve a abrir el documento para verificar los permisos.",
          );
        },
        onAuthenticationFailed: () => {
          connected = false;
          accessBlocked = true;
          setAccessDenied(true);
          setStatus(
            "No se pudo verificar el acceso. Tu copia local se conserva.",
          );
        },
        onAwarenessUpdate: ({ states }) =>
          setPeople([
            ...new Set(states.map((s: any) => s.user?.name).filter(Boolean)),
          ] as string[]),
      });
      provider.setAwarenessField("user", { name: user.name, color: "#4f46e5" });
      setBundle({ doc, provider, persistence: localPersistence });
    })().catch((error) => {
      if (!disposed)
        setCompatibilityError(
          error instanceof Error
            ? error.message
            : "No se pudo abrir la copia local. Los datos se conservan.",
        );
    });
    return () => {
      disposed = true;
      clearTimeout(confirmationTimer);
      provider?.destroy();
      void persistence?.destroy();
      doc.destroy();
    };
  }, [documentId, workspaceId, user.id]);
  if (compatibilityError)
    return (
      <div role="alert">
        <p>{compatibilityError}</p>
        <button
          type="button"
          className="schema-refresh"
          onClick={() => location.reload()}
        >
          Actualizar aplicación
        </button>
      </div>
    );
  if (unavailable)
    return (
      <p role="status">
        Este documento aún no se ha descargado en este dispositivo. Conéctate y
        utiliza «Descargar para sin conexión».
      </p>
    );
  if (!bundle) return <p role="status">Abriendo el documento guardado…</p>;
  return (
    <div>
      <div className="collaboration-status">
        <span role="status">
          {status.startsWith("Guardado en") ? (
            <Check size={14} />
          ) : (
            <WifiOff size={14} />
          )}{" "}
          {status}
        </span>
        <span>{people.length ? people.join(", ") : user.name}</span>
      </div>
      <CollaborativeContent
        key={documentId}
        bundle={bundle}
        editable={editable && !accessDenied && !serverReadOnly}
        onContent={onContent}
        restore={restore}
        workspaceId={workspaceId}
        documentId={documentId}
        userId={user.id}
      />
    </div>
  );
}
function CollaborativeContent({
  bundle,
  editable,
  onContent,
  restore,
  workspaceId,
  documentId,
  userId,
}: {
  bundle: Bundle;
  editable: boolean;
  onContent?: (content: DocumentNode) => void;
  restore?: { revision: string; content: DocumentNode };
  workspaceId: string;
  documentId: string;
  userId: string;
}) {
  const contentCallback = useRef(onContent);
  contentCallback.current = onContent;
  const [outline, setOutline] = useState<{ level: number; text: string }[]>([]),
    [restoreError, setRestoreError] = useState(""),
    [fileStatus, setFileStatus] = useState(""),
    [diagrams, setDiagrams] = useState<string[]>([]);
  /** Uploads dropped or pasted files: images go inline, other files become attachment links. */
  const insertFiles = async (target: TiptapEditor, files: File[], pos?: number) => {
    setFileStatus(files.length === 1 ? `Subiendo ${files[0].name}…` : `Subiendo ${files.length} archivos…`);
    try {
      let at = pos ?? target.state.selection.to;
      for (const file of files) {
        const attachment = await uploadAttachment(file, workspaceId, documentId, userId);
        const content = attachment.mime.startsWith("image/")
          ? { type: "image", attrs: { src: attachment.url, alt: file.name } }
          : {
              type: "paragraph",
              content: [
                {
                  type: "text",
                  text: `Adjunto: ${file.name}`,
                  marks: [{ type: "link", attrs: { href: `${attachment.url}?download=1` } }],
                },
              ],
            };
        target.chain().focus().insertContentAt(at, content).run();
        at = target.state.selection.to;
      }
      setFileStatus("");
    } catch (e) {
      setFileStatus((e as Error).message);
    }
  };
  const fileDrop = useRef(insertFiles);
  fileDrop.current = insertFiles;
  const editor = useEditor(
    {
      extensions: [
        ...documentExtensions(true),
        Collaboration.configure({ document: bundle.doc }),
        Placeholder.configure({
          placeholder: "Escribe una idea, una decisión o el siguiente paso…",
        }),
        FileHandler.configure({
          onDrop: (target, files, pos) => void fileDrop.current(target, files, pos),
          onPaste: (target, files) => void fileDrop.current(target, files),
        }),
      ],
      editable,
      shouldRerenderOnTransaction: false,
      onUpdate: ({ editor }) =>
        contentCallback.current?.(editor.getJSON() as DocumentNode),
    },
    [bundle],
  );
  useEffect(() => {
    editor?.setEditable(editable);
  }, [editable, editor]);
  useEffect(() => {
    if (!editor) return;
    const refresh = () => {
      const json = editor.getJSON() as DocumentNode;
      contentCallback.current?.(json);
      setOutline(documentHeadings(json));
      const sources: string[] = [];
      const visit = (node: DocumentNode) => {
        if (node.type === "codeBlock" && node.attrs?.language === "mermaid")
          sources.push((node.content || []).map((c) => c.text || "").join(""));
        for (const child of node.content || []) visit(child);
      };
      visit(json);
      setDiagrams(sources);
    };
    let timer: ReturnType<typeof setTimeout>;
    const update = () => {
      clearTimeout(timer);
      timer = setTimeout(refresh, 500);
    };
    editor.on("update", update);
    refresh();
    return () => {
      clearTimeout(timer);
      editor.off("update", update);
    };
  }, [editor]);
  useEffect(() => {
    if (editor && restore && editable) {
      try {
        assertDocumentContent(editor.schema, restore.content);
        editor.commands.setContent(restore.content);
        setRestoreError("");
      } catch {
        setRestoreError(
          "Esta revisión contiene bloques o atributos desconocidos. El documento actual y la revisión se conservan.",
        );
      }
    }
  }, [editor, restore?.revision]);
  if (!editor) return null;
  const actions = [
    {
      label: "Abrir enlace seleccionado",
      icon: Link2,
      run: () => {
        const href = editor.getAttributes("link").href;
        if (typeof href !== "string") return;
        if (requestResourceLink(href)) return;
        try {
          const url = new URL(href, location.origin);
          if (["https:", "http:", "mailto:"].includes(url.protocol))
            window.open(url.href, "_blank", "noopener,noreferrer");
        } catch {}
      },
    },
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
      label: "Añadir fila",
      icon: Plus,
      run: () => editor.chain().focus().addRowAfter().run(),
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
        const href = prompt("URL o enlace a un elemento del espacio");
        if (href)
          editor
            .chain()
            .focus()
            .extendMarkRange("link")
            .setLink({ href })
            .run();
      },
    },
    {
      label: "Fórmula matemática",
      icon: Sigma,
      run: () => {
        const latex = prompt("Fórmula en LaTeX");
        if (latex) editor.chain().focus().insertInlineMath({ latex }).run();
      },
    },
    {
      label: "Diagrama Mermaid",
      icon: GitBranch,
      run: () =>
        editor
          .chain()
          .focus()
          .insertContent({
            type: "codeBlock",
            attrs: { language: "mermaid" },
            content: [
              {
                type: "text",
                text: "flowchart LR\n  Idea --> Tarea --> Sprint",
              },
            ],
          })
          .run(),
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
  ];
  return (
    <div className="document-editor">
      {restoreError && <p role="alert">{restoreError}</p>}
      {editable && (
        <div
          className="editor-toolbar"
          role="toolbar"
          aria-label="Formato del documento"
        >
          <label className="upload-button">
            Imagen
            <input
              className="sr-only"
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              onChange={async (event) => {
                const input = event.currentTarget;
                const file = input.files?.[0];
                if (!file) return;
                try {
                  const attachment = await uploadAttachment(
                    file,
                    workspaceId,
                    documentId,
                    userId,
                  );
                  if (!attachment.mime.startsWith("image/"))
                    throw new Error(
                      "El archivo se ha guardado como adjunto, pero no es una imagen compatible.",
                    );
                  editor
                    .chain()
                    .focus()
                    .setImage({ src: attachment.url, alt: file.name })
                    .run();
                } catch (e) {
                  alert((e as Error).message);
                } finally {
                  input.value = "";
                }
              }}
            />
          </label>
          {actions.map((a) => (
            <button
              type="button"
              key={a.label}
              aria-label={a.label}
              title={a.label}
              onClick={a.run}
            >
              <a.icon size={16} />
            </button>
          ))}
        </div>
      )}
      {fileStatus && (
        <p className="editor-file-status" role="status">
          {fileStatus}
        </p>
      )}
      {editable && (
        <DragHandle editor={editor}>
          <span className="block-handle" title="Arrastra para mover este bloque">
            <GripVertical size={16} />
          </span>
        </DragHandle>
      )}
      <EditorContent editor={editor} />
      {outline.length > 0 && (
        <details className="document-outline">
          <summary>Índice del documento</summary>
          <ol>
            {outline.map((heading, i) => (
              <li key={i} style={{ marginLeft: (heading.level - 1) * 12 }}>
                <button
                  onClick={() =>
                    editor.view.dom
                      .querySelectorAll("h1,h2,h3,h4,h5,h6")
                      [i]?.scrollIntoView({ block: "center" })
                  }
                >
                  {heading.text}
                </button>
              </li>
            ))}
          </ol>
        </details>
      )}
      {diagrams.length > 0 && (
        <Suspense fallback={<p>Preparando diagramas…</p>}>
          {diagrams.map((source, i) => (
            <DiagramPreview source={source} key={i} />
          ))}
        </Suspense>
      )}
    </div>
  );
}
