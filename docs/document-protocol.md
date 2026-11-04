# Document format

Documents are TipTap/ProseMirror JSON. While several people are editing, they are synchronised with Yjs. There is one stored format, version 1 (`shared/document-protocol.ts`).

- The server validates every document's content against the editor schema before storing it (`shared/document-content.ts`), so malformed or unknown blocks are rejected.
- Workspace archives record the format version. The database records it too and refuses to start on a format it doesn't know.
- Documents created offline start from a deterministic Yjs seed (`shared/document-seed.ts`), so the same document created on two devices doesn't duplicate its first content.

There is deliberately no per-request format negotiation. When a second format exists, add an explicit migration at database start and bump the version. See [architecture.md](architecture.md).
