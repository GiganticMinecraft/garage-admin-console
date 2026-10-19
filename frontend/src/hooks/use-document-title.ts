import { useEffect } from 'react'

const APP_TITLE = 'Garage Admin Console'

/**
 * Sets the browser tab title to 「<title> | Garage Admin Console」 while the
 * page is shown, and restores the default on unmount so routes without the
 * hook (e.g. not found) do not keep the previous page's title.
 */
export function useDocumentTitle(title: string) {
  useEffect(() => {
    document.title = title ? `${title} | ${APP_TITLE}` : APP_TITLE
    return () => {
      document.title = APP_TITLE
    }
  }, [title])
}
