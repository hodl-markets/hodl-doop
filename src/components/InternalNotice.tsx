import { useT } from '@/lib/i18n'

/** The strip along the bottom of every screen that says this is HODL's
 *  internal system. Its height is `--app-inset-bottom` (src/styles.css): the
 *  root and every fixed full-screen view (canvas, automation editor, prototype
 *  player, sheets, toasts) leave that much free, so it never covers the app.
 *  Phones get the short wording. */
export function InternalNotice() {
  const t = useT()
  return (
    <footer
      data-slot="internal-notice"
      className="fixed inset-x-0 bottom-0 z-[900] flex h-[var(--app-inset-bottom)] justify-center border-t border-line bg-paper px-4 pb-[env(safe-area-inset-bottom,0px)] text-ink-soft"
    >
      <p className="min-w-0 truncate text-caption/6">
        <span className="md:hidden">{t('ui.internalNoticeShort')}</span>
        <span className="hidden md:inline">{t('ui.internalNotice')}</span>
      </p>
    </footer>
  )
}
