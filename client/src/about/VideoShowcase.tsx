import { useEffect, useRef, useState } from 'react'
import { VIDEO_WALKTHROUGH } from '../lib/aboutContent'

/**
 * C1 (v3.12.5) — the video walkthrough plate, extracted verbatim from
 * components/About.tsx (same seek buttons, same chapter list, same events).
 */

// ---------------------------------------------------------------------------
// Video Walkthrough Showcase
// ---------------------------------------------------------------------------

export function VideoShowcase() {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [isPlaying, setIsPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)

  const seekTo = (seconds: number) => {
    const v = videoRef.current
    if (!v) return
    v.currentTime = seconds
    v.play().catch(() => {})
    setIsPlaying(true)
  }

  const togglePlay = () => {
    const v = videoRef.current
    if (!v) return
    if (v.paused) {
      v.play().catch(() => {})
      setIsPlaying(true)
    } else {
      v.pause()
      setIsPlaying(false)
    }
  }

  useEffect(() => {
    const v = videoRef.current
    if (!v) return
    const onPlay = () => setIsPlaying(true)
    const onPause = () => setIsPlaying(false)
    const onTimeUpdate = () => setCurrentTime(v.currentTime)

    v.addEventListener('play', onPlay)
    v.addEventListener('pause', onPause)
    v.addEventListener('timeupdate', onTimeUpdate)

    return () => {
      v.removeEventListener('play', onPlay)
      v.removeEventListener('pause', onPause)
      v.removeEventListener('timeupdate', onTimeUpdate)
    }
  }, [])

  const activeChapterIndex = VIDEO_WALKTHROUGH.chapters.reduce(
    (acc, ch, idx) => (currentTime >= ch.time ? idx : acc),
    0
  )

  return (
    <section id="walkthrough" aria-label="Video Walkthrough" className="mt-7 border border-line bg-surface p-4 sm:p-6">
      <div className="flex flex-col md:flex-row md:items-baseline md:justify-between gap-3 border-b border-line pb-4">
        <div>
          <div className="inline-flex items-center gap-2 font-mono text-[11px] font-semibold uppercase tracking-[0.15em] text-live">
            <span className="inline-block h-2 w-2 bg-live"></span>
            {VIDEO_WALKTHROUGH.badge}
          </div>
          <h2 className="mt-1.5 text-[clamp(1.4rem,2.4vw,2rem)] font-bold tracking-[-0.02em] text-ink">
            {VIDEO_WALKTHROUGH.title}
          </h2>
          <p className="mt-0.5 font-mono text-xs uppercase tracking-wider text-muted">
            {VIDEO_WALKTHROUGH.subtitle}
          </p>
        </div>
        <p className="max-w-md text-[14px] leading-relaxed text-muted md:text-right">
          {VIDEO_WALKTHROUGH.description}
        </p>
      </div>

      <div className="relative mt-4 aspect-video w-full overflow-hidden border border-line bg-black">
        <video
          ref={videoRef}
          src={VIDEO_WALKTHROUGH.src}
          poster={VIDEO_WALKTHROUGH.poster}
          controls
          playsInline
          preload="metadata"
          className="h-full w-full object-contain"
        />
        {!isPlaying && (
          <button
            type="button"
            onClick={togglePlay}
            aria-label="Play video walkthrough"
            className="group absolute inset-0 flex items-center justify-center bg-black/30 hover:bg-black/20 transition-colors cursor-pointer"
          >
            <div className="flex h-16 w-16 items-center justify-center border border-white/40 bg-black/75 text-white backdrop-blur-md transition-transform group-hover:scale-105">
              <span className="ml-1 text-2xl font-mono leading-none">▶</span>
            </div>
          </button>
        )}
      </div>

      {/* Chapter navigation chips */}
      <div className="mt-4 border-t border-line/60 pt-3.5">
        <div className="font-mono text-[11px] font-semibold uppercase tracking-[0.12em] text-muted">
          Jump to section ({VIDEO_WALKTHROUGH.duration}):
        </div>
        <div className="mt-2 flex flex-wrap gap-1.5 sm:gap-2">
          {VIDEO_WALKTHROUGH.chapters.map((ch, idx) => {
            const isActive = isPlaying && activeChapterIndex === idx
            return (
              <button
                key={ch.label}
                type="button"
                onClick={() => seekTo(ch.time)}
                className={`inline-flex items-center gap-1.5 border px-2.5 py-1 font-mono text-[11px] uppercase tracking-wider transition-all cursor-pointer ${
                  isActive
                    ? 'border-live bg-live-bg text-ink font-semibold'
                    : 'border-line bg-surface text-muted hover:border-ink hover:text-ink'
                }`}
              >
                <span className={isActive ? 'text-live font-semibold' : 'opacity-60'}>
                  {ch.timestamp}
                </span>
                <span>{ch.label}</span>
              </button>
            )
          })}
        </div>
      </div>
    </section>
  )
}
