import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext.jsx'

export default function SignUpPage() {
  const { signUp, configured } = useAuth()
  const navigate = useNavigate()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [info, setInfo] = useState('')
  const [loading, setLoading] = useState(false)

  if (!configured) {
    return (
      <main className="auth-page card">
        <h1>Create account</h1>
        <p className="auth-lead">
          Auth is not configured in this environment.
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
    setInfo('')
    if (password.length < 8) {
      setError('Password must be at least 8 characters.')
      return
    }
    setLoading(true)
    try {
      const data = await signUp(email.trim(), password)
      if (data.session) {
        navigate('/')
      } else {
        setInfo(
          'Check your email to confirm your account, then sign in.',
        )
      }
    } catch (err) {
      setError(err.message || 'Could not create account.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <main className="auth-page card" aria-labelledby="signup-heading">
      <h1 id="signup-heading">Create account</h1>
      <p className="auth-lead">
        Get started with interview briefs. No credit card required.
      </p>
      <form onSubmit={handleSubmit} noValidate>
        <div className="field">
          <label htmlFor="signup-email">Email</label>
          <input
            id="signup-email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            disabled={loading}
          />
        </div>
        <div className="field">
          <label htmlFor="signup-password">Password</label>
          <input
            id="signup-password"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={8}
            disabled={loading}
          />
          <p className="field-hint">At least 8 characters.</p>
        </div>
        {error && (
          <p className="message message-error" role="alert">
            {error}
          </p>
        )}
        {info && (
          <p className="message message-info" role="status">
            {info}
          </p>
        )}
        <button type="submit" className="btn-primary auth-submit" disabled={loading}>
          {loading ? 'Creating account…' : 'Create account'}
        </button>
      </form>
      <p className="auth-switch">
        Already have an account? <Link to="/login">Sign in</Link>
      </p>
    </main>
  )
}
