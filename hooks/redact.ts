// Masks what should never sit in the pane's state: emails and common token shapes.

const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g
const TOKENS = /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[abpr]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})\b/g

export function redact(text: string): string {
  return text.replace(EMAIL, '[email]').replace(TOKENS, '[secret]')
}

export function clip(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + '…' : text
}
