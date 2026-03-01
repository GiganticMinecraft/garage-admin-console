package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"os"
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
)

var (
	sessionStore  *sessions.CookieStore
	oauthConfig   *oauth2.Config
	githubOrg     string
	githubTeam    string
	githubHTTP    *http.Client
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
// redirects the user to GitHub's OAuth authorization page.
func handleLogin(w http.ResponseWriter, r *http.Request) {
	state, err := randomState()
	if err != nil {
		slog.Error("failed to generate state", "error", err)
		http.Error(w, "Internal Server Error", http.StatusInternalServerError)
		return
	}

	sess, err := sessionStore.Get(r, sessionName)
	if err != nil {
		slog.Error("failed to get session", "error", err)
		http.Error(w, "Internal Server Error", http.StatusInternalServerError)
		return
	}
	sess.Values[sessionKeyState] = state
	if err := sess.Save(r, w); err != nil {
		slog.Error("failed to save session", "error", err)
		http.Error(w, "Internal Server Error", http.StatusInternalServerError)
		return
	}

	url := oauthConfig.AuthCodeURL(state)
	http.Redirect(w, r, url, http.StatusFound)
}

// handleCallback is the OAuth callback handler. It verifies the state
// parameter, exchanges the code for a token, checks org/team membership,
// regenerates the session, and redirects to /.
func handleCallback(w http.ResponseWriter, r *http.Request) {
	sess, err := sessionStore.Get(r, sessionName)
	if err != nil {
		slog.Error("failed to get session", "error", err)
		http.Error(w, "Internal Server Error", http.StatusInternalServerError)
		return
	}

	// CSRF: verify state matches.
	expectedState, _ := sess.Values[sessionKeyState].(string)
	actualState := r.URL.Query().Get("state")
	if expectedState == "" || actualState == "" || expectedState != actualState {
		slog.Warn("OAuth state mismatch")
		http.Error(w, "Forbidden: state mismatch", http.StatusForbidden)
		return
	}

	// Exchange code for token.
	code := r.URL.Query().Get("code")
	token, err := oauthConfig.Exchange(r.Context(), code)
	if err != nil {
		slog.Error("token exchange failed", "error", err)
		http.Error(w, "Authentication failed", http.StatusUnauthorized)
		return
	}

	// Fetch user info from GitHub.
	userInfo, err := fetchGitHubUser(r.Context(), token.AccessToken)
	if err != nil {
		slog.Error("failed to fetch GitHub user", "error", err)
		http.Error(w, "Authentication failed", http.StatusUnauthorized)
		return
	}

	// Check org/team membership.
	if err := checkTeamMembership(r.Context(), token.AccessToken, userInfo.Login); err != nil {
		slog.Warn("team membership check failed", "user", userInfo.Login, "error", err)
		http.Error(w, "Forbidden: not a member of the required team", http.StatusForbidden)
		return
	}

	// Session fixation prevention: regenerate session by clearing old values
	// and issuing a new session ID.
	sess.Options.MaxAge = -1 // expire old session cookie
	if err := sess.Save(r, w); err != nil {
		slog.Error("failed to expire old session", "error", err)
		http.Error(w, "Internal Server Error", http.StatusInternalServerError)
		return
	}

	newSess, err := sessionStore.New(r, sessionName)
	if err != nil {
		slog.Error("failed to create new session", "error", err)
		http.Error(w, "Internal Server Error", http.StatusInternalServerError)
		return
	}
	newSess.Values[sessionKeyUser] = userInfo.Login
	newSess.Values[sessionKeyAvatar] = userInfo.AvatarURL
	newSess.Options = sessionStore.Options
	if err := newSess.Save(r, w); err != nil {
		slog.Error("failed to save new session", "error", err)
		http.Error(w, "Internal Server Error", http.StatusInternalServerError)
		return
	}

	http.Redirect(w, r, "/", http.StatusFound)
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

	sess.Options.MaxAge = -1
	if err := sess.Save(r, w); err != nil {
		slog.Error("failed to destroy session", "error", err)
		http.Error(w, "Internal Server Error", http.StatusInternalServerError)
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

// authMiddleware validates the session cookie on protected routes.
func authMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sess, err := sessionStore.Get(r, sessionName)
		if err != nil {
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			return
		}

		username, ok := sess.Values[sessionKeyUser].(string)
		if !ok || username == "" {
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			return
		}

		next.ServeHTTP(w, r)
	})
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

// randomState generates a cryptographically random hex string for the OAuth
// state parameter.
func randomState() (string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}
