package main

import (
	"bytes"
	"encoding/json"
	"flag"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"testing"
)

// updateGolden rewrites ../frontend/src/lib/console-scope.golden.json: go test -run TestConsoleScopeGolden -update
var updateGolden = flag.Bool("update", false, "rewrite testdata golden files")

// consoleScopeGolden is consoleScope as JSON. The frontend tests import it, so
// they check the list the backend actually serves without parsing Go source.
const consoleScopeGolden = "../frontend/src/lib/console-scope.golden.json"

func TestConsoleScopeGolden(t *testing.T) {
	want, err := json.MarshalIndent(consoleScope, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	want = append(want, '\n')
	if *updateGolden {
		if err := os.MkdirAll(filepath.Dir(consoleScopeGolden), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(consoleScopeGolden, want, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	got, err := os.ReadFile(consoleScopeGolden)
	if err != nil {
		t.Fatalf("%v (regenerate with: go test -run TestConsoleScopeGolden -update)", err)
	}
	if !bytes.Equal(got, want) {
		t.Errorf("%s is out of date; regenerate with: go test -run TestConsoleScopeGolden -update", consoleScopeGolden)
	}
}

// garageV2Call matches a Garage Admin API v2 path literal such as "/v2/GetClusterHealth.
var garageV2Call = regexp.MustCompile(`"/v2/([A-Za-z]+)`)

// TestConsoleScopeMatchesSource checks consoleScope against the "/v2/<Name>"
// literals in the non-test backend sources, in both directions: a new Garage
// call missing from consoleScope fails, and so does a stale entry.
func TestConsoleScopeMatchesSource(t *testing.T) {
	files, err := filepath.Glob("*.go")
	if err != nil {
		t.Fatal(err)
	}
	found := map[string]bool{}
	for _, f := range files {
		if strings.HasSuffix(f, "_test.go") {
			continue
		}
		src, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		for _, m := range garageV2Call.FindAllStringSubmatch(string(src), -1) {
			found[m[1]] = true
		}
	}
	if len(found) == 0 {
		t.Fatal(`no "/v2/<Name> literals found; is the test running in backend/?`)
	}
	want := make([]string, 0, len(found))
	for name := range found {
		want = append(want, name)
	}
	slices.Sort(want)

	if !slices.IsSorted(consoleScope) {
		t.Errorf("consoleScope is not sorted: %v", consoleScope)
	}
	if !slices.Equal(consoleScope, want) {
		var missing, stale []string
		for _, s := range want {
			if !slices.Contains(consoleScope, s) {
				missing = append(missing, s)
			}
		}
		for _, s := range consoleScope {
			if !found[s] {
				stale = append(stale, s)
			}
		}
		t.Errorf("consoleScope out of sync with backend sources: missing %v, stale %v", missing, stale)
	}
}

func TestConsoleScopeHoldsOnlyV2Names(t *testing.T) {
	for _, s := range consoleScope {
		if s == "*" || s == "Metrics" || strings.ContainsAny(s, "/?") {
			t.Errorf("consoleScope contains %q; it must hold only /v2/ endpoint names", s)
		}
	}
}

func TestConsoleScopeRoute(t *testing.T) {
	// The route answers from the constant; a Garage call would hit this closed port.
	c := newNodeTestClient(t, "http://127.0.0.1:1")
	rec := c.do(http.MethodGet, "/api/admin-tokens/console-scope", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}
	var got []string
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v (%s)", err, rec.Body.String())
	}
	if !slices.Equal(got, consoleScope) {
		t.Errorf("got %v, want %v", got, consoleScope)
	}
}
