import { ArrowRight, TriangleAlert } from 'lucide-react'
import { Logo } from '../ui'

const STEPS = [
  ['Describe the story', 'A premise, a genre, the tropes you love, and how long it should run.'],
  ['Kaizer plans it', 'A story bible, a cast with distinct voices, and an arc-by-arc outline.'],
  ['Chapters keep coming', 'Each chapter is written, checked against canon, and remembered before the next one starts.'],
] as const

export function SignIn({ error }: { error: string | null }) {
  return (
    <div className="signin">
      <div className="signin-col">
        <div className="brand brand-lg">
          <Logo size={28} /> Kaizer
        </div>
        <h1 className="signin-title">Full-length light novels, written on autopilot.</h1>
        <p className="signin-lede">
          Start a book, close the tab, and come back to finished chapters. Kaizer keeps a running memory of every character, fact, and open plot thread so chapter 200 still agrees with chapter 1.
        </p>

        {error && (
          <div className="notice notice-error" role="alert">
            <TriangleAlert size={16} strokeWidth={1.75} />
            <div>
              <strong>Sign-in didn't finish.</strong> {error} Sign in again and approve Kaizer, or check that your ChatGPT plan supports Sign in with ChatGPT.
            </div>
          </div>
        )}

        <a className="btn btn-primary btn-lg" href="/auth/login">
          Sign in with ChatGPT <ArrowRight size={16} strokeWidth={2} />
        </a>
        <p className="signin-fine">
          Writing runs on your ChatGPT plan through OpenAI's Sign in with ChatGPT. Books and story memory stay on this computer.
        </p>
        <p className="signin-fine">
          ChatGPT says this account can't access the app? <a href="/auth/login?fresh=1">Sign in with a different account</a>
        </p>

        <ol className="steps">
          {STEPS.map(([title, body], i) => (
            <li key={title}>
              <span className="steps-n num">{i + 1}</span>
              <div>
                <div className="steps-title">{title}</div>
                <div className="steps-body">{body}</div>
              </div>
            </li>
          ))}
        </ol>
      </div>
    </div>
  )
}
