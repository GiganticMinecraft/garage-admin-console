package main

import (
	"bufio"
	"encoding/json"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
)

// maintenanceMetrics holds the 3 key metrics needed for the repair page.
type maintenanceMetrics struct {
	ResyncQueueLength float64 `json:"resyncQueueLength"`
	ResyncErrored     float64 `json:"resyncErroredBlocks"`
	CorruptionCounter float64 `json:"corruptionCounter"`
}

// handleMaintenanceMetrics fetches Garage's /metrics endpoint and extracts the
// 3 block-related metrics needed for the repair page's signal cards.
func handleMaintenanceMetrics(garageAdmin *GarageAdminClient) http.HandlerFunc {
	// Map from Prometheus metric name prefix to the field setter.
	type target struct {
		prefix string
		set    func(m *maintenanceMetrics, v float64)
	}
	targets := []target{
		{"block_resync_queue_length", func(m *maintenanceMetrics, v float64) { m.ResyncQueueLength = v }},
		{"block_resync_errored_blocks", func(m *maintenanceMetrics, v float64) { m.ResyncErrored = v }},
		{"block_corruption_counter", func(m *maintenanceMetrics, v float64) { m.CorruptionCounter = v }},
	}

	return func(w http.ResponseWriter, r *http.Request) {
		resp, err := garageAdmin.doRequest(r.Context(), http.MethodGet, "/metrics", nil)
		if err != nil {
			slog.ErrorContext(r.Context(), "garage request failed", "path", "/metrics", "error", err)
			http.Error(w, "Bad Gateway", http.StatusBadGateway)
			return
		}
		defer resp.Body.Close()

		if resp.StatusCode != http.StatusOK {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(resp.StatusCode)
			json.NewEncoder(w).Encode(map[string]string{"error": "upstream error"})
			return
		}

		var result maintenanceMetrics
		scanner := bufio.NewScanner(resp.Body)
		for scanner.Scan() {
			line := scanner.Text()
			if len(line) == 0 || line[0] == '#' {
				continue
			}
			for _, t := range targets {
				// Match "metric_name value" or "metric_name{...} value"
				if strings.HasPrefix(line, t.prefix) {
					rest := line[len(t.prefix):]
					if len(rest) == 0 {
						continue
					}
					// Skip label block if present
					if rest[0] == '{' {
						idx := strings.IndexByte(rest, '}')
						if idx < 0 {
							continue
						}
						rest = rest[idx+1:]
					}
					// Expect space then value
					if len(rest) == 0 || rest[0] != ' ' {
						continue
					}
					val, err := strconv.ParseFloat(strings.TrimSpace(rest[1:]), 64)
					if err == nil {
						t.set(&result, val)
					}
				}
			}
		}

		if err := scanner.Err(); err != nil {
			slog.ErrorContext(r.Context(), "failed to read /metrics response", "error", err)
			http.Error(w, "Bad Gateway", http.StatusBadGateway)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(result)
	}
}
