import { NavLink } from 'react-router-dom'

function marketingLinkClass({ isActive }) {
  return isActive
    ? 'top-nav-link top-nav-link--muted top-nav-link--active'
    : 'top-nav-link top-nav-link--muted'
}

function brandClass({ isActive }) {
  return isActive ? 'top-nav-brand top-nav-brand--active' : 'top-nav-brand'
}

export function TopNav() {
  return (
    <header className="top-nav">
      <div className="top-nav-inner">
        <NavLink to="/" end className={brandClass}>
          PrepBrief
        </NavLink>
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
        </nav>
      </div>
    </header>
  )
}
