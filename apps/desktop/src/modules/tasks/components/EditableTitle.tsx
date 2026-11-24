"use client";

/**
 * A title, edited in place like `bb`'s: Enter or leaving the field saves, Escape puts it back, an
 * empty title is a slip and reverts. Keyed on the saved title by its caller, so a save or a reload
 * re-seeds it.
 *
 * Shared by a vault ticket's page and a Lotus task's. `onCommit` may return `false` to refuse — a
 * title past the store's cap, say — and the field then goes back to what was saved.
 */
export function EditableTitle({
  title,
  label,
  onCommit,
}: {
  title: string;
  label: string;
  onCommit: (title: string) => boolean | void;
}) {
  return (
    <h2
      className="tk-detail-title tk-detail-title--editable"
      contentEditable
      suppressContentEditableWarning
      spellCheck
      role="textbox"
      aria-label={label}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          event.currentTarget.blur();
        }
        if (event.key === "Escape") {
          event.preventDefault();
          event.currentTarget.textContent = title;
          event.currentTarget.blur();
        }
      }}
      onBlur={(event) => {
        const next = (event.currentTarget.textContent ?? "").replace(/\s+/g, " ").trim();
        if (!next) {
          event.currentTarget.textContent = title;
          return;
        }
        if (next !== title && onCommit(next) === false) event.currentTarget.textContent = title;
      }}
      onPaste={(event) => {
        // One line of plain text: a pasted paragraph with formatting is not a title.
        event.preventDefault();
        const text = event.clipboardData.getData("text/plain").replace(/\s+/g, " ");
        document.execCommand("insertText", false, text);
      }}
    >
      {title}
    </h2>
  );
}
