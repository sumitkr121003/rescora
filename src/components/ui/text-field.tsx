import type { InputHTMLAttributes } from "react";

type TextFieldProps = Omit<InputHTMLAttributes<HTMLInputElement>, "id"> & {
  id: string;
  label: string;
  hint?: string;
  error?: string;
};

export function TextField({ id, label, hint, error, className = "", ...props }: TextFieldProps) {
  const describedBy = [hint ? `${id}-hint` : null, error ? `${id}-error` : null]
    .filter(Boolean)
    .join(" ");

  return (
    <div className="field">
      <label className="field__label" htmlFor={id}>
        {label}
      </label>
      <input
        aria-describedby={describedBy || undefined}
        aria-invalid={error ? "true" : undefined}
        className={`field__input ${error ? "field__input--error" : ""} ${className}`.trim()}
        id={id}
        {...props}
      />
      {hint ? (
        <p className="field__hint" id={`${id}-hint`}>
          {hint}
        </p>
      ) : null}
      {error ? (
        <p className="field__error" id={`${id}-error`} role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
