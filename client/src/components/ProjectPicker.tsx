import { useEffect, useRef, useState } from 'react'
import type { ProjectSummary } from '../types'

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

  const items = [{ value: '', label: 'all projects' }, ...projects.map((p) => ({ value: p.project, label: p.project }))]

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  useEffect(() => {
    if (!open) setActiveIndex(0)
  }, [open])

  const selected = items.find((i) => i.value === value) ?? items[0]

  const toggle = () => setOpen((v) => !v)

  const select = (next: string) => {
    onChange(next)
    setOpen(false)
  }

  const onTriggerKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') {
      e.preventDefault()
      if (!open) {
        setOpen(true)
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
        type="button"
        onClick={toggle}
        aria-label="Filter the board to one project"
        title="Scope the board, the live stream and auto-claim to one project"
        aria-haspopup="listbox"
        aria-expanded={open}
        onKeyDown={onTriggerKeyDown}
        className="flex min-w-0 max-w-[10rem] items-center gap-1 border border-line bg-surface px-2 py-1 font-mono text-[11px] text-ink focus:outline-none"
      >
        <span className="truncate">{selected.label}</span>
        <span aria-hidden="true">▾</span>
      </button>
      {open && (
        <div
          role="listbox"
          aria-label="Filter the board to one project"
          className="absolute right-0 top-[calc(100%+6px)] z-50 w-48 border-2 border-ink/70 bg-surface p-1 text-left"
        >
          {items.map((item, i) => (
            <div
              key={item.value}
              role="option"
              aria-selected={item.value === value}
              onMouseEnter={() => setActiveIndex(i)}
              onClick={() => select(item.value)}
              className={`cursor-pointer truncate px-2 py-1 font-mono text-[11px] ${
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
