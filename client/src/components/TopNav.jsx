import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom'
import { PREPBRIEF_LOGO_SRC } from '../brand.js'
import { useAuth } from '../context/AuthContext.jsx'

function marketingLinkClass({ isActive }) {
  return isActive
    ? 'top-nav-link top-nav-link--muted top-nav-link--active'
    : 'top-nav-link top-nav-link--muted'
}

function brandClass({ isActive }) {
  return isActive ? 'top-nav-brand top-nav-brand--active' : 'top-nav-brand'
}

export function TopNav({
  savedBriefsCount,
  resumePanelOpen,
  savedBriefsPanelOpen,
  onToggleResumePanel,
  onOpenResumePanel,
  onToggleSavedBriefsPanel,
  onOpenSavedBriefsPanel,
}) {
  const navigate = useNavigate()
  const location = useLocation()
  const onHome = location.pathname === '/'
  const { user, account, signOut, loading: authLoading } = useAuth()

  const handleResumeClick = () => {
    if (onHome) {
      onToggleResumePanel()
    } else {
      onOpenResumePanel()
      navigate('/')
    }
  }

  const handleSavedBriefsClick = () => {
    if (onHome) {
      onToggleSavedBriefsPanel()
    } else {
      onOpenSavedBriefsPanel()
      navigate('/')
    }
  }

  return (
    <header className="top-nav">
      <div className="top-nav-inner">
        <NavLink to="/" end className={brandClass}>
          <img
            src={PREPBRIEF_LOGO_SRC}
            alt=""
            className="top-nav-logo"
            decoding="async"
          />
          <span className="top-nav-brand-text">PrepBrief</span>
        </NavLink>
        <nav className="top-nav-app" aria-label="Main navigation">
          <button
            type="button"
            className={
              resumePanelOpen
                ? 'top-nav-app-link top-nav-app-link--active'
                : 'top-nav-app-link'
            }
            aria-expanded={resumePanelOpen}
            onClick={handleResumeClick}
          >
            My resume
          </button>
          <button
            type="button"
            className={
              savedBriefsPanelOpen
                ? 'top-nav-app-link top-nav-app-link--active'
                : 'top-nav-app-link'
            }
            aria-expanded={savedBriefsPanelOpen}
            onClick={handleSavedBriefsClick}
          >
            Saved briefs
            {savedBriefsCount > 0 && (
              <span className="top-nav-count">{savedBriefsCount}</span>
            )}
          </button>
        </nav>
        <nav className="top-nav-links" aria-label="Product information">
          <NavLink to="/how-it-works" className={marketingLinkClass}>
            How it works
          </NavLink>
          <NavLink to="/about" className={marketingLinkClass}>
            About
          </NavLink>
          <NavLink to="/pricing" className={marketingLinkClass}>
            Pricing
          </NavLink>
          {!authLoading && (
            user ? (
              <>
                {account?.configured && account.limit != null && (
                  <span className="top-nav-usage" title="Briefs remaining">
                    {account.remaining ?? 0} left
                  </span>
                )}
                <span className="top-nav-user" title={user.email}>
                  {user.email?.split('@')[0] || 'Account'}
                </span>
                <button
                  type="button"
                  className="top-nav-link top-nav-link--muted top-nav-signout"
                  onClick={() => void signOut()}
                >
                  Sign out
                </button>
              </>
            ) : (
              <>
                <NavLink to="/login" className={marketingLinkClass}>
                  Sign in
                </NavLink>
                <Link to="/signup" className="top-nav-cta">
                  Sign up
                </Link>
              </>
            )
          )}
        </nav>
      </div>
    </header>
  )
}
