import { useEffect } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../context/AuthContext.jsx'

export default function CheckoutSuccessPage() {
  const { refreshAccount, accessToken } = useAuth()

  useEffect(() => {
    if (accessToken) {
      void refreshAccount(accessToken)
    }
  }, [accessToken, refreshAccount])

  return (
    <main className="auth-page card" aria-labelledby="checkout-success-heading">
      <h1 id="checkout-success-heading">You&apos;re upgraded</h1>
      <p className="auth-lead">
        Payment received. Your account should reflect your new plan within a
        few seconds.
      </p>
      <Link to="/#create-brief" className="btn-primary auth-submit">
        Generate a brief →
      </Link>
      <p className="auth-switch">
        <Link to="/pricing">View pricing</Link>
      </p>
    </main>
  )
}
