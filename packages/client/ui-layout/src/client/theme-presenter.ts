/**
 * Global theme DOM applier: projects the resolved ThemeSnapshot onto the
 * document — `html { color-scheme }` for native UA chrome (scrollbars, form
 * controls), `body[data-ds-dark-theme]` for the token palette, the active
 * theme's alias-token overrides as inline CSS variables on body, the content
 * font-size axis (`--dsh-content-font-size`), and one presenter-owned
 * `meta[name="theme-color"]` for surrounding browser UI. Pure DOM writes, no
 * React involvement; the presenter only ever retracts what it wrote itself,
 * so foreign attributes, metadata, and inline styles survive.
 *
 * Phone type floor: where the primary pointer is coarse the axis is published
 * as `max(16px, <preference>px)`, so conversation type on a phone never sits
 * below 16px and the whole content ladder (which derives from this axis in
 * ui-theme) reflows at the larger size. This is the reflowing counterpart of
 * the browser's focus zoom, which magnifies without reflowing and crops the
 * page; the preference itself is untouched and still rules on desktop.
 */
import type { ThemeSnapshot } from '@deepseek-ai/dsh-client-ui-theme/client'

/** Body attribute selecting the dark base palette in the token stylesheets. */
export const DARK_ATTRIBUTE = 'data-ds-dark-theme'

/** Body variable carrying the user's content font size in px. */
export const CONTENT_FONT_SIZE_VARIABLE = '--dsh-content-font-size'

/** Smallest content font size published where the primary pointer is coarse. */
export const PHONE_CONTENT_FONT_FLOOR = 16

/** Media query selecting touch-first browsers for the phone type floor. */
export const COARSE_POINTER_QUERY = '(pointer: coarse)'

/** Applies theme snapshots to the document; one instance per plugin fiber. */
export class ThemePresenter {
  /** Token names this presenter wrote in the last apply (its retraction set). */
  private appliedTokens: string[] = []
  /** The single metadata node this presenter inserts and removes. */
  private readonly themeColorMeta: HTMLMetaElement
  /** Coarse-pointer query; absent where the document offers no `matchMedia`. */
  private readonly coarsePointer: MediaQueryList | undefined
  /** Last applied snapshot, re-applied when the pointer query flips. */
  private lastSnapshot: ThemeSnapshot | undefined
  private readonly onPointerChange = (): void => {
    if (this.lastSnapshot !== undefined) this.apply(this.lastSnapshot)
  }

  /** Create the presenter-owned metadata node before the first snapshot arrives. */
  constructor() {
    this.themeColorMeta = document.createElement('meta')
    this.themeColorMeta.name = 'theme-color'
    this.coarsePointer = typeof matchMedia === 'function' ? matchMedia(COARSE_POINTER_QUERY) : undefined
    this.coarsePointer?.addEventListener('change', this.onPointerChange)
  }

  /**
   * Project a snapshot onto the document: set root `color-scheme` and the body
   * palette attribute from `active.colorScheme` (never the id — `system` is
   * resolved upstream), publish the content font-size axis (floored on coarse
   * pointers), then replace the previously applied token variables with
   * `active.tokens`. Browser theme-color metadata follows the computed body
   * background after those writes, so the rendered palette remains the color
   * authority.
   * @param snapshot - resolved theme snapshot from ctx.theme.
   */
  apply(snapshot: ThemeSnapshot): void {
    this.lastSnapshot = snapshot
    const scheme = snapshot.active.colorScheme
    document.documentElement.style.colorScheme = scheme
    const body = document.body
    if (scheme === 'dark') body.setAttribute(DARK_ATTRIBUTE, '')
    else body.removeAttribute(DARK_ATTRIBUTE)
    const preference = `${String(snapshot.fontSize)}px`
    body.style.setProperty(
      CONTENT_FONT_SIZE_VARIABLE,
      this.coarsePointer?.matches === true ? `max(${String(PHONE_CONTENT_FONT_FLOOR)}px, ${preference})` : preference,
    )
    for (const name of this.appliedTokens) body.style.removeProperty(name)
    this.appliedTokens = []
    for (const [name, value] of Object.entries(snapshot.active.tokens)) {
      body.style.setProperty(name, value)
      this.appliedTokens.push(name)
    }
    this.themeColorMeta.content = getComputedStyle(body).backgroundColor
    if (!this.themeColorMeta.isConnected) document.head.append(this.themeColorMeta)
  }

  /**
   * Retract root color-scheme, the palette attribute, token variables, the
   * font-size axis, the pointer listener, and the owned metadata node.
   */
  dispose(): void {
    this.coarsePointer?.removeEventListener('change', this.onPointerChange)
    this.lastSnapshot = undefined
    document.documentElement.style.removeProperty('color-scheme')
    const body = document.body
    body.removeAttribute(DARK_ATTRIBUTE)
    body.style.removeProperty(CONTENT_FONT_SIZE_VARIABLE)
    for (const name of this.appliedTokens) body.style.removeProperty(name)
    this.appliedTokens = []
    this.themeColorMeta.remove()
  }
}
