package main

import (
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"sync/atomic"
	"testing"
	"time"
)

// trackingListener records whether Close was called, so tests can check that
// shutdown stops accepting without re-dialing a port another test may reuse.
type trackingListener struct {
	net.Listener
	closed atomic.Bool
}

func (l *trackingListener) Close() error {
	l.closed.Store(true)
	return l.Listener.Close()
}

// startServe runs serve on a loopback listener and returns the listener and a
// channel that receives serve's result.
func startServe(t *testing.T, ctx context.Context, h http.Handler, drain time.Duration) (*trackingListener, <-chan error) {
	t.Helper()
	inner, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	ln := &trackingListener{Listener: inner}
	done := make(chan error, 1)
	go func() { done <- serve(ctx, &http.Server{Handler: h}, ln, drain) }()
	return ln, done
}

func TestServeIdleShutdown(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	_, done := startServe(t, ctx, http.NotFoundHandler(), time.Second)
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("serve returned %v, want nil", err)
		}
	case <-time.After(time.Second):
		t.Fatal("serve did not return after cancel")
	}
}

func TestServeDrainsInFlightRequest(t *testing.T) {
	started := make(chan struct{})
	h := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		close(started)
		time.Sleep(300 * time.Millisecond)
		io.WriteString(w, "done")
	})
	ctx, cancel := context.WithCancel(context.Background())
	ln, done := startServe(t, ctx, h, 5*time.Second)
	addr := ln.Addr().String()

	type result struct {
		body string
		err  error
	}
	resCh := make(chan result, 1)
	go func() {
		resp, err := http.Get("http://" + addr + "/")
		if err != nil {
			resCh <- result{err: err}
			return
		}
		defer resp.Body.Close()
		b, err := io.ReadAll(resp.Body)
		resCh <- result{string(b), err}
	}()

	<-started
	cancel()

	res := <-resCh
	if res.err != nil || res.body != "done" {
		t.Fatalf("in-flight request: body=%q err=%v, want body=done", res.body, res.err)
	}
	if err := <-done; err != nil {
		t.Fatalf("serve returned %v, want nil", err)
	}
	if !ln.closed.Load() {
		t.Fatal("listener still open after shutdown")
	}
}

func TestServeDrainTimeoutClosesConnections(t *testing.T) {
	started := make(chan struct{})
	release := make(chan struct{})
	defer close(release)
	var returned atomic.Bool
	h := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		close(started)
		select {
		case <-r.Context().Done():
		case <-release:
		}
		// Simulate cleanup (span end, access log) after the connection drops.
		time.Sleep(50 * time.Millisecond)
		returned.Store(true)
	})
	ctx, cancel := context.WithCancel(context.Background())
	ln, done := startServe(t, ctx, h, 100*time.Millisecond)
	addr := ln.Addr().String()

	clientErr := make(chan error, 1)
	go func() {
		resp, err := http.Get("http://" + addr + "/")
		if err == nil {
			resp.Body.Close()
		}
		clientErr <- err
	}()

	<-started
	start := time.Now()
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("serve returned %v, want nil", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("serve did not return after drain timeout")
	}
	if elapsed := time.Since(start); elapsed > time.Second {
		t.Fatalf("serve took %v, want about the 100ms drain timeout", elapsed)
	}
	if !returned.Load() {
		t.Fatal("serve returned before the cut-off handler finished")
	}
	if err := <-clientErr; err == nil {
		t.Fatal("client request succeeded, want connection closed")
	}
}

func TestServeReturnsListenerError(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	ln.Close()
	err = serve(context.Background(), &http.Server{Handler: http.NotFoundHandler()}, ln, time.Second)
	if err == nil || errors.Is(err, http.ErrServerClosed) {
		t.Fatalf("serve returned %v, want listener error", err)
	}
}
