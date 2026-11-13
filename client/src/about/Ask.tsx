import { useEffect, useState } from 'react'
import { ASK_SCOPE_NOTE, ASK_UNCONFIGURED_NOTE } from '../lib/aboutContent'
import {
  askQuestion,
  getAskConfig,
  readStoredAskPass,
  writeStoredAskPass,
  AskError,
} from '../lib/ask'
import { Kicker } from './primitives'

/**
 * C1 (v3.12.5) — Ask-the-Board: the hero console (AskCard) and the
 * chapter-11 dual-provider figure (AskArchitectureFigure), extracted verbatim
 * from components/About.tsx. The form state and error mapping are unchanged.
 */

type AskConfig = Awaited<ReturnType<typeof getAskConfig>>
type AskState =
  | { phase: 'loading' }
  | { phase: 'off' }
  | { phase: 'ready'; model?: string }

// Kept short on purpose: as full sentences these wrapped the chip row onto
// three lines and pushed the Ask button below the fold.
const SUGGESTED_QUESTIONS = [
  { chip: 'Why claims expire', ask: 'Why do claims expire?' },
  { chip: 'The two 409s', ask: 'What are the two different 409 responses?' },
  { chip: 'The reaper', ask: 'What does the lease reaper do?' },
]

function messageForAskError(err: unknown): string {
  if (err instanceof AskError) {
    if (err.status === 401) return 'Wrong password.'
    if (err.status === 429) return 'Too many attempts — please wait a moment.'
    if (err.status === 502 || err.status === 503) return 'The assistant is temporarily unavailable.'
    if (err.code === 'invalid_question') return 'Ask a question between 3 and 500 characters.'
    return `Something went wrong (${err.status}).`
  }
  return 'The assistant is temporarily unavailable.'
}

export function AskArchitectureFigure() {
  const [mode, setMode] = useState<'both' | 'openrouter' | 'ollama'>('both')

  return (
    <div className="border border-line bg-surface">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line bg-muted-bg/30 px-4 py-2.5">
        <span className="font-mono text-xs uppercase tracking-wider text-muted">
          Figure 02 · Ask the Board: Dual-Provider Architecture (OpenRouter + Local Ollama)
        </span>
        <div className="flex items-center gap-1 font-mono text-[11px]">
          <button
            type="button"
            onClick={() => setMode('both')}
            className={`px-2.5 py-1 border transition-colors cursor-pointer ${
              mode === 'both'
                ? 'border-line bg-surface text-ink font-semibold'
                : 'border-transparent text-muted hover:text-ink'
            }`}
          >
            Both Providers
          </button>
          <button
            type="button"
            onClick={() => setMode('openrouter')}
            className={`px-2.5 py-1 border transition-colors cursor-pointer ${
              mode === 'openrouter'
                ? 'border-line bg-surface text-ink font-semibold'
                : 'border-transparent text-muted hover:text-ink'
            }`}
          >
            OpenRouter (Cloud)
          </button>
          <button
            type="button"
            onClick={() => setMode('ollama')}
            className={`px-2.5 py-1 border transition-colors cursor-pointer ${
              mode === 'ollama'
                ? 'border-line bg-surface text-ink font-semibold'
                : 'border-transparent text-muted hover:text-ink'
            }`}
          >
            Ollama (Tunnel)
          </button>
        </div>
      </div>

      <div className="p-4 sm:p-5 grid grid-cols-1 lg:grid-cols-[230px_1fr_280px] gap-4 items-stretch">
        {/* Zone 1: Cloud Source */}
        <div className="border border-line/60 bg-muted-bg/20 p-3.5 flex flex-col gap-3">
          <div className="font-mono text-[10.5px] uppercase tracking-wider text-muted flex items-center gap-1.5">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z" />
            </svg>
            Cloud Source (Railway)
          </div>
          <div className="border border-line bg-surface p-2.5">
            <div className="flex items-center justify-between mb-1">
              <span className="font-semibold text-xs text-ink">Railway App</span>
              <span className="font-mono text-[9px] px-1.5 py-0.5 border border-line text-muted">Docker</span>
            </div>
            <p className="text-[11.5px] text-muted leading-relaxed">
              Production deployment of <code className="font-mono text-ink">agent-kanban-board</code>. Houses the in-memory board store.
            </p>
          </div>

          <div className="border border-line bg-surface p-2.5">
            <div className="flex items-center justify-between mb-1">
              <span className="font-semibold text-xs text-ink">Provider Dispatcher</span>
              <span className="font-mono text-[9px] px-1.5 py-0.5 bg-muted-bg text-muted">routes/ask.js</span>
            </div>
            <p className="text-[11px] text-muted leading-relaxed">
              Evaluates <code className="font-mono text-ink">KANBAN_ASK_PROVIDER</code>: dispatches to OpenRouter cloud or local Ollama tunnel.
            </p>
          </div>

          <div className="border border-line bg-surface p-2.5">
            <div className="flex items-center justify-between mb-1">
              <span className="font-semibold text-xs text-ink">Context Assembly</span>
              <span className="font-mono text-[9px] px-1.5 py-0.5 bg-muted-bg text-muted">askKnowledge.js</span>
            </div>
            <div className="font-mono text-[10px] leading-relaxed text-muted">
              <div>+ live snapshot · every project</div>
              <div>+ named card: record &amp; log tail</div>
              <div>+ milestones · archive · backup · audit</div>
              <div>+ ranked source excerpts</div>
              <div className="text-muted/80">indexed: server · client · scripts</div>
            </div>
            <p className="mt-1.5 text-[10.5px] leading-snug text-muted">
              Credential-shaped values become <code className="font-mono text-ink">[redacted]</code> before egress.
            </p>
          </div>

          <div className="mt-auto border border-line bg-surface p-2.5 font-mono text-[10.5px] leading-relaxed">
            <div className="text-[9px] uppercase tracking-wider text-muted mb-1 font-semibold">Incoming Request</div>
            <div className="text-ink">POST /api/ask</div>
            <div className="text-muted">x-ask-pass: &lt;secret&gt;</div>
            <div className="text-live font-semibold truncate">{'{ question }'}</div>
            <div className="text-muted text-[9.5px] mt-1">context is assembled server-side</div>
          </div>
        </div>

        {/* Zone 2: Routing Lanes */}
        <div className="flex flex-col justify-center gap-3">
          {/* OpenRouter Route */}
          {(mode === 'both' || mode === 'openrouter') && (
            <div className="border-l-4 border-l-sky-500 border border-line bg-surface p-3.5">
              <div className="flex items-center justify-between mb-1.5">
                <div className="flex items-center gap-2 font-semibold text-xs text-ink">
                  <span className="text-sky-500 font-bold">☁</span>
                  OpenRouter Cloud Route (Managed API)
                </div>
                <span className="font-mono text-[10px] font-semibold px-2 py-0.5 bg-sky-500/10 text-sky-500 border border-sky-500/30">
                  openrouter.ai
                </span>
              </div>
              <p className="text-[11.5px] text-muted mb-2">
                Direct outbound HTTPS egress with <code className="font-mono text-xs">Bearer $OPENROUTER_API_KEY</code>. No local Mac or tunnel needed.
              </p>
              <svg className="w-full h-7 block my-1" viewBox="0 0 340 28" aria-hidden="true">
                <line x1="8" y1="14" x2="332" y2="14" stroke="#38bdf8" strokeWidth="2.5" strokeDasharray="6 4" opacity="0.6" />
                <circle cx="12" cy="14" r="4.5" fill="#38bdf8">
                  <animate attributeName="cx" values="12;328" dur="2.2s" repeatCount="indefinite" />
                </circle>
              </svg>
              <div className="flex flex-wrap justify-between gap-1 font-mono text-[10px] text-muted">
                <span>Direct Cloud Egress</span>
                <span>Global Multi-Provider Routing</span>
                <span>Pay-per-Token</span>
              </div>
            </div>
          )}

          {/* Ollama Route */}
          {(mode === 'both' || mode === 'ollama') && (
            <div className="border-l-4 border-l-pass border border-line bg-surface p-3.5">
              <div className="flex items-center justify-between mb-1.5">
                <div className="flex items-center gap-2 font-semibold text-xs text-ink">
                  <span className="text-pass font-bold">✔</span>
                  Local Ollama Route (Cloudflare Tunnel)
                </div>
                <span className="font-mono text-[10px] font-semibold px-2 py-0.5 bg-pass-bg text-pass border border-pass/30">
                  HTTP 200 OK
                </span>
              </div>
              <p className="text-[11.5px] text-muted mb-2">
                Proxied DNS (<b className="text-amber-500">Orange Cloud</b>) Anycast Edge → Outbound QUIC/TLS 1.3 Tunnel to Mac
              </p>
              <svg className="w-full h-7 block my-1" viewBox="0 0 340 28" aria-hidden="true">
                <line x1="8" y1="14" x2="332" y2="14" stroke="var(--color-pass)" strokeWidth="2.5" strokeDasharray="6 4" opacity="0.6" />
                <circle cx="12" cy="14" r="4.5" fill="var(--color-pass)">
                  <animate attributeName="cx" values="12;328" dur="2.4s" repeatCount="indefinite" />
                </circle>
              </svg>
              <div className="flex flex-wrap justify-between gap-1 font-mono text-[10px] text-muted">
                <span>Anycast Edge DNS</span>
                <span>Zero Open Inbound Ports</span>
                <span>Unmetered Reasoning</span>
              </div>
            </div>
          )}

          {/* Retired Tailscale Funnel Route (shown only in Ollama mode as historical contrast) */}
          {mode === 'ollama' && (
            <div className="border-l-4 border-l-fail border border-line bg-surface p-3.5 opacity-85">
              <div className="flex items-center justify-between mb-1.5">
                <div className="flex items-center gap-2 font-semibold text-xs text-ink">
                  <span className="text-fail font-bold">✖</span>
                  Old Tailscale Funnel Route (Retired)
                </div>
                <span className="font-mono text-[10px] font-semibold px-2 py-0.5 bg-fail-bg text-fail border border-fail/30">
                  502 ECONNRESET
                </span>
              </div>
              <p className="text-[11.5px] text-muted mb-2">
                Public Funnel Relay (<b className="text-fail">DERP Server</b>) terminates TLS → dropped handshake in transit
              </p>
              <svg className="w-full h-7 block my-1" viewBox="0 0 340 28" aria-hidden="true">
                <line x1="8" y1="14" x2="190" y2="14" stroke="var(--color-fail)" strokeWidth="2.5" strokeDasharray="4 4" opacity="0.7" />
                <line x1="192" y1="9" x2="204" y2="19" stroke="var(--color-fail)" strokeWidth="2.5" />
                <line x1="204" y1="9" x2="192" y2="19" stroke="var(--color-fail)" strokeWidth="2.5" />
                <line x1="210" y1="14" x2="332" y2="14" stroke="var(--color-muted)" strokeWidth="1" strokeDasharray="2 4" opacity="0.3" />
                <circle cx="12" cy="14" r="4.5" fill="var(--color-fail)">
                  <animate attributeName="cx" values="12;198" dur="1.8s" repeatCount="indefinite" />
                  <animate attributeName="opacity" values="1;1;0" dur="1.8s" repeatCount="indefinite" />
                </circle>
              </svg>
              <div className="flex flex-wrap justify-between gap-1 font-mono text-[10px] text-muted">
                <span>MagicDNS</span>
                <span className="text-fail">DERP Handshake Reset</span>
                <span>Connection Severed</span>
              </div>
            </div>
          )}
        </div>

        {/* Zone 3: Inference Engines */}
        <div className="border border-line/60 bg-muted-bg/20 p-3.5 flex flex-col gap-2.5">
          <div className="font-mono text-[10.5px] uppercase tracking-wider text-muted flex items-center gap-1.5">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="2" y="3" width="20" height="14" rx="2" />
              <line x1="8" y1="21" x2="16" y2="21" />
              <line x1="12" y1="17" x2="12" y2="21" />
            </svg>
            Inference Providers &amp; Environments
          </div>

          {(mode === 'both' || mode === 'openrouter') && (
            <div className="border-l-2 border-l-sky-500 border border-line bg-surface p-2.5">
              <div className="flex items-center justify-between mb-0.5">
                <span className="font-semibold text-xs text-ink">OpenRouter Cloud</span>
                <span className="font-mono text-[9px] px-1.5 py-0.5 border border-line text-sky-500 font-semibold">Hosted API</span>
              </div>
              <p className="text-[11px] text-muted mb-1">
                Serves <code className="font-mono text-ink">openai/gpt-oss-20b</code>, Claude, Llama 3, and DeepSeek.
              </p>
              <span className="font-mono text-[9.5px] text-muted">Managed scaling · max_tokens cap · 24k prompt budget</span>
            </div>
          )}

          {(mode === 'both' || mode === 'ollama') && (
            <>
              <div className="border-l-2 border-l-pass border border-line bg-surface p-2.5">
                <div className="flex items-center justify-between mb-0.5">
                  <span className="font-semibold text-xs text-ink">cloudflared + Gateway</span>
                  <span className="font-mono text-[9px] px-1.5 py-0.5 text-sky-500 font-semibold">:11435</span>
                </div>
                <p className="text-[11px] text-muted">Daemon with launchd KeepAlive. Verifies Bearer token; drops probes with 401.</p>
              </div>
              <div className="border-l-2 border-l-pass border border-line bg-surface p-2.5">
                <div className="flex items-center justify-between mb-0.5">
                  <span className="font-semibold text-xs text-ink">Local Ollama Engine</span>
                  <span className="font-mono text-[9px] px-1.5 py-0.5 text-pass font-semibold">:11434</span>
                </div>
                <p className="text-[11px] text-muted mb-1">
                  Executes local reasoning models (e.g. <code className="font-mono text-ink">qwen3.6:latest</code>).
                </p>
                <span className="font-mono text-[9.5px] text-pass font-semibold">Zero token fee · no max_tokens · no prompt budget</span>
              </div>
            </>
          )}
        </div>
      </div>

      <div className="border-t border-line bg-muted-bg/10 px-4 py-2 font-mono text-xs text-muted flex flex-col sm:flex-row gap-1 sm:items-center sm:justify-between">
        <span>
          {mode === 'both' && 'Ask-the-Board supports both: direct cloud inference via OpenRouter API or self-hosted local models via Cloudflare Tunnel.'}
          {mode === 'openrouter' && 'OpenRouter: Direct cloud-to-cloud HTTPS with Bearer API key. Zero local infrastructure or open ports required.'}
          {mode === 'ollama' && 'Local Ollama: Apple Silicon inference via Cloudflare Tunnel to gateway :11435 and ollama :11434 with unmetered thought chains and no prompt-token budget.'}
        </span>
        <span className="text-[11px] text-muted">Dual-Provider Architecture</span>
      </div>
    </div>
  )
}

export function AskCard() {
  const [state, setState] = useState<AskState>({ phase: 'loading' })
  const [password, setPassword] = useState(() => readStoredAskPass())
  const [question, setQuestion] = useState('')
  const [answer, setAnswer] = useState<string | null>(null)
  const [answerModel, setAnswerModel] = useState<string | undefined>(undefined)
  const [fallback, setFallback] = useState(false)
  const [asking, setAsking] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    getAskConfig(readStoredAskPass() || undefined)
      .then((cfg: AskConfig) => {
        if (cancelled) return
        setState(cfg.enabled ? { phase: 'ready', model: cfg.model } : { phase: 'off' })
      })
      .catch(() => {
        if (!cancelled) setState({ phase: 'off' })
      })
    return () => {
      cancelled = true
    }
  }, [])

  const onPasswordChange = (value: string) => {
    setPassword(value)
    writeStoredAskPass(value)
  }

  const submit = async () => {
    const q = question.trim()
    if (!q || asking) return
    setAsking(true)
    setError(null)
    setAnswer(null)
    setFallback(false)
    try {
      const res = await askQuestion(q, password)
      setAnswer(res.answer)
      setAnswerModel(res.model)
      // The password was accepted: the header can now show the model.
      if (res.model) setState((prev) => (prev.phase === 'ready' ? { phase: 'ready', model: res.model } : prev))
      setFallback(res.fallback === true)
    } catch (err) {
      setError(messageForAskError(err))
    } finally {
      setAsking(false)
    }
  }

  if (state.phase === 'loading') {
    return (
      <div className="border border-line bg-surface p-4 font-mono text-[13px] text-muted">
        Checking availability…
      </div>
    )
  }

  // Off is the self-hosted default (both secrets unset), so it stays a quiet
  // note rather than a large empty console at the very top of the page.
  if (state.phase === 'off') {
    return (
      <div className="border border-line bg-surface p-4">
        <Kicker>Ask the board · not configured here</Kicker>
        <p className="mt-2 text-[15px] leading-relaxed text-muted">{ASK_UNCONFIGURED_NOTE}</p>
      </div>
    )
  }

  const trimmed = question.trim()
  const questionTooShort = trimmed.length > 0 && trimmed.length < 3

  return (
    <div className="border border-line bg-surface">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line bg-muted-bg/30 px-4 py-2.5">
        <div className="flex items-center gap-2">
          <span className="inline-block h-2.5 w-2.5 bg-live" aria-hidden="true" />
          <Kicker>Ask the board</Kicker>
        </div>
        {state.model && (
          <span className="font-mono text-[13px] text-muted">{state.model}</span>
        )}
      </div>

      <div className="p-4 sm:p-5">
        {/* The question leads: it is what the reader came for. The password is
            a gate on the endpoint, so it sits under the button as a condition
            of sending, not as the first thing asked for. */}
        <label className="block">
          <span className="sr-only">Your question about this board</span>
          <textarea
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') submit()
            }}
            rows={3}
            maxLength={500}
            className="w-full resize-y border border-line bg-bg px-3.5 py-3 text-base leading-relaxed text-ink outline-none focus:border-live"
            placeholder="Ask anything about how this board works — why claims expire, what the reaper does, how a 409 happens…"
          />
        </label>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className="font-mono text-[13px] uppercase tracking-wider text-muted">Try</span>
          {SUGGESTED_QUESTIONS.map((sq) => (
            <button
              key={sq.chip}
              type="button"
              onClick={() => setQuestion(sq.ask)}
              className="border border-line bg-muted-bg/50 px-2.5 py-1 font-mono text-[13px] text-muted transition-colors hover:border-ink hover:text-ink pointer-coarse:min-h-11"
            >
              {sq.chip}
            </button>
          ))}
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={submit}
            disabled={asking || !trimmed || questionTooShort}
            className="inline-flex items-center border border-ink bg-ink px-5 py-2.5 font-mono text-[13px] font-medium uppercase tracking-wider text-bg transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60 pointer-coarse:min-h-11"
          >
            {asking ? 'Asking…' : 'Ask →'}
          </button>
          <label className="flex min-w-[13rem] flex-1 items-center gap-2 border border-line bg-bg px-3 py-2">
            <span className="sr-only">Shared access password</span>
            <input
              type="password"
              value={password}
              onChange={(e) => onPasswordChange(e.target.value)}
              autoComplete="off"
              className="min-w-0 flex-1 bg-transparent font-mono text-[15px] text-ink outline-none"
              placeholder="access password"
            />
          </label>
          <span className="font-mono text-[13px] tabular-nums text-muted">{trimmed.length}/500</span>
        </div>

        {error && (
          <p className="mt-3.5 border-l-2 border-warn pl-3.5 text-[15px] text-warn">{error}</p>
        )}

        {answer && (
          <div className="mt-5 border-t border-line pt-4">
            <div className="flex flex-wrap items-center gap-2">
              <Kicker>Answer</Kicker>
              {answerModel && (
                <span className="font-mono text-[13px] text-muted">via {answerModel}</span>
              )}
              {fallback && (
                <span className="border border-warn px-2 py-0.5 font-mono text-[12px] uppercase tracking-wider text-warn">
                  live figures unavailable
                </span>
              )}
            </div>
            <div
              className="mt-2.5 overflow-auto overscroll-contain pr-2 border border-line/40 bg-bg/50 p-3.5"
              style={{ maxHeight: '24rem' }}
            >
              <p className="whitespace-pre-wrap text-[16.5px] leading-relaxed text-ink">{answer}</p>
            </div>
          </div>
        )}

        <p className="mt-4 border-t border-line/60 pt-3 text-[15.5px] leading-relaxed text-muted">
          {ASK_SCOPE_NOTE}{' '}
          <a href="#ask" className="text-live underline underline-offset-2">
            How it works →
          </a>
        </p>
      </div>
    </div>
  )
}
