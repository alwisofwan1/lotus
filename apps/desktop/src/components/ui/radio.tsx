"use client";

/** The one round single-choice control. Skin: `.ui-radio` in styles/ui-kit.css (the dot springs in). */
interface RadioProps {
  checked: boolean;
  onChange: () => void;
  /** Accessible name. Required: a radio sits next to a label it must be tied to. */
  label: string;
  disabled?: boolean;
  /** Why it is disabled, shown on hover. */
  title?: string;
}

export function Radio({ checked, onChange, label, disabled, title }: RadioProps) {
  return (
    <button
      type="button"
      role="radio"
      aria-label={label}
      aria-checked={checked}
      disabled={disabled}
      title={title}
      onClick={(e) => {
        e.stopPropagation();
        onChange();
      }}
      className="ui-radio"
    />
  );
}
