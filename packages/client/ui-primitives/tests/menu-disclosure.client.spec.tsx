// @vitest-environment jsdom
import { useState } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Menu } from '../src/Menu.tsx'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

/**
 * Owner-controlled disclosure whose rows retain their ordinary menu navigation.
 * @param props - open state, selection callbacks, and optional portal anchor.
 * @returns the menu with additional rows while the disclosure is expanded.
 */
function DisclosureMenu({ open = true, onSelect, onClose, getAnchorRect }: {
  open?: boolean
  onSelect: (id: string) => void
  onClose: () => void
  getAnchorRect?: () => DOMRect | null
}) {
  const [expanded, setExpanded] = useState(false)
  return (
    <Menu
      open={open}
      autoFocus
      portal={getAnchorRect !== undefined}
      {...getAnchorRect === undefined ? {} : { getAnchorRect }}
      anchor={<button type="button">Choose mode</button>}
      items={[
        { id: 'main', label: 'Main mode' },
        { id: 'more', label: 'More modes', expanded },
        ...(expanded ? [
          { id: 'disabled', label: 'Unavailable mode', disabled: true },
          { id: 'extra', label: 'Additional mode' },
        ] : []),
      ]}
      footer={[{ id: 'manage', label: 'Manage modes' }]}
      onSelect={(id) => {
        if (id === 'more') setExpanded(value => !value)
        else onSelect(id)
      }}
      onClose={onClose}
    />
  )
}

describe('Menu inline disclosures', () => {
  it('keeps disclosure focus and navigates the visible rows through expansion and collapse', () => {
    const onSelect = vi.fn()
    const onClose = vi.fn()
    render(<DisclosureMenu onSelect={onSelect} onClose={onClose} />)
    const disclosure = screen.getByRole('menuitem', { name: 'More modes', expanded: false })
    expect(disclosure.hasAttribute('aria-haspopup')).toBe(false)
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Main mode' }))

    fireEvent.keyDown(document, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(disclosure)
    fireEvent.click(disclosure)
    expect(screen.getByRole('menuitem', { name: 'More modes', expanded: true })).toBe(disclosure)
    expect(document.activeElement).toBe(disclosure)
    expect(screen.getAllByRole('menu')).toHaveLength(1)
    expect(onClose).not.toHaveBeenCalled()
    expect(onSelect).not.toHaveBeenCalled()

    fireEvent.keyDown(document, { key: 'ArrowDown' })
    const additional = screen.getByRole('menuitem', { name: 'Additional mode' })
    expect(document.activeElement).toBe(additional)
    fireEvent.click(additional)
    expect(onSelect).toHaveBeenCalledWith('extra')
    fireEvent.keyDown(document, { key: 'ArrowUp' })
    expect(document.activeElement).toBe(disclosure)
    fireEvent.click(disclosure)
    expect(screen.queryByRole('menuitem', { name: 'Additional mode' })).toBeNull()
    expect(disclosure.getAttribute('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(disclosure)
    fireEvent.keyDown(document, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Manage modes' }))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledOnce()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Choose mode' }))
  })

  it('reclamps a growing portal and releases size and window listeners when it closes', () => {
    const observers: { element: Element | null; notify: () => void; disconnected: boolean }[] = []
    vi.stubGlobal('ResizeObserver', class {
      private readonly record

      constructor(callback: ResizeObserverCallback) {
        this.record = {
          element: null as Element | null,
          notify: () => { callback([], {} as ResizeObserver) },
          disconnected: false,
        }
        observers.push(this.record)
      }

      observe(element: Element) { this.record.element = element }
      disconnect() { this.record.disconnected = true }
    })
    vi.stubGlobal('innerHeight', 600)
    vi.stubGlobal('innerWidth', 800)
    const getAnchorRect = vi.fn(() => new DOMRect(40, 450, 100, 28))
    const props = { onSelect: vi.fn(), onClose: vi.fn(), getAnchorRect }
    const ui = render(<DisclosureMenu {...props} />)
    const menu = screen.getByRole('menu')
    const observer = observers[0]
    expect(observer?.element).toBe(menu)
    // jsdom has no layout; report the card heights produced by collapsed and expanded content.
    Object.defineProperties(menu, {
      offsetWidth: { get: () => 220 },
      offsetHeight: { get: () => menu.querySelector('[aria-expanded="true"]') === null ? 100 : 350 },
    })
    act(() => { observer?.notify() })
    expect(menu.style.top).toBe('482px')
    fireEvent.click(screen.getByRole('menuitem', { name: 'More modes' }))
    act(() => { observer?.notify() })
    expect(menu.style.top).toBe('238px')
    expect(Number.parseFloat(menu.style.top) + menu.offsetHeight).toBe(588)
    expect(observers).toHaveLength(1)
    fireEvent.click(screen.getByRole('menuitem', { name: 'More modes' }))
    act(() => { observer?.notify() })
    expect(menu.style.top).toBe('482px')

    ui.rerender(<DisclosureMenu {...props} open={false} />)
    expect(observer?.disconnected).toBe(true)
    getAnchorRect.mockClear()
    fireEvent.scroll(window)
    fireEvent.resize(window)
    expect(getAnchorRect).not.toHaveBeenCalled()

    ui.rerender(<DisclosureMenu {...props} />)
    expect(observers).toHaveLength(2)
    expect(observers[1]?.element).toBe(screen.getByRole('menu'))
    ui.unmount()
    expect(observers[1]?.disconnected).toBe(true)
    getAnchorRect.mockClear()
    fireEvent.scroll(window)
    fireEvent.resize(window)
    expect(getAnchorRect).not.toHaveBeenCalled()
  })
})
