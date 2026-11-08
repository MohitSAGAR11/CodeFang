package main

import (
	"encoding/json"
	"net/http"
)

type shortenRequest struct {
	URL string `json:"url"`
}

type shortenResponse struct {
	Code  string `json:"code"`
	Short string `json:"short"`
}

// ShortenHandler accepts {"url": "..."} and returns a short code.
func ShortenHandler(store *Store, base string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req shortenRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.URL == "" {
			http.Error(w, "body must be {\"url\": \"...\"}", http.StatusBadRequest)
			return
		}

		code := store.Put(req.URL)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		json.NewEncoder(w).Encode(shortenResponse{Code: code, Short: base + "/" + code})
	}
}

// RedirectHandler sends visitors to the stored URL.
func RedirectHandler(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		url, ok := store.Get(r.PathValue("code"))
		if !ok {
			http.NotFound(w, r)
			return
		}
		http.Redirect(w, r, url, http.StatusFound)
	}
}
