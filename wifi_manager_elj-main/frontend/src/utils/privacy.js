export function maskIdentifier(value, hidden) {
  if (!value) return "—";
  if (!hidden) return value;
  return String(value).replace(/[A-Za-z0-9]/g, "*");
}