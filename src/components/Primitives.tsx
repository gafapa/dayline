import {
  cloneElement,
  isValidElement,
  useId,
  useEffect,
  useRef,
  type ReactNode,
  type ReactElement,
} from "react";
import { X } from "lucide-react";
export function Field({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <label className="field" htmlFor={id}>
      <span id={`${id}-label`}>{label}</span>
      {isValidElement(children)
        ? cloneElement(children as ReactElement<any>, {
            id,
            "aria-labelledby": `${id}-label`,
          })
        : children}
    </label>
  );
}
export function Modal({
  title,
  children,
  close,
  className = "",
  panel = false,
}: {
  title: string;
  children: ReactNode;
  close: () => void;
  className?: string;
  /** Docked side panel: non-modal, keeps the view behind it usable. */
  panel?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const previous = document.activeElement as HTMLElement;
    if (panel) {
      ref.current?.show();
      ref.current?.focus();
    } else ref.current?.showModal();
    return () => previous?.focus();
  }, []);
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      aria-modal={panel ? false : undefined}
      tabIndex={panel ? -1 : undefined}
      className={`modal ${panel ? "panel" : ""} ${className}`}
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
      onKeyDown={(e) => {
        // Non-modal dialogs don't get the browser's Escape handling.
        if (panel && e.key === "Escape" && !e.defaultPrevented) {
          e.preventDefault();
          close();
        }
      }}
      onClick={(e) => {
        if (!panel && e.target === e.currentTarget) close();
      }}
    >
      <header className="modal-header">
        <h2 id={titleId}>{title}</h2>
        <button
          type="button"
          className="icon-button"
          aria-label="Cerrar"
          onClick={close}
        >
          <X size={19} />
        </button>
      </header>
      {children}
    </dialog>
  );
}
