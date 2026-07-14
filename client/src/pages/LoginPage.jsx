import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext.jsx'

export default function LoginPage() {
  const { signIn, configured } = useAuth()
  const navigate = useNavigate()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  if (!configured) {
    return (
      <main className="auth-page card">
        <h1>Sign in</h1>
        <p className="auth-lead">
          Auth is not configured in this environment. Set{' '}
          <code>VITE_SUPABASE_URL</code> and <code>VITE_SUPABASE_ANON_KEY</code>{' '}
          to enable sign-in.
        </p>
        <Link to="/" className="btn-primary auth-submit">
          Back home
        </Link>
      </main>
    )
  }

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      await signIn(email.trim(), password)
      navigate('/')
    } catch (err) {
      setError(err.message || 'Could not sign in.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <main className="auth-page card" aria-labelledby="login-heading">
      <h1 id="login-heading">Sign in</h1>
      <p className="auth-lead">
        Sign in to generate briefs and track your free uses.
      </p>
      <form onSubmit={handleSubmit} noValidate>
        <div className="field">
          <label htmlFor="login-email">Email</label>
          <input
            id="login-email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            disabled={loading}
          />
        </div>
        <div className="field">
          <label htmlFor="login-password">Password</label>
          <input
            id="login-password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            disabled={loading}
          />
        </div>
        {error && (
          <p className="message message-error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" className="btn-primary auth-submit" disabled={loading}>
          {loading ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
      <p className="auth-switch">
        No account?{' '}
        <Link to="/signup">Create one — 3 free briefs included</Link>
      </p>
    </main>
  )
}
