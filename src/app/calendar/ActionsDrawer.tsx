"use client";

import { type MouseEvent, type ReactNode, useId, useRef } from "react";

// Only a hit on the dialog element itself can be the backdrop, and only outside the panel's rect;
// empty panel space also targets the dialog.
function onBackdrop(e: MouseEvent<HTMLDialogElement>) {
  if (e.target !== e.currentTarget) return false;
  const r = e.currentTarget.getBoundingClientRect();
  return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
}

interface Props {
  readonly name: string;
  readonly date: string;
  readonly children: ReactNode;
}

export function ActionsDrawer({ name, date, children }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  // A text-selection drag that starts inside and ends on the backdrop must not close the drawer.
  const pressedOnBackdrop = useRef(false);

  return (
    <>
      <button
        type="button"
        aria-label={`Actions for ${name}`}
        onClick={() => dialog.current?.showModal()}
      >
        Actions
      </button>
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: Esc already closes a modal dialog natively; the click is only the backdrop shortcut */}
      <dialog
        ref={dialog}
        className="drawer"
        aria-labelledby={titleId}
        onMouseDown={(e) => {
          pressedOnBackdrop.current = onBackdrop(e);
        }}
        onClick={(e) => {
          if (onBackdrop(e) && pressedOnBackdrop.current) e.currentTarget.close();
        }}
      >
        <div className="drawer-body">
          <header>
            <h2 id={titleId} className="drawer-title">
              Actions for {name}
            </h2>
            <button type="button" onClick={() => dialog.current?.close()}>
              Close
            </button>
          </header>
          <p>{date}</p>
          {children}
        </div>
      </dialog>
    </>
  );
}
