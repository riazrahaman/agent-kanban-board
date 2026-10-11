import { useEffect, useRef, useState } from 'react'
import type { ProjectSummary } from '../types'
import { menuMaxHeight, useMenuPlacement } from '../lib/useMenuPlacement'

// Preferred menu widths: `w-48` (the original desktop size) on fine pointers;
// wider on touch so 14px names like "investment-advisor" fit untruncated.
const MENU_WIDTHS = { fine: 192, coarse: 256 }

type Props = {
  value: string
  projects: ProjectSummary[]
  onChange: (next: string) => void
}

/**
 * A self-contained custom dropdown that replaces the native <select> for the
 * project scope. The native control was unusable in Safari, and it appended a
 * "ghost" <option> for an unknown persisted scope so the control masqueraded as
 * valid. This listbox renders exactly the known projects (plus "all projects")
 * and never invents an option for an id that does not exist on the board.
 */
export default function ProjectPicker({ value, projects, onChange }: Props) {
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const items = [{ value: '', label: 'all projects' }, ...projects.map((p) => ({ value: p.project, label: p.project }))]

  useEffect(() => {
    if (!open) return
    // pointerdown, not mousedown: iOS Safari does not fire compatibility
    // mouse events for a tap on a non-clickable area, so a mousedown-only
    // listener left the menu open after an outside tap on a phone.
    const onDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  // v3.2.4: the menu is `position: fixed` and placed from the trigger's
  // measured rect, clamped inside the viewport (lib/menuPlacement.ts). The
  // old absolutely-positioned `right-0 w-48` menu was right-aligned to a
  // trigger that sits at the LEFT of the wrapped phone disclosure row,
  // pushing ~7rem of the menu off-screen to the left. Measured in a layout effect so the first paint is
  // already in place; re-measured on resize / visual-viewport changes
  // (placeMenu, via lib/useMenuPlacement.ts).
  const placement = useMenuPlacement(open, triggerRef, MENU_WIDTHS)

  // Keep the selected project visible when the list scrolls internally.
  useEffect(() => {
    if (!open || !placement) return
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' })
  }, [open, placement])


  const selected = items.find((i) => i.value === value) ?? items[0]

  // Opening starts the keyboard highlight on the selected project, so only
  // one row reads as highlighted (it used to reset to "all projects").
  const openMenu = () => {
    setActiveIndex(Math.max(0, items.findIndex((i) => i.value === value)))
    setOpen(true)
  }
  const toggle = () => (open ? setOpen(false) : openMenu())

  const select = (next: string) => {
    onChange(next)
    setOpen(false)
  }

  const onTriggerKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') {
      e.preventDefault()
      if (!open) {
        openMenu()
        return
      }
    }
    if (e.key === 'ArrowDown') {
      setActiveIndex((i) => (i + 1) % items.length)
    } else if (e.key === 'ArrowUp') {
      setActiveIndex((i) => (i - 1 + items.length) % items.length)
    } else if (e.key === 'Enter' && open) {
      e.preventDefault()
      select(items[activeIndex].value)
    } else if (e.key === 'Escape') {
      setOpen(false)
    }
  }

  return (
    <div className="relative" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        onClick={toggle}
        aria-label="Filter the board to one project"
        title="Scope the board, the live stream and auto-claim to one project"
        aria-haspopup="listbox"
        aria-expanded={open}
        onKeyDown={onTriggerKeyDown}
        className="flex min-w-0 max-w-[8.5rem] sm:max-w-[10rem] items-center gap-1 border border-line bg-surface px-2 py-1 font-mono text-[11px] text-ink focus:outline-none pointer-coarse:min-h-11"
      >
        <span className="truncate">{selected.label}</span>
        <span aria-hidden="true">▾</span>
      </button>
      {open && (
        <div
          ref={listRef}
          role="listbox"
          aria-label="Filter the board to one project"
          data-testid="project-picker-menu"
          // Fixed + measured (see the layout effect above); max-height keeps
          // it above the bottom safe area / floating toolbar with internal
          // scroll for long project lists.
          className="fixed z-50 overflow-y-auto overscroll-contain border-2 border-ink/70 bg-surface p-1 text-left"
          style={{
            top: placement?.top ?? 0,
            left: placement?.left ?? 0,
            width: placement?.width,
            maxHeight: menuMaxHeight(placement?.top ?? 0),
            visibility: placement ? 'visible' : 'hidden',
          }}
        >
          {items.map((item, i) => (
            <div
              key={item.value}
              role="option"
              aria-selected={item.value === value}
              title={item.label}
              onMouseEnter={() => setActiveIndex(i)}
              onClick={() => select(item.value)}
              className={`cursor-pointer truncate px-2 py-1 font-mono text-[11px] pointer-coarse:min-h-11 pointer-coarse:leading-9 pointer-coarse:text-sm ${
                item.value === value ? 'bg-muted-bg text-ink' : 'text-ink'
              } ${i === activeIndex ? 'bg-muted-bg' : ''}`}
            >
              {item.label}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
