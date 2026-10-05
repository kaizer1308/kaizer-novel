import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { Check, Play, Plus, Sparkles, TriangleAlert, Undo2 } from 'lucide-react'
import { api, effortName, fmt, pickEffort, storage, type Model, type Settings } from '../api'

const GENRES = ['Fantasy', 'Isekai', 'Cultivation', 'LitRPG', 'Romance fantasy', 'Sci-fi', 'Urban fantasy', 'Mystery', 'Horror', 'Slice of life']
const TROPES = [
  'Transported to another world', 'Reincarnation', 'Regression', 'System and status screens', 'Weak to strong', 'Overpowered protagonist',
  'Hidden identity', 'Villainess', 'Academy', 'Dungeon diving', 'Tower climbing', 'Kingdom building', 'Revenge', 'Found family',
  'Slow-burn romance', 'Enemies to lovers', 'Apocalypse', 'Monster evolution', 'Contract marriage', 'Second chance',
]
const LANGUAGES = ['English', 'Japanese', 'Korean', 'Chinese', 'Spanish', 'Portuguese', 'Indonesian', 'Vietnamese', 'French', 'German']


const initial: Settings = {
  title: '', premise: '', genre: 'Fantasy', tropes: [], pov: 'First person', tense: 'Past', tone: '', language: 'English',
  rating: 'Teen', chapters: 30, words: 2500, style: '', model: '', reasoning: 'low', fast: false,
}

function Section({ title, hint, children }: { title: string; hint: string; children: ReactNode }) {
  return (
    <section className="form-section">
      <div className="form-section-head">
        <h2>{title}</h2>
        <p>{hint}</p>
      </div>
      <div className="form-section-body">{children}</div>
    </section>
  )
}

function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" className={`chip${on ? ' on' : ''}`} aria-pressed={on} onClick={onClick}>
      {on && <Check size={13} strokeWidth={2.25} />}
      {children}
    </button>
  )
}

export function NewBook({ onCreated }: { onCreated: () => void }) {
  const [s, setS] = useState<Settings>(initial)
  const [models, setModels] = useState<Model[] | null>(null)
  const [modelError, setModelError] = useState<string | null>(null)
  const [customTrope, setCustomTrope] = useState('')
  const [customGenre, setCustomGenre] = useState<string | null>(null) // null = "Other" closed
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [enhancing, setEnhancing] = useState(false)
  const [enhanceError, setEnhanceError] = useState<string | null>(null)
  const [original, setOriginal] = useState<Partial<Settings> | null>(null) // what the last AI rewrite replaced
  const [enhanceModel, setEnhanceModel] = useState(() => storage.get('kaizer.enhanceModel', ''))
  const [enhanceEffort, setEnhanceEffort] = useState(() => storage.get('kaizer.enhanceEffort', ''))
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setS(p => ({ ...p, [k]: v }))

  useEffect(() => {
    api.get<Model[]>('/api/models').then(
      m => {
        setModels(m)
        if (m[0]) setS(p => (p.model ? p : { ...p, model: m[0].slug, reasoning: pickEffort(m[0]) }))
      },
      e => setModelError(e.message),
    )
  }, [])

  const toggleTrope = (t: string) => set('tropes', s.tropes.includes(t) ? s.tropes.filter(x => x !== t) : [...s.tropes, t])
  const addTrope = () => {
    const t = customTrope.trim()
    if (t && !s.tropes.includes(t)) set('tropes', [...s.tropes, t])
    setCustomTrope('')
  }

  // Genres travel as one comma-joined string, so the server and prompts stay unchanged.
  const genres = s.genre.split(',').map(g => g.trim()).filter(Boolean)
  const setGenres = (gs: string[]) => set('genre', gs.join(', '))
  const toggleGenre = (g: string) => setGenres(genres.includes(g) ? genres.filter(x => x !== g) : [...genres, g])
  const addGenre = () => {
    const g = customGenre?.trim().replace(/,/g, '')
    if (g && !genres.includes(g)) setGenres([...genres, g])
    setCustomGenre('')
  }

  const model = models?.find(m => m.slug === s.model)
  // Keep the chosen reasoning and Fast mode when the new model supports them.
  const pickModel = (slug: string) => {
    const m = models?.find(x => x.slug === slug)
    if (!m) return
    setS(p => ({ ...p, model: slug, reasoning: m.efforts.includes(p.reasoning ?? '') ? p.reasoning : pickEffort(m), fast: !!m.fast && p.fast }))
  }

  const totalWords = s.chapters * s.words
  const volumes = totalWords / 50_000

  const submit = async (e?: FormEvent) => {
    e?.preventDefault()
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const { id } = await api.post<{ id: number }>('/api/books', s)
      onCreated()
      location.hash = `#/book/${id}`
    } catch (err) {
      setError((err as Error).message)
      setBusy(false)
    }
  }

  // Enhance with AI can use a different model and reasoning from the book; until picked, each follows the book's.
  const enhancer = models?.find(m => m.slug === enhanceModel) ?? model
  const enhancerEffort = !enhancer ? '' : [enhanceEffort, s.reasoning ?? ''].find(e => enhancer.efforts.includes(e)) ?? pickEffort(enhancer)

  // The textarea is read-only while this runs, so the rewrite never lands on top of newer typing.
  const enhance = async () => {
    if (!enhancer) return
    setEnhancing(true)
    setEnhanceError(null)
    try {
      const next = await api.post<Partial<Settings>>('/api/enhance', {
        ...s,
        model: enhancer.slug,
        reasoning: enhancerEffort,
        fast: !!enhancer.fast && s.fast,
        options: { genres: GENRES, tropes: TROPES },
      })
      setOriginal(Object.fromEntries(Object.keys(next).map(k => [k, s[k as keyof Settings]])))
      setS(p => ({ ...p, ...next }))
    } catch (err) {
      setEnhanceError((err as Error).message)
    } finally {
      setEnhancing(false)
    }
  }

  const canStart = !!s.premise.trim() && !!s.model && !busy && !enhancing

  return (
    <form className="page page-form" onSubmit={submit} onKeyDown={e => e.key === 'Enter' && (e.ctrlKey || e.metaKey) && canStart && submit()}>
      <header className="page-head">
        <h1>New book</h1>
      </header>

      <Section title="Story" hint="The premise is the only required field. Say as much or as little as you like: a hook, a protagonist, a world, an ending.">
        <div className="field">
          <label className="field">
            <span className="label">Premise</span>
            <textarea
              className="input textarea"
              rows={7}
              required
              readOnly={enhancing}
              aria-busy={enhancing}
              value={s.premise}
              onChange={e => set('premise', e.target.value)}
              placeholder="A disgraced alchemist wakes up three years in the past, the night before the academy entrance exam that ruined her life. This time she knows which instructor is a demon..."
            />
          </label>
          <div className="enhance-row">
            <button
              type="button"
              className="btn btn-sm"
              title="Writes a full premise from your notes and picks the genre, tropes, voice, and length to match"
              onClick={enhance}
              disabled={!s.premise.trim() || !enhancer || enhancing}
            >
              <Sparkles size={14} strokeWidth={1.75} /> {enhancing ? 'Enhancing…' : 'Enhance with AI'}
            </button>
            {models && (
              <select
                className="input"
                aria-label="Model for Enhance with AI"
                title="Model used for Enhance with AI"
                value={enhancer?.slug ?? ''}
                disabled={enhancing}
                onChange={e => (setEnhanceModel(e.target.value), storage.set('kaizer.enhanceModel', e.target.value))}
              >
                {models.map(m => (
                  <option key={m.slug} value={m.slug}>
                    {m.name}
                  </option>
                ))}
              </select>
            )}
            {!!enhancer?.efforts.length && (
              <select
                className="input"
                aria-label="Reasoning for Enhance with AI"
                title="Reasoning used for Enhance with AI"
                value={enhancerEffort}
                disabled={enhancing}
                onChange={e => (setEnhanceEffort(e.target.value), storage.set('kaizer.enhanceEffort', e.target.value))}
              >
                {enhancer.efforts.map(e => (
                  <option key={e} value={e}>
                    Reasoning: {effortName(e, enhancer)}
                  </option>
                ))}
              </select>
            )}
            {original !== null && !enhancing && (
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => (setS(p => ({ ...p, ...original })), setOriginal(null))}>
                <Undo2 size={14} strokeWidth={1.75} /> Restore original
              </button>
            )}
          </div>
          {original !== null && !enhancing && <p className="estimate">Genre, tropes, voice, and length below were set to match. Change anything you like.</p>}
          {enhanceError && (
            <span className="form-error" role="alert">
              {enhanceError}
            </span>
          )}
        </div>
        <label className="field">
          <span className="label">
            Title <span className="label-note">optional, Kaizer names it otherwise</span>
          </span>
          <input className="input" value={s.title} onChange={e => set('title', e.target.value)} placeholder="Untitled" />
        </label>
      </Section>

      <Section title="Genre and tropes" hint="Tropes steer the outline and the reader promises each arc pays off.">
        <div className="field">
          <span className="label">
            Genre <span className="label-note num">{genres.length > 1 ? `${genres.length} selected` : 'pick one or more'}</span>
          </span>
          <div className="chips">
            {[...GENRES, ...genres.filter(g => !GENRES.includes(g))].map(g => (
              <Chip key={g} on={genres.includes(g)} onClick={() => toggleGenre(g)}>
                {g}
              </Chip>
            ))}
            <Chip on={customGenre !== null} onClick={() => setCustomGenre(customGenre === null ? '' : null)}>
              Other
            </Chip>
          </div>
          {customGenre !== null && (
            <div className="inline-add">
              <input
                className="input"
                autoFocus
                value={customGenre}
                onChange={e => setCustomGenre(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && !e.ctrlKey && !e.metaKey && (e.preventDefault(), addGenre())}
                placeholder="e.g. Gaslamp mystery"
                aria-label="Custom genre"
              />
              <button type="button" className="btn" onClick={addGenre} disabled={!customGenre.trim()}>
                <Plus size={15} strokeWidth={2} /> Add
              </button>
            </div>
          )}
        </div>
        <div className="field">
          <span className="label">
            Tropes <span className="label-note num">{s.tropes.length ? `${s.tropes.length} selected` : 'optional'}</span>
          </span>
          <div className="chips">
            {[...TROPES, ...s.tropes.filter(t => !TROPES.includes(t))].map(t => (
              <Chip key={t} on={s.tropes.includes(t)} onClick={() => toggleTrope(t)}>
                {t}
              </Chip>
            ))}
          </div>
          <div className="inline-add">
            <input
              className="input"
              value={customTrope}
              onChange={e => setCustomTrope(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && !e.ctrlKey && !e.metaKey && (e.preventDefault(), addTrope())}
              placeholder="Add your own trope"
              aria-label="Custom trope"
            />
            <button type="button" className="btn" onClick={addTrope} disabled={!customTrope.trim()}>
              <Plus size={15} strokeWidth={2} /> Add
            </button>
          </div>
        </div>
      </Section>

      <Section title="Voice" hint="How the story is told. Kaizer writes every chapter in this voice and language.">
        <div className="grid-2">
          <label className="field">
            <span className="label">Point of view</span>
            <select className="input" value={s.pov} onChange={e => set('pov', e.target.value)}>
              {['First person', 'Third person limited', 'Third person omniscient'].map(o => <option key={o}>{o}</option>)}
            </select>
          </label>
          <label className="field">
            <span className="label">Tense</span>
            <select className="input" value={s.tense} onChange={e => set('tense', e.target.value)}>
              <option>Past</option>
              <option>Present</option>
            </select>
          </label>
          <label className="field">
            <span className="label">Language</span>
            <input className="input" list="languages" value={s.language} onChange={e => set('language', e.target.value)} />
            <datalist id="languages">{LANGUAGES.map(l => <option key={l} value={l} />)}</datalist>
          </label>
          <label className="field">
            <span className="label">Content rating</span>
            <select className="input" value={s.rating} onChange={e => set('rating', e.target.value)}>
              {['All ages', 'Teen', 'Mature'].map(o => <option key={o}>{o}</option>)}
            </select>
          </label>
        </div>
        <label className="field">
          <span className="label">
            Tone <span className="label-note">optional</span>
          </span>
          <input className="input" value={s.tone} onChange={e => set('tone', e.target.value)} placeholder="Fun and fast, with real stakes and a sharp sense of humor" />
        </label>
        <label className="field">
          <span className="label">
            Style sample <span className="label-note">optional, a passage whose voice Kaizer should match</span>
          </span>
          <textarea className="input textarea" rows={4} value={s.style} onChange={e => set('style', e.target.value)} placeholder="Paste a few paragraphs of prose you like." />
        </label>
      </Section>

      <Section title="Length" hint="Light novel volumes run about 50,000 words. Long books take many hours and may pause for ChatGPT usage limits; Kaizer resumes on its own.">
        <div className="grid-2">
          <label className="field">
            <span className="label">Chapters</span>
            <input className="input num" type="number" min={1} max={1000} value={s.chapters} onChange={e => set('chapters', Number(e.target.value))} />
          </label>
          <label className="field">
            <span className="label">Words per chapter</span>
            <input className="input num" type="number" min={500} max={8000} step={100} value={s.words} onChange={e => set('words', Number(e.target.value))} />
          </label>
        </div>
        <p className="estimate num">
          About {fmt.num(totalWords)} words · {volumes < 1 ? 'less than one volume' : `${volumes.toFixed(volumes < 10 ? 1 : 0)} volumes`}
        </p>
      </Section>

      <Section title="Model" hint="Models available on your ChatGPT plan. Lower reasoning writes faster; you can change it while the book runs.">
        {modelError ? (
          <div className="notice notice-error" role="alert">
            <TriangleAlert size={16} strokeWidth={1.75} />
            <div>
              <strong>Couldn't load models.</strong> {modelError}
            </div>
          </div>
        ) : (
          <>
            <div className="grid-2">
              <label className="field">
                <span className="label">Model</span>
                <select className="input" value={s.model} disabled={!models} onChange={e => pickModel(e.target.value)}>
                  {!models && <option>Loading models…</option>}
                  {models?.map(m => (
                    <option key={m.slug} value={m.slug}>
                      {m.name}
                    </option>
                  ))}
                </select>
              </label>
              {!!model?.efforts.length && (
                <label className="field">
                  <span className="label">Reasoning</span>
                  <select className="input" value={s.reasoning} onChange={e => set('reasoning', e.target.value)}>
                    {model.efforts.map(e => (
                      <option key={e} value={e}>
                        {effortName(e, model)}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </div>
            {model?.fast && (
              <div className="chips">
                <Chip on={!!s.fast} onClick={() => set('fast', !s.fast)}>
                  Fast mode: {model.fast}
                </Chip>
              </div>
            )}
          </>
        )}
      </Section>

      <footer className="form-foot">
        {error && (
          <span className="form-error" role="alert">
            {error}
          </span>
        )}
        <span className="form-foot-meta num">
          {s.chapters} chapters · {fmt.num(totalWords)} words
        </span>
        <button className="btn btn-primary btn-lg" type="submit" disabled={!canStart}>
          <Play size={16} strokeWidth={2} /> {busy ? 'Starting…' : 'Start autopilot'}
        </button>
      </footer>
    </form>
  )
}
