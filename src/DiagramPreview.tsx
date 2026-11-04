import { useEffect, useId, useState } from "react";
export default function DiagramPreview({ source }: { source: string }) {
  const id = useId().replace(/[^a-z0-9]/gi, "");
  const [image, setImage] = useState(""),
    [error, setError] = useState("");
  useEffect(() => {
    let disposed = false;
    void import("mermaid")
      .then(async ({ default: mermaid }) => {
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme: "neutral",
          suppressErrorRendering: true,
          maxTextSize: 20000,
          maxEdges: 150,
        });
        return mermaid.render(`mermaid-${id}`, source);
      })
      .then(({ svg }) => {
        if (!disposed) {
          setImage(
            `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`,
          );
          setError("");
        }
      })
      .catch(() => {
        if (!disposed)
          setError(
            "El diagrama tiene un error de sintaxis. Revisa el bloque Mermaid.",
          );
      });
    return () => {
      disposed = true;
    };
  }, [source, id]);
  return (
    <figure className="diagram-preview">
      {error ? (
        <p role="status">{error}</p>
      ) : image ? (
        <img src={image} alt="Diagrama generado a partir del bloque Mermaid" />
      ) : (
        <p>Preparando diagrama…</p>
      )}
      <figcaption>Diagrama Mermaid</figcaption>
    </figure>
  );
}
