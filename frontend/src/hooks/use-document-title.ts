import { useEffect } from 'react'

const APP_TITLE = 'Garage Admin Console'

/** Sets the browser tab title to 「<title> | Garage Admin Console」 while the page is shown. */
export function useDocumentTitle(title: string) {
  useEffect(() => {
    document.title = title ? `${title} | ${APP_TITLE}` : APP_TITLE
  }, [title])
}
