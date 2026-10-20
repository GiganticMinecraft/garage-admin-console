package main

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/sessions"
)

func TestSafeNextPath(t *testing.T) {
	allowed := []string{
		"/",
		"/buckets",
		"/buckets/abc123?tab=settings",
		"/buckets/%E6%97%A5%E6%9C%AC?tab=objects&prefix=a%2Fb",
		"/apix",
		"/keys/api/whatever",
		"/" + strings.Repeat("a", maxLoginNextLen-1),
	}
	for _, p := range allowed {
		if got := safeNextPath(p); got != p {
			t.Errorf("safeNextPath(%q) = %q, want it allowed", p, got)
		}
	}

	rejected := []string{
		"",
		"buckets",
		"//evil.example.com",
		"//evil.example.com/path",
		"/\\evil.example.com",
		"/foo\\bar",
		"https://evil.example.com/",
		"javascript:alert(1)",
		"/api",
		"/api/",
		"/api/auth/login",
		"/api/auth/logout?x=1",
		"/x/../api/auth/login",
		"/%61pi/auth/login",
		"/foo\nSet-Cookie: x=y",
		"/foo\tbar",
		"/" + strings.Repeat("a", maxLoginNextLen),
	}
	for _, p := range rejected {
		if got := safeNextPath(p); got != "" {
			t.Errorf("safeNextPath(%q) = %q, want rejected", p, got)
		}
	}
}

// decodeSession decodes the session from the Set-Cookie headers of rec.
func decodeSession(t *testing.T, store *sessions.CookieStore, rec *httptest.ResponseRecorder) *sessions.Session {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	for _, c := range rec.Result().Cookies() {
		req.AddCookie(c)
	}
	sess, err := store.New(req, sessionName)
	if err != nil {
		t.Fatalf("decode session: %v", err)
	}
	return sess
}

// sessionCookie returns the session's Set-Cookie on rec, or nil.
func sessionCookie(rec *httptest.ResponseRecorder) *http.Cookie {
	for _, c := range rec.Result().Cookies() {
		if c.Name == sessionName {
			return c
		}
	}
	return nil
}

func TestLogin_StoresValidNextOnly(t *testing.T) {
	router, store := setupTestRouter(t, "http://127.0.0.1:1")

	cases := map[string]string{
		"/buckets/abc?tab=settings": "/buckets/abc?tab=settings",
		"//evil.example.com":        "",
		"/api/auth/me":              "",
		"":                          "",
	}
	for next, want := range cases {
		target := "/api/auth/login"
		if next != "" {
			target += "?next=" + url.QueryEscape(next)
		}
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, target, nil))
		if rec.Code != http.StatusFound {
			t.Fatalf("login(%q) status = %d", next, rec.Code)
		}
		if loc := rec.Header().Get("Location"); !strings.HasPrefix(loc, "https://github.com/login/oauth/authorize") {
			t.Errorf("login(%q) Location = %q", next, loc)
		}
		sess := decodeSession(t, store, rec)
		got, _ := sess.Values[sessionKeyNext].(string)
		if got != want {
			t.Errorf("login(%q) stored next = %q, want %q", next, got, want)
		}
		if s, _ := sess.Values[sessionKeyState].(string); s == "" {
			t.Errorf("login(%q) did not store state", next)
		}
	}
}

// setupFakeGitHub points the OAuth token exchange and the GitHub API client
// at an httptest server that accepts any code for user octocat.
func setupFakeGitHub(t *testing.T) {
	t.Helper()
	fakeGitHub := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.URL.Path == "/login/oauth/access_token":
			w.Write([]byte(`{"access_token":"gho_test","token_type":"bearer"}`))
		case r.URL.Path == "/user":
			w.Write([]byte(`{"login":"octocat","avatar_url":"https://example.com/a.png"}`))
		case strings.Contains(r.URL.Path, "/memberships/"):
			w.Write([]byte(`{"state":"active"}`))
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(fakeGitHub.Close)
	oauthConfig.Endpoint.TokenURL = fakeGitHub.URL + "/login/oauth/access_token"
	prevHTTP := githubHTTP
	githubHTTP = &http.Client{Transport: rewriteTransport{fakeGitHub.URL}}
	t.Cleanup(func() { githubHTTP = prevHTTP })
}

func setClock(t *testing.T, at time.Time) *time.Time {
	t.Helper()
	cur := at
	prev := now
	now = func() time.Time { return cur }
	t.Cleanup(func() { now = prev })
	return &cur
}

func TestCallback_RedirectsToSavedNext(t *testing.T) {
	router, store := setupTestRouter(t, "http://127.0.0.1:1")
	setupFakeGitHub(t)
	loginAt := time.Date(2026, 10, 20, 2, 0, 0, 0, time.UTC)
	setClock(t, loginAt)

	cases := map[string]string{
		"/buckets/abc?tab=settings": "/buckets/abc?tab=settings",
		"":                          "/",
		// A tampered or legacy value is re-checked at callback time.
		"//evil.example.com": "/",
	}
	for saved, want := range cases {
		req := httptest.NewRequest(http.MethodGet, "/api/auth/callback?state=st4te&code=c0de", nil)
		sess, _ := store.New(req, sessionName)
		sess.Values[sessionKeyState] = "st4te"
		if saved != "" {
			sess.Values[sessionKeyNext] = saved
		}
		saveRec := httptest.NewRecorder()
		sess.Save(req, saveRec)
		for _, c := range saveRec.Result().Cookies() {
			req.AddCookie(c)
		}

		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		if rec.Code != http.StatusFound {
			t.Fatalf("callback(%q) status = %d body %s", saved, rec.Code, rec.Body.String())
		}
		if loc := rec.Header().Get("Location"); loc != want {
			t.Errorf("callback(%q) Location = %q, want %q", saved, loc, want)
		}

		// The last Set-Cookie is the new session; it must not carry the
		// state or next over, and must start the lifetime clock.
		cookies := rec.Result().Cookies()
		last := cookies[len(cookies)-1]
		r2 := httptest.NewRequest(http.MethodGet, "/", nil)
		r2.AddCookie(last)
		newSess, err := store.New(r2, sessionName)
		if err != nil {
			t.Fatalf("decode new session: %v", err)
		}
		if u, _ := newSess.Values[sessionKeyUser].(string); u != "octocat" {
			t.Errorf("new session user = %q", u)
		}
		for _, k := range []string{sessionKeyState, sessionKeyNext} {
			if _, ok := newSess.Values[k]; ok {
				t.Errorf("new session still has %s", k)
			}
		}
		if v, _ := newSess.Values[sessionKeyIssuedAt].(int64); v != loginAt.Unix() {
			t.Errorf("issued_at = %d, want %d", v, loginAt.Unix())
		}
	}

	// State mismatch is still rejected even with a valid next.
	req := httptest.NewRequest(http.MethodGet, "/api/auth/callback?state=other&code=c0de", nil)
	sess, _ := store.New(req, sessionName)
	sess.Values[sessionKeyState] = "st4te"
	sess.Values[sessionKeyNext] = "/buckets"
	saveRec := httptest.NewRecorder()
	sess.Save(req, saveRec)
	for _, c := range saveRec.Result().Cookies() {
		req.AddCookie(c)
	}
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Errorf("state mismatch status = %d, want 403", rec.Code)
	}
}

// sessionRequest builds a request whose cookie holds a logged-in session with
// the given timestamps (zero means the field is absent).
func sessionRequest(t *testing.T, store *sessions.CookieStore, path string, issuedAt, refreshedAt time.Time) *http.Request {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, path, nil)
	sess, _ := store.New(req, sessionName)
	sess.Values[sessionKeyUser] = "testuser"
	if !issuedAt.IsZero() {
		sess.Values[sessionKeyIssuedAt] = issuedAt.Unix()
	}
	if !refreshedAt.IsZero() {
		sess.Values[sessionKeyRefreshedAt] = refreshedAt.Unix()
	}
	rec := httptest.NewRecorder()
	sess.Save(req, rec)
	for _, c := range rec.Result().Cookies() {
		req.AddCookie(c)
	}
	return req
}

func TestAuthMiddleware_SlidingSession(t *testing.T) {
	router, store := setupTestRouter(t, "http://127.0.0.1:1")
	loginAt := time.Date(2026, 10, 20, 2, 0, 0, 0, time.UTC)
	clock := setClock(t, loginAt)

	t.Run("under refresh interval does not re-issue", func(t *testing.T) {
		*clock = loginAt.Add(sessionRefreshInterval - time.Second)
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, sessionRequest(t, store, "/api/auth/me", loginAt, loginAt))
		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d", rec.Code)
		}
		if c := sessionCookie(rec); c != nil {
			t.Errorf("unexpected Set-Cookie: %v", c)
		}
	})

	t.Run("at refresh interval re-issues with MaxAge", func(t *testing.T) {
		*clock = loginAt.Add(sessionRefreshInterval)
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, sessionRequest(t, store, "/api/auth/me", loginAt, loginAt))
		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d", rec.Code)
		}
		c := sessionCookie(rec)
		if c == nil {
			t.Fatal("no Set-Cookie after refresh interval")
		}
		if c.MaxAge != 3600 {
			t.Errorf("MaxAge = %d, want 3600", c.MaxAge)
		}
		sess := decodeSession(t, store, rec)
		if v, _ := sess.Values[sessionKeyRefreshedAt].(int64); v != clock.Unix() {
			t.Errorf("refreshed_at = %d, want %d", v, clock.Unix())
		}
		if v, _ := sess.Values[sessionKeyIssuedAt].(int64); v != loginAt.Unix() {
			t.Errorf("issued_at changed to %d", v)
		}
	})

	t.Run("within absolute limit is allowed", func(t *testing.T) {
		*clock = loginAt.Add(sessionAbsoluteMax)
		refreshed := clock.Add(-time.Minute)
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, sessionRequest(t, store, "/api/auth/me", loginAt, refreshed))
		if rec.Code != http.StatusOK {
			t.Errorf("status = %d, want 200", rec.Code)
		}
	})

	t.Run("past absolute limit is 401", func(t *testing.T) {
		*clock = loginAt.Add(sessionAbsoluteMax + time.Second)
		refreshed := clock.Add(-time.Minute)
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, sessionRequest(t, store, "/api/auth/me", loginAt, refreshed))
		if rec.Code != http.StatusUnauthorized {
			t.Errorf("status = %d, want 401", rec.Code)
		}
		if c := sessionCookie(rec); c == nil || c.MaxAge >= 0 {
			t.Errorf("expired session cookie not cleared: %v", c)
		}
	})

	t.Run("legacy session without timestamps is upgraded", func(t *testing.T) {
		*clock = loginAt.Add(time.Hour)
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, sessionRequest(t, store, "/api/auth/me", time.Time{}, time.Time{}))
		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d", rec.Code)
		}
		if sessionCookie(rec) == nil {
			t.Fatal("legacy session was not re-issued with timestamps")
		}
		sess := decodeSession(t, store, rec)
		if v, _ := sess.Values[sessionKeyIssuedAt].(int64); v != clock.Unix() {
			t.Errorf("issued_at = %d, want now %d", v, clock.Unix())
		}
		if v, _ := sess.Values[sessionKeyRefreshedAt].(int64); v != clock.Unix() {
			t.Errorf("refreshed_at = %d, want now %d", v, clock.Unix())
		}
	})

	t.Run("logout is not refreshed", func(t *testing.T) {
		*clock = loginAt.Add(time.Hour)
		req := sessionRequest(t, store, "/api/auth/logout", loginAt, loginAt)
		req.Method = http.MethodPost
		req.Header.Set("X-Requested-With", "XMLHttpRequest")
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		if rec.Code != http.StatusNoContent {
			t.Fatalf("status = %d", rec.Code)
		}
		n := 0
		for _, c := range rec.Result().Cookies() {
			if c.Name == sessionName {
				n++
				if c.MaxAge >= 0 {
					t.Errorf("logout cookie MaxAge = %d", c.MaxAge)
				}
			}
		}
		if n != 1 {
			t.Errorf("logout emitted %d session cookies, want 1", n)
		}
	})
}

// garbageCookieRequest builds a request whose session cookie does not decode
// with the current key (as after a SESSION_SECRET rotation).
func garbageCookieRequest(method, target string) *http.Request {
	req := httptest.NewRequest(method, target, nil)
	other := sessions.NewCookieStore([]byte("another-secret-that-is-32-bytes!"), []byte("another-secret-that-is-32-bytes!"))
	sess, _ := other.New(req, sessionName)
	sess.Values[sessionKeyUser] = "testuser"
	rec := httptest.NewRecorder()
	sess.Save(req, rec)
	for _, c := range rec.Result().Cookies() {
		req.AddCookie(c)
	}
	return req
}

func TestUndecodableCookie(t *testing.T) {
	router, store := setupTestRouter(t, "http://127.0.0.1:1")

	t.Run("login continues with a fresh session", func(t *testing.T) {
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, garbageCookieRequest(http.MethodGet, "/api/auth/login?next=%2Fbuckets"))
		if rec.Code != http.StatusFound {
			t.Fatalf("status = %d, want 302", rec.Code)
		}
		sess := decodeSession(t, store, rec)
		if got, _ := sess.Values[sessionKeyNext].(string); got != "/buckets" {
			t.Errorf("next = %q", got)
		}
		if _, ok := sess.Values[sessionKeyUser]; ok {
			t.Error("fresh session carries a user")
		}
	})

	t.Run("callback rejects by state, not 500", func(t *testing.T) {
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, garbageCookieRequest(http.MethodGet, "/api/auth/callback?state=x&code=y"))
		if rec.Code != http.StatusForbidden {
			t.Errorf("status = %d, want 403", rec.Code)
		}
	})

	t.Run("protected route clears the cookie and is 401", func(t *testing.T) {
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, garbageCookieRequest(http.MethodGet, "/api/auth/me"))
		if rec.Code != http.StatusUnauthorized {
			t.Errorf("status = %d, want 401", rec.Code)
		}
		if c := sessionCookie(rec); c == nil || c.MaxAge >= 0 {
			t.Errorf("cookie not cleared: %v", c)
		}
	})
}

func TestAuthMiddleware_IdleTimeout(t *testing.T) {
	router, store := setupTestRouter(t, "http://127.0.0.1:1")
	loginAt := time.Date(2026, 10, 20, 2, 0, 0, 0, time.UTC)
	clock := setClock(t, loginAt)
	maxIdle := time.Duration(store.Options.MaxAge) * time.Second

	*clock = loginAt.Add(maxIdle)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, sessionRequest(t, store, "/api/auth/me", loginAt, loginAt))
	if rec.Code != http.StatusOK {
		t.Errorf("idle == MaxAge: status = %d, want 200", rec.Code)
	}

	*clock = loginAt.Add(maxIdle + time.Second)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, sessionRequest(t, store, "/api/auth/me", loginAt, loginAt))
	if rec.Code != http.StatusUnauthorized {
		t.Errorf("idle > MaxAge: status = %d, want 401", rec.Code)
	}
	if c := sessionCookie(rec); c == nil || c.MaxAge >= 0 {
		t.Errorf("idle session cookie not cleared: %v", c)
	}
}

// TestAuthMiddleware_RefreshYieldsToHandlerCookie checks that the refresh
// happens when the response goes out and never overrides a session cookie
// the handler set (logout expiring it), and that a handler writing nothing
// still gets the refresh.
func TestAuthMiddleware_RefreshYieldsToHandlerCookie(t *testing.T) {
	_, store := setupTestRouter(t, "http://127.0.0.1:1")
	loginAt := time.Date(2026, 10, 20, 2, 0, 0, 0, time.UTC)
	setClock(t, loginAt.Add(30*time.Minute))

	expiring := authMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sess, _ := sessionStore.Get(r, sessionName)
		sess.Options.MaxAge = -1
		sess.Save(r, w)
		w.WriteHeader(http.StatusNoContent)
	}))
	rec := httptest.NewRecorder()
	expiring.ServeHTTP(rec, sessionRequest(t, store, "/api/anything", loginAt, loginAt))
	var cookies []*http.Cookie
	for _, c := range rec.Result().Cookies() {
		if c.Name == sessionName {
			cookies = append(cookies, c)
		}
	}
	if len(cookies) != 1 || cookies[0].MaxAge >= 0 {
		t.Errorf("want only the expiring cookie, got %v", cookies)
	}

	silent := authMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	rec = httptest.NewRecorder()
	silent.ServeHTTP(rec, sessionRequest(t, store, "/api/anything", loginAt, loginAt))
	if c := sessionCookie(rec); c == nil || c.MaxAge != 3600 {
		t.Errorf("silent handler: refresh cookie = %v", c)
	}
}
