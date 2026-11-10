/** The browser tab shows the conversation name when there is one; otherwise the app name. */
export const APP_TITLE = 'Matrius';

export function conversationDocumentTitle(title: string | null | undefined): string {
  const value = title?.trim();
  return value ? value : APP_TITLE;
}
