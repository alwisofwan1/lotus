"use client";

/**
 * The one on/off switch. Skin: `.ui-switch` in styles/ui-kit.css; nothing here sets a colour, so a
 * second copy with its own contrast bug cannot creep in (there were four before SettingSwitch).
 */
interface SwitchProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  /** Accessible name. Required: a switch always sits next to a label it must be tied to. */
  label: string;
  disabled?: boolean;
}

export function Switch({ checked, onChange, label, disabled }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-label={label}
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="ui-switch"
    >
      <span className="ui-switch-knob" />
    </button>
  );
}
