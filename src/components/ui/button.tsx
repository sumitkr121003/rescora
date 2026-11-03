import type { ButtonHTMLAttributes, ReactNode } from "react";

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & { children: ReactNode };

export function Button({ children, className = "", type = "button", ...props }: ButtonProps) {
  return (
    <button className={`ui-button ${className}`.trim()} type={type} {...props}>
      {children}
    </button>
  );
}
