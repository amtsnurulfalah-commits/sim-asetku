"use client";
import { useId } from "react";
export type FieldDef = {
  key: string;
  label: string;
  type?: "number" | "date" | "textarea" | "checkbox" | "select";
  required?: boolean;
  options?: { value: string; label: string }[];
  hint?: string;
  disabled?: boolean;
  step?: string;
  maxLength?: number;
};
export function Field({
  def,
  value,
  onChange,
  disabled = false,
}: {
  def: FieldDef;
  value: unknown;
  onChange: (v: unknown) => void;
  disabled?: boolean;
}) {
  const id = useId(),
    common = {
      id,
      disabled: disabled || def.disabled,
      required: def.required,
      className: "field mt-2",
    };
  return (
    <div className={def.type === "textarea" ? "sm:col-span-2" : ""}>
      <label htmlFor={id} className="block text-sm font-medium text-slate-700">
        {def.label}
        {def.required ? " *" : ""}
      </label>
      {def.type === "select" ? (
        <select
          {...common}
          value={String(value ?? "")}
          onChange={(e) => onChange(e.target.value || null)}
        >
          <option value="">Pilih…</option>
          {def.options?.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      ) : def.type === "checkbox" ? (
        <input
          id={id}
          type="checkbox"
          checked={!!value}
          disabled={common.disabled}
          onChange={(e) => onChange(e.target.checked)}
          className="mt-3 size-4"
        />
      ) : def.type === "textarea" ? (
        <textarea
          {...common}
          value={String(value ?? "")}
          maxLength={def.maxLength ?? 6000}
          rows={3}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : (
        <input
          {...common}
          type={def.type ?? "text"}
          step={def.step ?? (def.type === "number" ? "1" : undefined)}
          value={String(value ?? "")}
          maxLength={def.maxLength ?? 180}
          onChange={(e) =>
            onChange(
              def.type === "number"
                ? e.target.value === ""
                  ? null
                  : Number(e.target.value)
                : def.type === "date"
                  ? e.target.value || null
                  : e.target.value,
            )
          }
        />
      )}
      {def.hint && <p className="mt-1 text-xs text-slate-500">{def.hint}</p>}
    </div>
  );
}
