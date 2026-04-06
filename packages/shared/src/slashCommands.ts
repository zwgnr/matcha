export function isLeadingSlashCommandInput(value: string | null | undefined): boolean {
  if (typeof value !== "string") {
    return false;
  }

  return /^\/\S/.test(value.trimStart());
}
