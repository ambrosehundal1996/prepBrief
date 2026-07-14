import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react'
import { supabase, isSupabaseClientConfigured } from '../lib/supabaseClient.js'

const AuthContext = createContext(null)

function apiUrl(path) {
  const base = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, '')
  return `${base}${path}`
}

export function AuthProvider({ children }) {
  const [session, setSession] = useState(null)
  const [loading, setLoading] = useState(isSupabaseClientConfigured())
  const [account, setAccount] = useState(null)

  const refreshAccount = useCallback(async (accessToken) => {
    if (!accessToken) {
      setAccount(null)
      return null
    }
    try {
      const res = await fetch(apiUrl('/api/account'), {
        headers: { Authorization: `Bearer ${accessToken}` },
      })
      if (!res.ok) return null
      const data = await res.json()
      setAccount(data)
      return data
    } catch (e) {
      console.warn('[auth] refreshAccount failed', e)
      return null
    }
  }, [])

  useEffect(() => {
    if (!supabase) return undefined

    let cancelled = false
    supabase.auth.getSession().then(({ data }) => {
      if (cancelled) return
      setSession(data.session)
      setLoading(false)
      if (data.session?.access_token) {
        void refreshAccount(data.session.access_token)
      }
    })

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession)
      if (nextSession?.access_token) {
        void refreshAccount(nextSession.access_token)
      } else {
        setAccount(null)
      }
    })

    return () => {
      cancelled = true
      subscription.unsubscribe()
    }
  }, [refreshAccount])

  const signUp = useCallback(async (email, password) => {
    if (!supabase) throw new Error('Auth is not configured.')
    const { data, error } = await supabase.auth.signUp({ email, password })
    if (error) throw error
    return data
  }, [])

  const signIn = useCallback(async (email, password) => {
    if (!supabase) throw new Error('Auth is not configured.')
    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password,
    })
    if (error) throw error
    return data
  }, [])

  const signOut = useCallback(async () => {
    if (!supabase) return
    await supabase.auth.signOut()
    setAccount(null)
  }, [])

  const startCheckout = useCallback(
    async (plan) => {
      const token = session?.access_token
      if (!token) throw new Error('Sign in required.')
      const res = await fetch(apiUrl('/api/stripe/checkout'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ plan }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        throw new Error(data.error || 'Checkout failed.')
      }
      if (data.url) {
        window.location.href = data.url
      }
      return data
    },
    [session],
  )

  const value = useMemo(
    () => ({
      configured: isSupabaseClientConfigured(),
      session,
      user: session?.user ?? null,
      accessToken: session?.access_token ?? null,
      account,
      loading,
      signUp,
      signIn,
      signOut,
      refreshAccount,
      startCheckout,
    }),
    [
      session,
      account,
      loading,
      signUp,
      signIn,
      signOut,
      refreshAccount,
      startCheckout,
    ],
  )

  return (
    <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
  )
}

// eslint-disable-next-line react-refresh/only-export-components -- hook lives with provider
export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) {
    throw new Error('useAuth must be used within AuthProvider')
  }
  return ctx
}
