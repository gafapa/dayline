import StarterKit from "@tiptap/starter-kit";
import { TableKit } from "@tiptap/extension-table";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import Image from "@tiptap/extension-image";
import Mathematics from "@tiptap/extension-mathematics";

export function documentExtensions(collaborative = false) {
  return [
    StarterKit.configure({
      undoRedo: collaborative ? false : undefined,
      link: { openOnClick: false },
    }),
    TableKit.configure({ table: { resizable: true } }),
    TaskList,
    TaskItem.configure({ nested: true }),
    Image.configure({ allowBase64: false }),
    Mathematics,
  ];
}
