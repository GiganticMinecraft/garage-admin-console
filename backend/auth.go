package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"path"
	"strings"
	"time"

	"github.com/gorilla/sessions"
	"go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"
	"golang.org/x/oauth2"
	oauthgithub "golang.org/x/oauth2/github"
)

// Session and cookie constants.
const (
	sessionName      = "garage-admin-session"
	sessionKeyState  = "oauth_state"
	sessionKeyUser   = "username"
	sessionKeyAvatar = "avatar_url"
	sessionKeyNext   = "login_next"
	// sessionKeyIssuedAt is the unix time of the GitHub login that created
	// the session; sessionKeyRefreshedAt is the last time the cookie was
	// re-issued. Both are int64 seconds.
	sessionKeyIssuedAt    = "issued_at"
	sessionKeyRefreshedAt = "refreshed_at"
)

// Session lifetime policy. The cookie's MaxAge (3600s) is an idle timeout,
// enforced server-side from refreshed_at as well: authMiddleware re-issues
// the cookie at most every sessionRefreshInterval while the user keeps making
// requests, up to sessionAbsoluteMax after login.
const (
	sessionRefreshInterval = 5 * time.Minute
	sessionAbsoluteMax     = 12 * time.Hour
	// maxLoginNextLen keeps the encrypted, base64-encoded session cookie
	// well under securecookie's 4096-byte limit.
	maxLoginNextLen = 1024
)

// now is the clock used by the session lifetime checks; tests replace it.
var now = time.Now

var (
	sessionStore *sessions.CookieStore
	oauthConfig  *oauth2.Config
	githubOrg    string
	githubTeam   string
	githubHTTP   *http.Client
)

// initAuth initialises the OAuth config, session store, and HTTP client for
// GitHub API calls. Call this once from main before registering routes.
func initAuth() {
	secret := os.Getenv("SESSION_SECRET")
	if len(secret) < 32 {
		slog.Error("SESSION_SECRET must be at least 32 characters")
		os.Exit(1)
	}
	// Two keys: first for signing (32 bytes), second for encryption (32 bytes).
	key := []byte(secret)
	sessionStore = sessions.NewCookieStore(key, key[:32])

	baseURL := os.Getenv("BASE_URL")
	if baseURL == "" {
		baseURL = "http://localhost:8080"
	}

	// Secure cookie only when BASE_URL is HTTPS.
	secureCookie := strings.HasPrefix(baseURL, "https://")

	sessionStore.Options = &sessions.Options{
		Path:     "/",
		MaxAge:   3600,
		HttpOnly: true,
		Secure:   secureCookie,
		SameSite: http.SameSiteLaxMode,
	}

	oauthConfig = &oauth2.Config{
		ClientID:     os.Getenv("GITHUB_CLIENT_ID"),
		ClientSecret: os.Getenv("GITHUB_CLIENT_SECRET"),
		Scopes:       []string{"read:org"},
		Endpoint:     oauthgithub.Endpoint,
		RedirectURL:  baseURL + "/api/auth/callback",
	}

	githubOrg = os.Getenv("GITHUB_ORG")
	if githubOrg == "" {
		githubOrg = "GiganticMinecraft"
	}
	githubTeam = os.Getenv("GITHUB_TEAM_SLUG")
	if githubTeam == "" {
		githubTeam = "admin"
	}

	// HTTP client with OTel transport and timeout for GitHub API calls.
	githubHTTP = &http.Client{
		Transport: otelhttp.NewTransport(http.DefaultTransport),
		Timeout:   10 * time.Second,
	}
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

// handleLogin generates a random state, stores it in the session, and
// redirects the user to GitHub's OAuth authorization page. An optional
// ?next=<path> is validated with safeNextPath and kept in the session so the
// callback can return the user to the page they were on.
func handleLogin(w http.ResponseWriter, r *http.Request) {
	state, err := randomState()
	if err != nil {
		slog.ErrorContext(r.Context(), "failed to generate state", "error", err)
		http.Error(w, "Internal Server Error", http.StatusInternalServerError)
		return
	}

	// A cookie that no longer decodes (e.g. after SESSION_SECRET rotation)
	// must not block sign-in: Get still returns a fresh session, which the
	// Save below writes over the stale cookie.
	sess, err := sessionStore.Get(r, sessionName)
	if err != nil {
		slog.WarnContext(r.Context(), "discarding undecodable session cookie", "error", err)
	}
	sess.Values[sessionKeyState] = state
	if next := safeNextPath(r.URL.Query().Get("next")); next != "" {
		sess.Values[sessionKeyNext] = next
	} else {
		delete(sess.Values, sessionKeyNext)
	}
	if err := sess.Save(r, w); err != nil {
		// Most likely the cookie grew too large; the return path is the
		// only optional value, so drop it and fall back to /.
		_, hadNext := sess.Values[sessionKeyNext]
		delete(sess.Values, sessionKeyNext)
		if !hadNext {
			slog.ErrorContext(r.Context(), "failed to save session", "error", err)
			http.Error(w, "Internal Server Error", http.StatusInternalServerError)
			return
		}
		slog.WarnContext(r.Context(), "failed to save session with next; retrying without it", "error", err)
		if err := sess.Save(r, w); err != nil {
			slog.ErrorContext(r.Context(), "failed to save session", "error", err)
			http.Error(w, "Internal Server Error", http.StatusInternalServerError)
			return
		}
	}

	url := oauthConfig.AuthCodeURL(state)
	http.Redirect(w, r, url, http.StatusFound)
}

// handleCallback is the OAuth callback handler. It verifies the state
// parameter, exchanges the code for a token, checks org/team membership,
// regenerates the session, and redirects to the path saved by handleLogin
// (or / when there is none).
func handleCallback(w http.ResponseWriter, r *http.Request) {
	// On a decode error Get returns an empty session; the state check below
	// then rejects the request with 403 instead of a 500 dead end.
	sess, err := sessionStore.Get(r, sessionName)
	if err != nil {
		slog.WarnContext(r.Context(), "discarding undecodable session cookie", "error", err)
	}

	// CSRF: verify state matches.
	expectedState, _ := sess.Values[sessionKeyState].(string)
	actualState := r.URL.Query().Get("state")
	if expectedState == "" || actualState == "" || expectedState != actualState {
		slog.WarnContext(r.Context(), "OAuth state mismatch")
		http.Error(w, "Forbidden: state mismatch", http.StatusForbidden)
		return
	}

	// Take the return path out of the old session before it is discarded.
	// It was validated in handleLogin; check again so a value written by an
	// older build cannot become an open redirect.
	redirectTo := "/"
	if saved, _ := sess.Values[sessionKeyNext].(string); safeNextPath(saved) != "" {
		redirectTo = saved
	}

	// Exchange code for token.
	code := r.URL.Query().Get("code")
	token, err := oauthConfig.Exchange(r.Context(), code)
	if err != nil {
		slog.ErrorContext(r.Context(), "token exchange failed", "error", err)
		http.Error(w, "Authentication failed", http.StatusUnauthorized)
		return
	}

	// Fetch user info from GitHub.
	userInfo, err := fetchGitHubUser(r.Context(), token.AccessToken)
	if err != nil {
		slog.ErrorContext(r.Context(), "failed to fetch GitHub user", "error", err)
		http.Error(w, "Authentication failed", http.StatusUnauthorized)
		return
	}

	// Check org/team membership.
	if err := checkTeamMembership(r.Context(), token.AccessToken, userInfo.Login); err != nil {
		slog.WarnContext(r.Context(), "team membership check failed", "user", userInfo.Login, "error", err)
		http.Error(w, "Forbidden: not a member of the required team", http.StatusForbidden)
		return
	}

	// Session fixation prevention: regenerate session by clearing old values
	// and issuing a new session ID.
	sess.Options.MaxAge = -1 // expire old session cookie
	if err := sess.Save(r, w); err != nil {
		slog.ErrorContext(r.Context(), "failed to expire old session", "error", err)
		http.Error(w, "Internal Server Error", http.StatusInternalServerError)
		return
	}

	newSess, err := sessionStore.New(r, sessionName)
	if err != nil {
		slog.ErrorContext(r.Context(), "failed to create new session", "error", err)
		http.Error(w, "Internal Server Error", http.StatusInternalServerError)
		return
	}
	// CookieStore.New decodes the existing cookie, so start from an empty
	// map to make sure nothing (state, next, old timestamps) carries over.
	newSess.Values = map[interface{}]interface{}{}
	newSess.Values[sessionKeyUser] = userInfo.Login
	newSess.Values[sessionKeyAvatar] = userInfo.AvatarURL
	loginAt := now().Unix()
	newSess.Values[sessionKeyIssuedAt] = loginAt
	newSess.Values[sessionKeyRefreshedAt] = loginAt
	newSess.Options = sessionStore.Options
	if err := newSess.Save(r, w); err != nil {
		slog.ErrorContext(r.Context(), "failed to save new session", "error", err)
		http.Error(w, "Internal Server Error", http.StatusInternalServerError)
		return
	}

	auditAuthEvent(r, "login", userInfo.Login)
	http.Redirect(w, r, redirectTo, http.StatusFound)
}

// handleMe returns the current session user info as JSON.
func handleMe(w http.ResponseWriter, r *http.Request) {
	sess, err := sessionStore.Get(r, sessionName)
	if err != nil {
		http.Error(w, "Internal Server Error", http.StatusInternalServerError)
		return
	}

	username, _ := sess.Values[sessionKeyUser].(string)
	avatarURL, _ := sess.Values[sessionKeyAvatar].(string)

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{
		"username":   username,
		"avatar_url": avatarURL,
	})
}

// handleLogout destroys the session.
func handleLogout(w http.ResponseWriter, r *http.Request) {
	sess, err := sessionStore.Get(r, sessionName)
	if err != nil {
		http.Error(w, "Internal Server Error", http.StatusInternalServerError)
		return
	}

	username, _ := sess.Values[sessionKeyUser].(string)
	sess.Options.MaxAge = -1
	if err := sess.Save(r, w); err != nil {
		slog.ErrorContext(r.Context(), "failed to destroy session", "error", err)
		http.Error(w, "Internal Server Error", http.StatusInternalServerError)
		return
	}
	auditAuthEvent(r, "logout", username)

	w.WriteHeader(http.StatusNoContent)
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

// authMiddleware validates the session cookie on protected routes and
// implements the sliding session:
//   - a cookie that does not decode is cleared and the request is 401;
//   - a session idle (no refresh) for longer than the cookie MaxAge, or older
//     than sessionAbsoluteMax since login, is cleared and the request is 401;
//   - otherwise, once sessionRefreshInterval has passed since refreshed_at,
//     the cookie is re-issued (extending its MaxAge) when the handler sends
//     its response headers, unless the handler already set the session
//     cookie itself (e.g. logout expiring it).
func authMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sess, err := sessionStore.Get(r, sessionName)
		if err != nil {
			expireSessionCookie(w, r, sess)
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			return
		}

		username, ok := sess.Values[sessionKeyUser].(string)
		if !ok || username == "" {
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			return
		}

		current := now()
		issuedAt, hasIssued := sess.Values[sessionKeyIssuedAt].(int64)
		// A missing refreshed_at counts as "never refreshed": it is due now.
		refreshedAt, hasRefreshed := sess.Values[sessionKeyRefreshedAt].(int64)
		if !hasIssued {
			// Sessions created before issued_at existed: start the absolute
			// limit now instead of logging everyone out on deploy.
			issuedAt = current.Unix()
			sess.Values[sessionKeyIssuedAt] = issuedAt
		}
		idle := current.Sub(time.Unix(refreshedAt, 0))
		maxIdle := time.Duration(sessionStore.Options.MaxAge) * time.Second
		if current.Sub(time.Unix(issuedAt, 0)) > sessionAbsoluteMax ||
			(hasRefreshed && maxIdle > 0 && idle > maxIdle) {
			expireSessionCookie(w, r, sess)
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			return
		}

		if !hasIssued || idle >= sessionRefreshInterval {
			sess.Values[sessionKeyRefreshedAt] = current.Unix()
			sw := &sessionRefreshWriter{ResponseWriter: w, r: r, sess: sess}
			next.ServeHTTP(sw, r)
			// A handler that wrote nothing still gets its implicit 200
			// after returning; the headers have not gone out yet.
			sw.refresh()
			return
		}
		next.ServeHTTP(w, r)
	})
}

// expireSessionCookie tells the browser to drop the session cookie.
func expireSessionCookie(w http.ResponseWriter, r *http.Request, sess *sessions.Session) {
	if sess == nil {
		sess = sessions.NewSession(sessionStore, sessionName)
		opts := *sessionStore.Options
		sess.Options = &opts
	}
	sess.Options.MaxAge = -1
	if err := sess.Save(r, w); err != nil {
		slog.ErrorContext(r.Context(), "failed to expire session", "error", err)
	}
}

// sessionRefreshWriter re-issues the session cookie just before the response
// headers go out, so the handler gets the last word: if it already set the
// session cookie (logout expiring it), no refreshed cookie is added.
type sessionRefreshWriter struct {
	http.ResponseWriter
	r    *http.Request
	sess *sessions.Session
	done bool
}

func (sw *sessionRefreshWriter) refresh() {
	if sw.done {
		return
	}
	sw.done = true
	if hasSessionSetCookie(sw.Header()) {
		return
	}
	if err := sw.sess.Save(sw.r, sw.ResponseWriter); err != nil {
		slog.ErrorContext(sw.r.Context(), "failed to refresh session", "error", err)
	}
}

func (sw *sessionRefreshWriter) WriteHeader(code int) {
	sw.refresh()
	sw.ResponseWriter.WriteHeader(code)
}

func (sw *sessionRefreshWriter) Write(b []byte) (int, error) {
	sw.refresh()
	return sw.ResponseWriter.Write(b)
}

func (sw *sessionRefreshWriter) Flush() {
	sw.refresh()
	if f, ok := sw.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

// Unwrap lets http.ResponseController reach the underlying writer.
func (sw *sessionRefreshWriter) Unwrap() http.ResponseWriter { return sw.ResponseWriter }

// hasSessionSetCookie reports whether h already carries a Set-Cookie for the
// session cookie.
func hasSessionSetCookie(h http.Header) bool {
	for _, v := range h.Values("Set-Cookie") {
		if strings.HasPrefix(v, sessionName+"=") {
			return true
		}
	}
	return false
}

// csrfMiddleware protects mutation requests (POST/PUT/DELETE).
//
// Requirements:
//   - All mutation requests must include `X-Requested-With: XMLHttpRequest`.
//   - JSON endpoints must also include `Content-Type: application/json`.
//   - File upload endpoints (`/api/objects/*/upload`) may use
//     `Content-Type: multipart/form-data` instead of application/json.
func csrfMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost || r.Method == http.MethodPut || r.Method == http.MethodDelete {
			// All mutation requests require X-Requested-With header.
			if r.Header.Get("X-Requested-With") != "XMLHttpRequest" {
				http.Error(w, "Forbidden: missing X-Requested-With header", http.StatusForbidden)
				return
			}

			// Determine if this is a file upload endpoint.
			isUpload := isUploadPath(r.URL.Path)

			// Content-Type validation (only for requests with a body).
			if r.ContentLength != 0 {
				ct := r.Header.Get("Content-Type")
				if isUpload {
					// Upload endpoints accept multipart/form-data or application/json.
					if !strings.HasPrefix(ct, "multipart/form-data") && !strings.HasPrefix(ct, "application/json") {
						http.Error(w, "Forbidden: invalid Content-Type for upload", http.StatusForbidden)
						return
					}
				} else {
					// Other mutation endpoints with body require application/json.
					if !strings.HasPrefix(ct, "application/json") {
						http.Error(w, "Forbidden: Content-Type must be application/json", http.StatusForbidden)
						return
					}
				}
			}
		}

		next.ServeHTTP(w, r)
	})
}

// isUploadPath returns true if the path matches the upload pattern
// /api/objects/*/upload.
func isUploadPath(path string) bool {
	// Pattern: /api/objects/{something}/upload
	const prefix = "/api/objects/"
	const suffix = "/upload"
	if !strings.HasPrefix(path, prefix) {
		return false
	}
	rest := path[len(prefix):]
	if !strings.HasSuffix(rest, suffix) {
		return false
	}
	// Ensure there is something between prefix and suffix (the bucket/key).
	middle := rest[:len(rest)-len(suffix)]
	return len(middle) > 0
}

// ---------------------------------------------------------------------------
// GitHub API helpers
// ---------------------------------------------------------------------------

// githubUser holds the subset of fields we need from the GitHub user API.
type githubUser struct {
	Login     string `json:"login"`
	AvatarURL string `json:"avatar_url"`
}

// fetchGitHubUser calls GET https://api.github.com/user with the given token.
func fetchGitHubUser(ctx context.Context, accessToken string) (*githubUser, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "https://api.github.com/user", nil)
	if err != nil {
		return nil, fmt.Errorf("creating request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+accessToken)
	req.Header.Set("Accept", "application/vnd.github+json")

	resp, err := githubHTTP.Do(req)
	if err != nil {
		return nil, fmt.Errorf("requesting user info: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("GitHub /user returned status %d", resp.StatusCode)
	}

	var u githubUser
	if err := json.NewDecoder(resp.Body).Decode(&u); err != nil {
		return nil, fmt.Errorf("decoding user info: %w", err)
	}
	return &u, nil
}

// checkTeamMembership verifies that the user belongs to the configured
// org/team. It calls GET /orgs/{org}/teams/{team}/memberships/{username}.
func checkTeamMembership(ctx context.Context, accessToken, username string) error {
	url := fmt.Sprintf("https://api.github.com/orgs/%s/teams/%s/memberships/%s",
		githubOrg, githubTeam, username)

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return fmt.Errorf("creating request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+accessToken)
	req.Header.Set("Accept", "application/vnd.github+json")

	resp, err := githubHTTP.Do(req)
	if err != nil {
		return fmt.Errorf("requesting team membership: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("user %s is not a member of %s/%s (status %d)",
			username, githubOrg, githubTeam, resp.StatusCode)
	}

	// Verify the membership state is "active".
	var membership struct {
		State string `json:"state"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&membership); err != nil {
		return fmt.Errorf("decoding membership: %w", err)
	}
	if membership.State != "active" {
		return fmt.Errorf("membership state is %q, not active", membership.State)
	}

	return nil
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// safeNextPath returns raw if it is a same-origin path that is safe to
// redirect to after login, or "" otherwise. Accepted values start with a
// single "/", carry no scheme or host, contain no control characters or
// backslashes, are at most maxLoginNextLen bytes, and are not under /api/
// (the callback must land on a SPA page, not an API endpoint).
func safeNextPath(raw string) string {
	if raw == "" || len(raw) > maxLoginNextLen || raw[0] != '/' {
		return ""
	}
	if strings.HasPrefix(raw, "//") || strings.ContainsRune(raw, '\\') {
		return ""
	}
	for _, c := range raw {
		if c < 0x20 || c == 0x7f {
			return ""
		}
	}
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "" || u.Host != "" || u.User != nil {
		return ""
	}
	// Compare on the cleaned, decoded path so "/x/../api/..." or
	// "/%61pi/..." cannot point the redirect at the API.
	cleaned := path.Clean(u.Path)
	if cleaned == "/api" || strings.HasPrefix(cleaned, "/api/") {
		return ""
	}
	return raw
}

// randomState generates a cryptographically random hex string for the OAuth
// state parameter.
func randomState() (string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}
