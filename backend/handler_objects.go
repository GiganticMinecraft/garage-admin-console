package main

import (
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"path"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/go-chi/chi/v5"
)

// objectEntry represents a single object in the list response.
type objectEntry struct {
	Key          string    `json:"key"`
	Size         int64     `json:"size"`
	LastModified time.Time `json:"lastModified"`
}

// handleListObjects handles GET /api/objects/{bucket}/list?prefix=&delimiter=.
// It calls S3 ListObjectsV2 and returns a JSON array of objects.
func handleListObjects(s3Client *S3Client) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		bucket := chi.URLParam(r, "bucket")
		prefix := r.URL.Query().Get("prefix")
		delimiter := r.URL.Query().Get("delimiter")

		input := &s3.ListObjectsV2Input{
			Bucket: aws.String(bucket),
		}
		if prefix != "" {
			input.Prefix = aws.String(prefix)
		}
		if delimiter != "" {
			input.Delimiter = aws.String(delimiter)
		}

		var objects []objectEntry

		paginator := s3.NewListObjectsV2Paginator(s3Client.client, input)
		for paginator.HasMorePages() {
			page, err := paginator.NextPage(r.Context())
			if err != nil {
				slog.Error("s3 ListObjectsV2 failed", "bucket", bucket, "error", err)
				http.Error(w, fmt.Sprintf(`{"error":"failed to list objects: %s"}`, err.Error()), http.StatusBadGateway)
				return
			}
			for _, obj := range page.Contents {
				entry := objectEntry{
					Key:  aws.ToString(obj.Key),
					Size: aws.ToInt64(obj.Size),
				}
				if obj.LastModified != nil {
					entry.LastModified = *obj.LastModified
				}
				objects = append(objects, entry)
			}
		}

		if objects == nil {
			objects = []objectEntry{}
		}

		w.Header().Set("Content-Type", "application/json")
		if err := json.NewEncoder(w).Encode(objects); err != nil {
			slog.Error("failed to encode object list", "error", err)
		}
	}
}

// handleDownloadObject handles GET /api/objects/{bucket}/download?key=.
// It calls S3 GetObject and streams the response with Content-Disposition: attachment.
func handleDownloadObject(s3Client *S3Client) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		bucket := chi.URLParam(r, "bucket")
		key := r.URL.Query().Get("key")
		if key == "" {
			http.Error(w, `{"error":"key parameter is required"}`, http.StatusBadRequest)
			return
		}

		output, err := s3Client.client.GetObject(r.Context(), &s3.GetObjectInput{
			Bucket: aws.String(bucket),
			Key:    aws.String(key),
		})
		if err != nil {
			slog.Error("s3 GetObject failed", "bucket", bucket, "key", key, "error", err)
			http.Error(w, fmt.Sprintf(`{"error":"failed to get object: %s"}`, err.Error()), http.StatusBadGateway)
			return
		}
		defer output.Body.Close()

		filename := path.Base(key)
		w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s"`, filename))
		if output.ContentType != nil {
			w.Header().Set("Content-Type", *output.ContentType)
		} else {
			w.Header().Set("Content-Type", "application/octet-stream")
		}
		if output.ContentLength != nil {
			w.Header().Set("Content-Length", fmt.Sprintf("%d", *output.ContentLength))
		}

		if _, err := io.Copy(w, output.Body); err != nil {
			slog.Error("failed to stream object", "bucket", bucket, "key", key, "error", err)
		}
	}
}

// handleUploadObject handles POST /api/objects/{bucket}/upload.
// It parses a multipart form and uploads the "file" field to S3 via PutObject.
func handleUploadObject(s3Client *S3Client) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		bucket := chi.URLParam(r, "bucket")

		// 32 MB max memory for multipart form.
		if err := r.ParseMultipartForm(32 << 20); err != nil {
			slog.Error("failed to parse multipart form", "error", err)
			http.Error(w, `{"error":"failed to parse multipart form"}`, http.StatusBadRequest)
			return
		}

		file, header, err := r.FormFile("file")
		if err != nil {
			slog.Error("failed to get file from form", "error", err)
			http.Error(w, `{"error":"file field is required"}`, http.StatusBadRequest)
			return
		}
		defer file.Close()

		// Use the "key" form value if provided, otherwise use the filename.
		key := r.FormValue("key")
		if key == "" {
			key = header.Filename
		}

		_, err = s3Client.client.PutObject(r.Context(), &s3.PutObjectInput{
			Bucket:        aws.String(bucket),
			Key:           aws.String(key),
			Body:          file,
			ContentLength: aws.Int64(header.Size),
		})
		if err != nil {
			slog.Error("s3 PutObject failed", "bucket", bucket, "key", key, "error", err)
			http.Error(w, fmt.Sprintf(`{"error":"failed to upload object: %s"}`, err.Error()), http.StatusBadGateway)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		json.NewEncoder(w).Encode(map[string]string{
			"bucket": bucket,
			"key":    key,
		})
	}
}

// handleDeleteObject handles DELETE /api/objects/{bucket}?key=.
// It calls S3 DeleteObject and returns 204 No Content on success.
func handleDeleteObject(s3Client *S3Client) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		bucket := chi.URLParam(r, "bucket")
		key := r.URL.Query().Get("key")
		if key == "" {
			http.Error(w, `{"error":"key parameter is required"}`, http.StatusBadRequest)
			return
		}

		_, err := s3Client.client.DeleteObject(r.Context(), &s3.DeleteObjectInput{
			Bucket: aws.String(bucket),
			Key:    aws.String(key),
		})
		if err != nil {
			slog.Error("s3 DeleteObject failed", "bucket", bucket, "key", key, "error", err)
			http.Error(w, fmt.Sprintf(`{"error":"failed to delete object: %s"}`, err.Error()), http.StatusBadGateway)
			return
		}

		w.WriteHeader(http.StatusNoContent)
	}
}
